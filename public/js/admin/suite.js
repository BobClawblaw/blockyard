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
  const nav = $('nav.pages');
  const main = $('.page')?.parentElement ?? document.body;
  const page = el('section', { class: 'page', 'data-page': 'wallet' });
  main.append(page);
  const btn = el('button', { 'data-page': 'wallet', id: 'navWallet', text: 'Wallet' });
  nav?.append(btn);

  const ui = {
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
          err.textContent = e.message;
        }
      };
      const dialog = el('div', { class: 'modal' },
        el('div', { class: 'modalbox' },
          el('h3', { text: 'Your password, please' }),
          el('p', { text: why ?? 'This changes something, so the session alone does not authorise it.' }),
          input, err,
          el('div', { class: 'row' },
            el('button', { class: 'primary', text: 'Unlock', onclick: submit }),
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

  async function overviewPanel() {
    const box = el('div', { class: 'card' });
    if (!ui.wallet) {
      box.append(el('p', { text: 'No wallet is named in admin.wallets, so none is reachable from here.' }));
      return box;
    }
    try {
      const w = await api(`/api/admin/wallet?wallet=${encodeURIComponent(ui.wallet)}`);
      box.append(
        el('h3', { text: `${w.wallet} on ${w.node}` }),
        el('div', { class: 'big', text: btc(w.balances.totalSat) }),
        el('div', { class: 'sub', text: `${sats(w.balances.trustedSat)} spendable · ${sats(w.balances.untrustedPendingSat)} pending · ${sats(w.balances.immatureSat)} immature` }),
        w.canSpend ? null : el('p', { class: 'warn', text: 'This is a watch-only wallet: it holds no keys and cannot send.' }),
        w.encrypted ? el('p', { class: 'sub', text: 'Encrypted: sending asks for the wallet passphrase as well as your account password.' }) : null,
        w.scanning ? el('p', { class: 'warn', text: 'The wallet is rescanning, so these figures are provisional.' }) : null,
      );
    } catch (e) {
      box.append(el('p', { class: 'warn', text: e.message }));
    }
    return box;
  }

  async function receivePanel() {
    const label = el('input', { type: 'text', placeholder: 'what is this address for?' });
    const out = el('div');
    const make = () => withElevation('Deriving an address writes to the wallet.', async () => {
      const res = await api('/api/admin/wallet/address', { method: 'POST', body: { wallet: ui.wallet, label: label.value } });
      out.replaceChildren(
        el('code', { class: 'addr', text: res.address }),
        el('div', { class: 'sub', text: res.label ? `labelled "${res.label}"` : 'no label' }),
      );
      label.value = '';
      toast('address derived');
    });
    return el('div', { class: 'card' },
      el('h3', { text: 'Receive' }), label,
      el('button', { class: 'primary', text: 'New address', onclick: make }), out);
  }

  // ------------------------------------------------------------------------ send
  // Two screens, because the second one shows what the NODE built rather than what was
  // typed. See server/admin/send.js.
  async function sendPanel() {
    const address = el('input', { type: 'text', placeholder: 'destination address', autocomplete: 'off' });
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
      address, amount,
      el('button', { class: 'primary', text: 'Review', onclick: build }),
      el('p', { class: 'sub', text: 'Nothing is signed until you confirm the transaction the node builds.' }),
      out);
  }

  function confirmScreen(b, out) {
    const phrase = b.phrase ? el('input', { type: 'text', placeholder: `type: ${b.phrase}`, autocomplete: 'off' }) : null;
    const pass = el('input', { type: 'password', placeholder: 'wallet passphrase (if encrypted)', autocomplete: 'off' });
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

    // EVERY FIGURE HERE COMES FROM THE BUILT TRANSACTION. The form's numbers are not
    // repeated back; what is shown is what will be broadcast.
    return el('div', { class: 'confirm' },
      el('h4', { text: 'Confirm this transaction' }),
      el('dl', {},
        el('dt', { text: 'paying' }), el('dd', {}, el('code', { class: 'addr', text: b.to })),
        el('dt', { text: 'amount' }), el('dd', { text: `${sats(b.sendingSat)} (${btc(b.sendingSat)})` }),
        el('dt', { text: 'fee' }), el('dd', { text: `${sats(b.feeSat)} · ${b.feeRateSatPerVb ?? '—'} sat/vB over ${b.vsize ?? '—'} vB` }),
        el('dt', { text: 'total' }), el('dd', { text: sats(b.totalSat) }),
        el('dt', { text: 'change' }), el('dd', { text: sats(b.changeSat) }),
        el('dt', { text: 'inputs' }), el('dd', { text: String(b.inputs) }),
        el('dt', { text: 'network' }), el('dd', { text: b.chain }),
      ),
      b.addressBook
        ? el('p', { class: 'sub', text: 'This destination is in your address book.' })
        : el('p', { class: 'warn', text: 'This destination is NOT in your address book. Check the address above against the one you were given, character by character.' }),
      phrase, pass, err,
      el('button', { class: 'danger', text: `Send ${sats(b.totalSat)}`, onclick: send }));
  }

  // --------------------------------------------------------------------- render
  async function render() {
    if (state?.page !== 'wallet') return;
    page.replaceChildren(
      el('div', { class: 'row' }, el('label', { text: 'wallet' }), walletPicker()),
      await overviewPanel(),
      await receivePanel(),
      await sendPanel(),
    );
  }

  btn.addEventListener('click', () => setTimeout(render, 0));
  return { render, page, btn };
}
