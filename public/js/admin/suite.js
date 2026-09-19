// THE ADMINISTRATIVE SUITE'S BROWSER SIDE (docs/PLAN-ADMIN-SUITE.md).
//
// Loaded by an import() that only runs when /api/admin/status says the suite is on, the
// same way the Diversions load. On a read-only build this file is not on the server at all
// (package.json excludes public/js/admin/), and on a build that has it with the gate shut
// the server 404s it — so there are two independent reasons a monitor that is not running
// the suite never executes a line of this.
//
// It also injects its own nav button and page section rather than having them sit in
// index.html. That keeps the read-only build's markup free of a Wallet tab that would only
// ever 404, and it means the DOM the suite needs cannot drift away from the code that uses
// it — there is one place that writes both.
//
// No framework, no build step, no dependency: the same rule as the rest of this codebase,
// and here it is a security control rather than a preference. Every byte of this is
// readable in the browser's view-source, and CSP forbids anything that is not.

import { SCREENS, BALANCES, TX_COLUMNS, txType, txStatus, txGlyph, confirmationLines } from './corelayout.js';
import { encodeQr, paymentUri, drawQr } from './qr.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  // textContent everywhere, never innerHTML: a wallet label and a node error both end up
  // on this page, and neither is trusted markup.
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};

const sats = (n) => (n == null ? '—' : `${Number(n).toLocaleString()} sat`);
const btc = (n) => (n == null ? '—' : `${(n / 1e8).toFixed(8)} BTC`);

export async function initAdminSuite({ api, toast, state }) {
  let status = null;
  try { status = await api('/api/admin/status'); } catch { return null; }
  if (!status?.enabled) return null;

  // ------------------------------------------------------------------ the shell
  // The suite's stylesheet, linked rather than injected as a <style>: `style-src 'self'`
  // carries no 'unsafe-inline' and is not going to (server/http/static.js), so an inline
  // style block would simply be refused by the browser. Linked here rather than in
  // index.html for the same reason the nav button is built here -- a read-only build has
  // neither the file nor a reason to ask for it.
  if (!$('link[data-admin-css]')) {
    document.head.append(el('link', { rel: 'stylesheet', href: '/css/admin.css', 'data-admin-css': '1' }));
  }

  const nav = $('nav.pages');
  const main = $('.page')?.parentElement ?? document.body;
  const page = el('section', { class: 'page', 'data-page': 'wallet' });
  main.append(page);
  const btn = el('button', { 'data-page': 'wallet', id: 'navWallet', text: 'Wallet' });
  nav?.append(btn);

  const ui = {
    // Core's four screens rather than one long page: Overview / Send / Receive /
    // Transactions, in Core's order (public/js/admin/corelayout.js).
    screen: 'overview',
    status,
    elevation: status.elevation ?? { elevated: false, leftMs: 0 },
    wallet: status.wallets?.[0] ?? null,
    build: null,
  };

  // ------------------------------------------------------------- elevation prompt
  // The password is read from an input, sent, and the input is cleared. It is never put
  // in a variable that outlives the call, never in state, never in the URL.
  async function elevate(why) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'your account password' });
      const err = el('div', { class: 'warn' });
      const close = () => { input.value = ''; dialog.remove(); };
      const submit = async () => {
        try {
          const out = await api('/api/admin/elevate', { method: 'POST', body: { password: input.value } });
          input.value = '';
          ui.elevation = { elevated: true, leftMs: out.leftMs };
          close();
          resolve(true);
        } catch (e) {
          input.value = '';
          err.replaceChildren(
            el('div', { text: e.message }),
            // The most likely mistake, named rather than left to be worked out.
            el('div', { class: 'sub', text: 'If you typed the wallet passphrase: this prompt wants your BlockYard account password instead.' }),
          );
        }
      };
      // TWO DIFFERENT SECRETS, AND THIS IS THE FIRST ONE. The wording matters more than it
      // looks: the first version of this dialog said "Your password, please" over an
      // "Unlock" button, which reads as a wallet unlock -- and the operator duly typed the
      // WALLET passphrase into it three times (2026-09-18, admin-elevate-failed x3).
      // Teaching someone to offer their wallet passphrase to whatever prompt appears is
      // the opposite of what this whole mechanism is for, so the dialog now says which
      // secret it wants, and says it again when the answer is wrong.
      const dialog = el('div', { class: 'modal' },
        el('div', { class: 'modalbox' },
          el('h3', { text: 'Confirm it is you' }),
          el('p', { text: why ?? 'This changes something, so the session alone does not authorise it.' }),
          el('p', { class: 'sub', text: 'Type your BlockYard sign-in password — the one you logged in with. This is NOT the wallet passphrase; that is asked for separately, on the send screen, and only when a transaction is actually being signed.' }),
          input, err,
          el('div', { class: 'row' },
            el('button', { class: 'primary', text: 'Confirm', onclick: submit }),
            el('button', { text: 'Cancel', onclick: () => { close(); resolve(false); } })),
        ));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      document.body.append(dialog);
      input.focus();
    });
  }

  /** Run something, and if it comes back needing a password, ask once and retry. */
  async function withElevation(why, fn) {
    try { return await fn(); } catch (e) {
      if (e?.payload?.error?.code !== 'elevation-required') throw e;
      if (!await elevate(why)) return null;
      return fn();
    }
  }

  // ------------------------------------------------------------------- the panels
  function walletPicker() {
    const sel = el('select', { onchange: (e) => { ui.wallet = e.target.value; render(); } });
    for (const w of ui.status.wallets ?? []) {
      const opt = el('option', { value: w, text: w });
      if (w === ui.wallet) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  }

  // Core's overviewpage.ui: a Balances box of four labelled rows, then Recent transactions.
  async function overviewPanel() {
    const box = el('div', { class: 'card' }, el('h3', { text: 'Balances' }));
    if (!ui.wallet) {
      box.append(el('p', { text: 'No wallet is named in admin.wallets, so none is reachable from here.' }));
      return box;
    }
    try {
      const w = await api(`/api/admin/wallet?wallet=${encodeURIComponent(ui.wallet)}`);
      const dl = el('dl', { class: 'balances' });
      for (const b of BALANCES) {
        dl.append(
          el('dt', { title: b.hint, text: b.label }),
          el('dd', { class: b.strong ? 'big' : '', title: sats(w.balances[b.key]), text: btc(w.balances[b.key]) }),
        );
      }
      box.append(
        dl,
        el('div', { class: 'sub', text: `${w.wallet} on ${w.node}` }),
        w.canSpend ? null : el('p', { class: 'warn', text: 'This is a watch-only wallet: it holds no keys and cannot send.' }),
        w.encrypted ? el('p', { class: 'sub', text: 'Encrypted: sending asks for the wallet passphrase as well as your account password.' }) : null,
        w.scanning ? el('p', { class: 'warn', text: 'The wallet is rescanning, so these figures are provisional.' }) : null,
      );
    } catch (e) {
      box.append(el('p', { class: 'warn', text: e.message }));
    }
    return box;
  }

  /**
   * Core's ReceiveRequestDialog, reopened: the QR, the address, the label, and the URI a
   * scanner actually reads. Core lets you double-click a row in its request history to get
   * this back; the operator reasonably expected the same here (2026-09-18).
   *
   * One dialog, used from three places -- the address just derived, a row of the session's
   * history, and an address under a label -- so there is one thing to keep right.
   */
  function receiveDialog({ address, label = '' }) {
    const uri = paymentUri(address, { label });
    const canvas = el('canvas', { class: 'qr', title: uri });
    try { drawQr(canvas, encodeQr(uri), { scale: 6, quiet: 4 }); }
    catch (err) { canvas.remove(); toast(`could not draw the QR: ${err.message}`); }

    const copy = (text, what) => async () => {
      try { await navigator.clipboard.writeText(text); toast(`${what} copied`); }
      catch { toast(`could not copy — select the ${what} and copy it manually`); }
    };

    const dialog = el('div', { class: 'modal' },
      el('div', { class: 'modalbox' },
        el('h3', { text: 'Receiving address' }),
        label ? el('div', { class: 'sub', text: `Label: ${label}` }) : el('div', { class: 'sub', text: 'no label' }),
        canvas,
        el('code', { class: 'addr big-addr', text: address }),
        // The URI is what the QR holds; showing it makes the QR checkable by eye rather
        // than a black box you have to trust.
        el('div', { class: 'sub', text: 'the QR contains:' }),
        el('code', { class: 'addr', text: uri }),
        el('div', { class: 'row' },
          el('button', { text: 'Copy address', onclick: copy(address, 'address') }),
          el('button', { text: 'Copy URI', onclick: copy(uri, 'URI') }),
          el('button', { class: 'primary', text: 'Send to this address', onclick: () => {
            ui.prefillTo = address;
            ui.screen = 'send';
            dialog.remove();
            render();
          } }),
          el('button', { text: 'Close', onclick: () => dialog.remove() })),
      ));
    document.body.append(dialog);
    return dialog;
  }

  // Core's receivecoinsdialog.ui: Amount / Label / Message over "Create new receiving
  // address", and a "Requested payments history" of what you made earlier. The fields that
  // only make sense in a payment REQUEST (amount, message) are not here -- this suite has
  // no BIP21 request flow yet, and an amount box that changes nothing would be a lie -- but
  // the shape and the history are Core's.
  //
  // WHAT WAS MISSING (operator, 2026-09-18: "didn't place the receive address in the
  // proper destination"): a derived address that you cannot get anywhere is half a
  // feature. It now comes with a copy button and a "Send to this address" that fills the
  // Send screen's destination and takes you there -- which on a test network is the whole
  // loop, and on a real one is how you pay yourself between wallets.
  async function receivePanel() {
    const label = el('input', { type: 'text', placeholder: 'Label (what is this address for?)' });
    const out = el('div');

    const show = (res) => {
      const addr = el('code', { class: 'addr big-addr', text: res.address });
      // Core's ReceiveRequestDialog draws a QR of the BIP21 URI rather than the bare
      // address, so a scan carries the label with it. Drawn on a canvas by this codebase's
      // own encoder (public/js/admin/qr.js) -- there is no library and no CDN here.
      const uri = paymentUri(res.address, { label: res.label });
      const canvas = el('canvas', { class: 'qr', title: uri });
      try { drawQr(canvas, encodeQr(uri), { scale: 5, quiet: 4 }); }
      catch (err) { canvas.remove(); toast(`could not draw the QR: ${err.message}`); }
      out.replaceChildren(
        el('div', { class: 'sub', text: res.label ? `Label: ${res.label}` : 'no label' }),
        canvas,
        addr,
        el('div', { class: 'row' },
          el('button', { text: 'Copy address', onclick: async () => {
            try { await navigator.clipboard.writeText(res.address); toast('address copied'); }
            // Clipboard access needs a secure context and permission; when it is refused
            // the address is still on screen, so say what happened rather than nothing.
            catch { toast('could not copy — select the address and copy it manually'); }
          } }),
          el('button', { class: 'primary', text: 'Send to this address', onclick: () => {
            ui.prefillTo = res.address;
            ui.screen = 'send';
            render();
          } }),
          el('button', { text: 'Show QR larger', onclick: () => receiveDialog(res) })),
      );
    };

    const make = () => withElevation('Deriving an address writes to the wallet.', async () => {
      const res = await api('/api/admin/wallet/address', { method: 'POST', body: { wallet: ui.wallet, label: label.value } });
      ui.received = [{ address: res.address, label: res.label }, ...(ui.received ?? [])].slice(0, 10);
      label.value = '';
      show(res);
      toast('address derived');
    });

    const card = el('div', { class: 'card' },
      el('h3', { text: 'Receive' }),
      label,
      el('button', { class: 'primary', text: 'Create new receiving address', onclick: make }),
      out);

    // Core's "Requested payments history", as much of it as this suite has: the addresses
    // derived in this session, newest first, each reusable without deriving another.
    if (ui.received?.length) {
      const table = el('table', { class: 't' },
        el('thead', {}, el('tr', {}, el('th', { text: 'Label' }), el('th', { text: 'Address' }), el('th', { text: '' }))));
      const body = el('tbody');
      for (const r of ui.received) {
        const row = el('tr', { class: 'clickable', tabindex: '0', title: 'show the QR and the address' },
          el('td', { text: r.label ?? '' }),
          el('td', {}, el('code', { class: 'addr', text: r.address })),
          el('td', {}, el('button', { class: 'linky', text: 'Send to this', onclick: () => {
            ui.prefillTo = r.address;
            ui.screen = 'send';
            render();
          } })));
        // Click or double-click; the button inside keeps doing its own job.
        const open = (e) => { if (!e.target?.closest?.('button')) receiveDialog(r); };
        row.addEventListener('click', open);
        row.addEventListener('dblclick', open);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
        body.append(row);
      }
      table.append(body);
      card.append(el('h4', { text: 'Requested payments history' }), table);
    }
    return card;
  }

  /**
   * Core's "Choose previously used address" (sendcoinsentry.ui), which opens its address
   * book to pick a recipient. Two groups here, because this suite has two sources and they
   * mean different things:
   *
   *   Address book   destinations the operator named in config. Sending to one needs no
   *                  typed confirmation phrase -- that is what being in the book buys.
   *   Previously used  every distinct address this wallet has sent to before, gathered
   *                  from its own history. NOT in the book, so it still asks for the
   *                  phrase; it is a convenience for typing, not a statement of trust.
   *
   * The distinction is on the screen rather than implied, because "I have paid this before"
   * and "I have vouched for this" are different claims and only one of them skips a guard.
   */
  async function choosePayee(onPick) {
    const list = el('div', { class: 'payees' }, el('div', { class: 'sub', text: 'loading…' }));
    const search = el('input', { type: 'text', placeholder: 'Enter address or label to search', autocomplete: 'off' });
    const dialog = el('div', { class: 'modal' },
      el('div', { class: 'modalbox wide' },
        el('h3', { text: 'Choose an address' }),
        search,
        list,
        el('div', { class: 'row' }, el('button', { text: 'Close', onclick: () => dialog.remove() }))));
    document.body.append(dialog);

    const [book, history] = await Promise.all([
      api('/api/admin/addressbook').catch(() => ({ entries: [] })),
      api(`/api/admin/wallet/history?wallet=${encodeURIComponent(ui.wallet)}&count=200`).catch(() => ({ transactions: [] })),
    ]);
    // Distinct destinations, most recent first, and never one of our own receive addresses.
    const seen = new Set((book.entries ?? []).map((e) => e.address));
    const used = [];
    for (const t of history.transactions ?? []) {
      if (t.category !== 'send' || !t.address || seen.has(t.address)) continue;
      seen.add(t.address);
      used.push({ address: t.address, label: t.label ?? '', when: t.time });
    }

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const hit = (e) => !q || e.address.toLowerCase().includes(q) || (e.label ?? '').toLowerCase().includes(q);
      const rows = [];
      const section = (title, entries, note) => {
        if (!entries.length) return;
        rows.push(el('h4', { text: title }), el('div', { class: 'sub', text: note }));
        for (const e of entries) {
          const row = el('div', {
            class: 'payee clickable', tabindex: '0', role: 'button',
            title: 'use this address',
          },
          el('b', { text: e.label || '(no label)' }),
          el('code', { class: 'addr', text: e.address }));
          const pick = () => { onPick(e.address); dialog.remove(); };
          row.addEventListener('click', pick);
          row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault?.(); pick(); } });
          rows.push(row);
        }
      };
      section('Address book', (book.entries ?? []).filter(hit), 'no confirmation phrase needed');
      section('Previously used', used.filter(hit), 'still asks for the confirmation phrase');
      if (!rows.length) {
        rows.push(el('p', { class: 'sub', text: q ? 'nothing matches' : 'no address book entries, and this wallet has not sent to anyone yet' }));
      }
      list.replaceChildren(...rows);
    };
    search.addEventListener('input', draw);
    draw();
    search.focus();
  }

  // ------------------------------------------------------------------------ send
  // Two screens, because the second one shows what the NODE built rather than what was
  // typed. See server/admin/send.js.
  async function sendPanel() {
    const address = el('input', { type: 'text', placeholder: 'Pay To (destination address)', autocomplete: 'off' });
    // Filled by "Send to this address" on the Receive screen, or by an address book row.
    // Consumed once: leaving it set would quietly re-fill the field after a send.
    if (ui.prefillTo) { address.value = ui.prefillTo; ui.prefillTo = null; }
    const amount = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'amount in satoshis' });
    const out = el('div');

    const build = () => withElevation('Building a transaction reads the wallet’s coins.', async () => {
      const res = await api('/api/admin/wallet/send/build', {
        method: 'POST',
        body: { wallet: ui.wallet, address: address.value.trim(), amountSat: amount.value.trim() },
      });
      ui.build = res.build;
      out.replaceChildren(confirmScreen(res.build, out));
    }).catch((e) => out.replaceChildren(el('p', { class: 'warn', text: e.message })));

    return el('div', { class: 'card' },
      el('h3', { text: 'Send' }),
      el('div', { class: 'payto' },
        address,
        // Core's sendcoinsentry.ui puts this immediately beside the field, which is where
        // a person looks when they are about to paste something they got in an email.
        el('button', { text: 'Choose…', title: 'Choose previously used address', onclick: () => choosePayee((a) => { address.value = a; address.focus(); }) })),
      amount,
      el('button', { class: 'primary', text: 'Review', onclick: build }),
      el('p', { class: 'sub', text: 'Nothing is signed until you confirm the transaction the node builds.' }),
      out);
  }

  function confirmScreen(b, out) {
    const phrase = b.phrase ? el('input', { type: 'text', placeholder: `type: ${b.phrase}`, autocomplete: 'off' }) : null;
    const pass = el('input', { type: 'password', placeholder: 'WALLET passphrase (the one that encrypts the wallet)', autocomplete: 'off' });
    const err = el('div', { class: 'warn' });

    const send = async () => {
      try {
        const res = await api('/api/admin/wallet/send/confirm', {
          method: 'POST',
          body: { wallet: b.wallet, id: b.id, phrase: phrase?.value ?? null, passphrase: pass.value },
        });
        pass.value = '';
        out.replaceChildren(
          el('h4', { text: 'Sent' }),
          el('code', { class: 'addr', text: res.txid }),
          el('div', { class: 'sub', text: `${sats(res.sendingSat)} to ${res.to}, fee ${sats(res.feeSat)}` }),
        );
        toast('transaction broadcast');
      } catch (e) {
        pass.value = '';
        err.textContent = e.message;
        // An expired or spent build cannot be retried: make that unmistakable rather than
        // leaving a Send button that will keep failing.
        if (['no-such-build', 'build-not-yours'].includes(e?.payload?.error?.code)) {
          out.replaceChildren(el('p', { class: 'warn', text: `${e.message} — build it again.` }));
        }
      }
    };

    // EVERY FIGURE COMES FROM THE BUILT TRANSACTION, laid out as Core lays out its own
    // confirmation (sendcoinsdialog.cpp, via corelayout.js): review line, recipient,
    // amount, the fee with its size in kvB, the note about raising it later, total last.
    const lines = confirmationLines(b, { fmt: btc });
    const dl = el('dl', {});
    for (const l of lines) {
      if (l.kind === 'lead' || l.kind === 'note' || l.kind === 'recipient') continue;
      dl.append(
        el('dt', { text: l.note ? `${l.label} (${l.note})` : l.label }),
        el('dd', { class: l.kind === 'total' ? 'big' : (l.kind === 'fee' ? 'fee' : ''), text: l.value ?? '' }),
      );
    }
    const lead = lines.find((l) => l.kind === 'lead');
    const note = lines.find((l) => l.kind === 'note');

    return el('div', { class: 'confirm' },
      el('h4', { text: 'Confirm send coins' }),
      el('p', { text: lead.text }),
      el('div', { class: 'sub', text: 'Pay To' }),
      el('div', {}, el('code', { class: 'addr', text: b.to })),
      dl,
      note ? el('p', { class: 'sub', text: note.text }) : null,
      el('p', { class: 'sub', text: `${b.inputs} input(s) \u00b7 ${b.vsize ?? '\u2014'} vB \u00b7 ${b.feeRateSatPerVb ?? '\u2014'} sat/vB \u00b7 change ${btc(b.changeSat)} \u00b7 ${b.chain}` }),
      b.addressBook
        ? el('p', { class: 'sub', text: 'This destination is in your address book.' })
        : el('p', { class: 'warn', text: 'This destination is NOT in your address book. Check the address above against the one you were given, character by character.' }),
      phrase, pass, err,
      el('button', { class: 'danger', text: `Send ${sats(b.totalSat)}`, onclick: send }));
  }

  /**
   * One transaction, opened from the history list.
   *
   * Bound to click AND dblclick: the operator reached for a double-click (2026-09-18), a
   * single click is what a row in a web page usually wants, and binding both costs nothing
   * -- the second event on a dialog that is already open is a no-op.
   */
  async function txDetail(txid) {
    const body = el('div', { text: 'loading…' });
    const dialog = el('div', { class: 'modal' },
      el('div', { class: 'modalbox wide' },
        el('h3', { text: 'Transaction' }),
        el('code', { class: 'addr', text: txid }),
        body,
        el('div', { class: 'row' }, el('button', { text: 'Close', onclick: () => dialog.remove() }))));
    document.body.append(dialog);

    try {
      const t = await api(`/api/admin/wallet/tx?wallet=${encodeURIComponent(ui.wallet)}&txid=${encodeURIComponent(txid)}`);
      const rows = el('dl', {},
        el('dt', { text: 'amount' }), el('dd', { class: t.amountSat < 0 ? 'neg' : 'pos', text: `${sats(t.amountSat)} (${btc(t.amountSat)})` }),
        el('dt', { text: 'fee' }), el('dd', { text: t.feeSat == null ? '—' : `${sats(t.feeSat)}${t.feeRateSatPerVb ? ` · ${t.feeRateSatPerVb} sat/vB` : ''}` }),
        el('dt', { text: 'status' }), el('dd', {
          class: t.confirmations === 0 ? 'warn' : '',
          text: t.confirmations === 0
            ? `unconfirmed · ${t.replaceable === 'yes' ? 'replaceable, so the fee can be raised' : 'not replaceable'}`
            : `${t.confirmations} confirmation(s)${t.blockHeight ? ` · block ${t.blockHeight}` : ''}`,
        }),
        el('dt', { text: 'seen' }), el('dd', { text: fmtTime(t.time) }),
        el('dt', { text: 'size' }), el('dd', { text: t.vsize ? `${t.vsize} vB · ${t.weight} WU` : '—' }));

      const outs = el('table', { class: 't' },
        el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'address' }), el('th', { text: 'amount' }), el('th', { text: '' }))));
      const outBody = el('tbody');
      for (const o of t.outputs ?? []) {
        outBody.append(el('tr', {},
          el('td', { text: String(o.n) }),
          el('td', {}, el('code', { class: 'addr', text: o.address ?? o.type ?? '—' })),
          el('td', { text: sats(o.amountSat) }),
          // The whole point of the view: which outputs came back to you. Without this a
          // 1 BTC payment out of a 50 BTC coin reads as a 50 BTC transaction.
          el('td', { class: o.mine ? 'pos' : 'sub', text: o.mine ? 'yours (change)' : 'not yours' })));
      }
      outs.append(outBody);

      const ins = el('table', { class: 't' },
        el('thead', {}, el('tr', {}, el('th', { text: 'spends' }), el('th', { text: 'sequence' }))));
      const inBody = el('tbody');
      for (const i of t.inputs ?? []) {
        inBody.append(el('tr', {},
          el('td', {}, el('code', { class: 'addr', title: `${i.txid}:${i.vout}`, text: i.coinbase ? 'coinbase (newly mined)' : `${shortId(i.txid)}:${i.vout}` })),
          el('td', { text: i.sequence == null ? '—' : String(i.sequence) })));
      }
      ins.append(inBody);

      const hex = el('textarea', { class: 'rawtx', readonly: 'readonly', rows: '4' });
      hex.value = t.hex ?? '';

      body.replaceChildren(
        rows,
        el('h4', { text: 'Outputs' }), outs,
        el('h4', { text: 'Inputs' }), ins,
        el('h4', { text: 'Raw' }),
        el('p', { class: 'sub', text: 'public data: this transaction is in a block or a mempool already' }),
        hex,
        el('button', { text: 'Copy raw', onclick: () => { hex.select(); navigator.clipboard?.writeText(hex.value).then(() => toast('copied')); } }),
      );
    } catch (e) {
      body.replaceChildren(el('p', { class: 'warn', text: e.message }));
    }
  }

  // ------------------------------------------------------------------- history
  // Added 2026-09-18, after the operator asked where their transaction history was: the
  // route had existed since M2 and nothing in the browser called it. A panel that is not
  // rendered is a feature that does not exist, whatever the API can answer.
  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
  const shortId = (id) => (id ? `${id.slice(0, 8)}…${id.slice(-6)}` : '—');

  async function historyPanel({ recent = false } = {}) {
    // transactiontablemodel.cpp: a status column with no title, then Date, Type, Label,
    // Amount -- Core's order, and Core's own status wording (corelayout.js).
    const box = el('div', { class: 'card' }, el('h3', { text: recent ? 'Recent transactions' : 'Transactions' }));
    if (!ui.wallet) return box;
    try {
      const res = await api(`/api/admin/wallet/history?wallet=${encodeURIComponent(ui.wallet)}`);
      const all = res.transactions ?? [];
      const rows = recent ? all.slice(0, 5) : all;
      if (!rows.length) {
        box.append(el('p', { class: 'sub', text: 'nothing yet' }));
        return box;
      }
      const table = el('table', { class: 't tx' },
        el('thead', {}, el('tr', {}, ...TX_COLUMNS.map((c) => el('th', { class: c ? '' : 'statuscol', text: c })))));
      const body = el('tbody');
      for (const t of rows) {
        const st = txStatus(t);
        const bump = t.confirmations === 0 && t.bip125Replaceable === 'yes' && t.category === 'send'
          ? el('button', { class: 'linky', text: 'Bump fee', onclick: () => bumpDialog(t) })
          : null;
        const row = el('tr', { class: 'clickable', tabindex: '0', title: st.text },
          el('td', { class: `statuscol ${st.tone}`, text: txGlyph(t) }),
          el('td', { text: fmtTime(t.time) }),
          el('td', {}, el('div', { text: txType(t) }), el('code', { class: 'addr', text: t.address ?? '' })),
          el('td', { text: t.label ?? '' }),
          el('td', { class: t.amountSat < 0 ? 'amount neg' : 'amount pos' }, el('div', { text: btc(t.amountSat) }), bump),
        );
        const open = (e) => { if (!e.target?.closest?.('button')) txDetail(t.txid); };
        row.addEventListener('click', open);
        row.addEventListener('dblclick', open);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
        body.append(row);
      }
      table.append(body);
      box.append(table);
      if (recent && all.length > rows.length) {
        box.append(el('button', { class: 'linky', text: `all ${all.length} transactions \u2192`, onclick: () => { ui.screen = 'transactions'; render(); } }));
      }
    } catch (e) {
      box.append(el('p', { class: 'warn', text: e.message }));
    }
    return box;
  }

  /** Raise the fee on an unconfirmed send: price it first, then one password, one send. */
  function bumpDialog(tx) {
    const rate = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'new fee rate, sat/vB' });
    const pass = el('input', { type: 'password', placeholder: 'wallet passphrase', autocomplete: 'off' });
    const out = el('div');
    const dialog = el('div', { class: 'modal' },
      el('div', { class: 'modalbox' },
        el('h3', { text: 'Raise the fee' }),
        el('div', { class: 'sub' }, el('code', { class: 'addr', text: tx.txid })),
        rate,
        el('div', { class: 'row' },
          el('button', { text: 'Price it', onclick: async () => {
            try {
              const res = await withElevation('Pricing a replacement reads the wallet.', () => api('/api/admin/tx/bump', {
                method: 'POST', body: { wallet: ui.wallet, txid: tx.txid, feeRate: rate.value.trim() },
              }));
              if (!res) return;
              out.replaceChildren(
                el('dl', {},
                  el('dt', { text: 'fee now' }), el('dd', { text: sats(res.oldFeeSat) }),
                  el('dt', { text: 'fee after' }), el('dd', { text: sats(res.newFeeSat) }),
                  el('dt', { text: 'extra' }), el('dd', { text: sats(res.deltaSat) })),
                el('p', { class: 'sub', text: res.note }),
                pass,
                el('button', { class: 'danger', text: 'Replace it', onclick: async () => {
                  try {
                    const done = await api('/api/admin/tx/bump/confirm', {
                      method: 'POST',
                      body: { wallet: ui.wallet, txid: tx.txid, feeRate: rate.value.trim(), passphrase: pass.value },
                    });
                    pass.value = '';
                    dialog.remove();
                    toast(`replaced: ${done.txid.slice(0, 12)}…`);
                    render();
                  } catch (err) { pass.value = ''; out.append(el('p', { class: 'warn', text: err.message })); }
                } }));
            } catch (err) { out.replaceChildren(el('p', { class: 'warn', text: err.message })); }
          } }),
          el('button', { text: 'Close', onclick: () => dialog.remove() })),
        out));
    document.body.append(dialog);
    rate.focus();
  }

  // --------------------------------------------------------------------- coins
  async function utxoPanel() {
    const box = el('div', { class: 'card' }, el('h3', { text: 'Coins' }));
    if (!ui.wallet) return box;
    try {
      const res = await api(`/api/admin/wallet/utxos?wallet=${encodeURIComponent(ui.wallet)}`);
      const rows = res.utxos ?? [];
      box.append(el('div', { class: 'sub', text: `${rows.length} output(s), ${sats(rows.reduce((n, u) => n + u.amountSat, 0))} in total` }));
      const table = el('table', { class: 't' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'amount' }), el('th', { text: 'conf' }), el('th', { text: 'address' }),
          el('th', { text: 'label' }), el('th', { text: 'outpoint' }))));
      const body = el('tbody');
      for (const u of rows.slice(0, 200)) {
        body.append(el('tr', {},
          el('td', { text: sats(u.amountSat) }),
          el('td', { text: String(u.confirmations) }),
          el('td', {}, el('code', { class: 'addr', text: u.address ?? '—' })),
          el('td', { text: u.label ?? '' }),
          // `safe: false` is Core declining to vouch for a coin; a coin-control screen
          // that hid that would be inviting someone to spend it.
          el('td', {}, el('code', { class: 'addr', title: `${u.txid}:${u.vout}`, text: `${shortId(u.txid)}:${u.vout}` }),
            u.safe ? null : el('span', { class: 'warn', text: ' unsafe' }))));
      }
      table.append(body);
      box.append(table);
    } catch (e) {
      box.append(el('p', { class: 'warn', text: e.message }));
    }
    return box;
  }

  async function labelPanel() {
    const box = el('div', { class: 'card' }, el('h3', { text: 'Labels' }));
    if (!ui.wallet) return box;
    try {
      const res = await api(`/api/admin/wallet/labels?wallet=${encodeURIComponent(ui.wallet)}`);
      const rows = res.labels ?? [];
      if (!rows.length) return box.append(el('p', { class: 'sub', text: 'no labels yet' })), box;
      for (const l of rows) {
        const group = el('div', { class: 'labelgroup' },
          el('div', { class: 'row' },
            el('b', { text: l.label || '(no label)' }),
            el('span', { class: 'sub', text: `${l.addresses.length} address(es)` })));
        for (const a of l.addresses.slice(0, 25)) {
          // Every address in the wallet opens the same dialog as a freshly derived one:
          // there is no difference between them worth making the operator remember.
          //
          // tabindex and the Enter/Space handler are not decoration: this is a control, and
          // a control that only a mouse can reach is half-built.
          const code = el('code', {
            class: 'addr clickable', title: 'show the QR and the address',
            tabindex: '0', role: 'button', text: a,
          });
          const open = () => receiveDialog({ address: a, label: l.label });
          code.addEventListener('click', open);
          code.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault?.(); open(); } });
          group.append(code);
        }
        box.append(group);
      }
    } catch (e) {
      box.append(el('p', { class: 'warn', text: e.message }));
    }
    return box;
  }

  // -------------------------------------------------------------- address book
  // Read-only here, deliberately: it lives in the admin block, which this suite cannot
  // write. An interface able to add its own destination could skip the typed confirmation
  // that being absent from this list requires, which would make the list decorative.
  async function addressBookPanel() {
    const box = el('div', { class: 'card' }, el('h3', { text: 'Address book' }));
    try {
      const res = await api('/api/admin/addressbook');
      const rows = res.entries ?? [];
      if (!rows.length) {
        box.append(
          el('p', { class: 'sub', text: 'Empty, so every destination asks you to type a confirmation phrase before it sends.' }),
          el('p', { class: 'sub', text: res.note }),
          el('pre', { class: 'rawtx', text: '"addressBook": [\n  "bcrt1q…",\n  { "address": "bc1q…", "label": "cold storage" }\n]' }),
        );
        return box;
      }
      const table = el('table', { class: 't' },
        el('thead', {}, el('tr', {}, el('th', { text: 'label' }), el('th', { text: 'address' }), el('th', { text: '' }))));
      const body = el('tbody');
      for (const e of rows) {
        body.append(el('tr', {},
          el('td', { text: e.label ?? '' }),
          el('td', {}, el('code', { class: 'addr', text: e.address })),
          // Sending here is the one path that needs no phrase, so the panel offers it.
          el('td', {}, el('button', { class: 'linky', text: 'Use this', onclick: () => {
            // Through the same prefill the Receive screen uses, rather than reaching into
            // the DOM for an input by its placeholder text -- which broke the moment the
            // placeholder was reworded to Core's "Pay To".
            ui.prefillTo = e.address;
            ui.screen = 'send';
            render();
          } }))));
      }
      table.append(body);
      box.append(table, el('p', { class: 'sub', text: res.note }));
    } catch (e) {
      box.append(el('p', { class: 'warn', text: e.message }));
    }
    return box;
  }

  // --------------------------------------------------------------------- render
  /** Core's screen switcher: Overview / Send / Receive / Transactions. */
  function screenTabs() {
    const bar = el('div', { class: 'screens' });
    for (const sc of SCREENS) {
      bar.append(el('button', {
        class: ui.screen === sc.id ? 'screen on' : 'screen',
        text: sc.label,
        onclick: () => { ui.screen = sc.id; render(); },
      }));
    }
    return bar;
  }

  async function render() {
    if (state?.page !== 'wallet') return;
    const head = el('div', { class: 'row' }, el('label', { text: 'wallet' }), walletPicker(), screenTabs());
    // Core keeps each screen to its own job: the Overview carries no send form, and the
    // Send screen carries no transaction list. Following that is most of what makes this
    // feel like Core rather than like a page with Core's words on it.
    const panels = [];
    if (ui.screen === 'overview') panels.push(await overviewPanel(), await historyPanel({ recent: true }));
    else if (ui.screen === 'send') panels.push(await sendPanel(), await utxoPanel(), await addressBookPanel());
    else if (ui.screen === 'receive') panels.push(await receivePanel(), await labelPanel());
    else panels.push(await historyPanel());
    page.replaceChildren(head, ...panels);
  }

  btn.addEventListener('click', () => setTimeout(render, 0));
  return { render, page, btn };
}
