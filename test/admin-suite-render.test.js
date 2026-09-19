// THE ADMIN SUITE'S BROWSER MODULE, EVALUATED AND RENDERED (M1-M5 client).
//
// This exists because of a specific failure on 2026-09-18: an edit to suite.js replaced a
// span of the file by index and swallowed five functions with it — txDetail, historyPanel,
// bumpDialog, utxoPanel, labelPanel. The file still PARSED, so `node --check` was happy and
// the server served it without complaint; it died in the browser at render time with a
// ReferenceError, and the page went blank. From the outside that looks like "21001 is
// dead", which is where the operator started.
//
// The same class of bug is what test/app-boot.test.js was written for ("a missing import
// name parses cleanly... In the browser it is a ReferenceError *during module evaluation*")
// — this is that test, for the suite: evaluate the real module under the DOM stub, drive
// every screen, and fail if anything the render path calls is not there.
import test from 'node:test';
import assert from 'node:assert/strict';

// A SMALL REAL DOM, local to this file.
//
// test/dom-stub.js answers every selector with a freshly invented element and its
// appendChild is a no-op -- which is right for what it was written for (does app.js
// EVALUATE) and useless for this (did the panels actually render). Rather than loosen a
// stub that other tests depend on being loose, this builds an actual tree: append, real
// children, textContent, attributes, listeners, and a querySelectorAll that walks it.
// Enough for the suite, and nothing more.
function makeDom() {
  // One simple selector: tag, .class, [attr] or [attr="value"], in any combination.
  const simple = (node, part) => {
    const m = /^([a-z0-9]+)?(?:\.([a-zA-Z0-9_-]+))?(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/.exec(part);
    if (!m) return false;
    const [, tag, cls, attr, val] = m;
    if (tag && node.tag !== tag) return false;
    if (cls && !String(node.className).split(/\s+/).includes(cls)) return false;
    if (attr && node.attrs[attr] === undefined) return false;
    if (attr && val !== undefined && node.attrs[attr] !== val) return false;
    return true;
  };
  // Descendant combinators too ("nav.pages button"): the last part must match the node,
  // and each earlier part must match some ancestor, in order. Without this the suite's own
  // queries -- which are all of that shape -- silently matched nothing, and the test failed
  // for a reason that had nothing to do with the code under test.
  const matches = (node, sel) => sel.split(',').map((x) => x.trim()).some((branch) => {
    const parts = branch.split(/\s+/).filter(Boolean);
    if (!simple(node, parts.pop())) return false;
    let cur = node.parent;
    for (const part of parts.reverse()) {
      while (cur && !simple(cur, part)) cur = cur.parent;
      if (!cur) return false;
      cur = cur.parent;
    }
    return true;
  });

  const walk = (node, out = []) => {
    for (const c of node.children) { out.push(c); walk(c, out); }
    return out;
  };
  const mk = (tag) => {
    const node = {
      tag, children: [], attrs: {}, listeners: {}, className: '', _text: '', value: '',
      parent: null,
      get textContent() { return node._text || node.children.map((c) => c.textContent).join(''); },
      set textContent(v) { node._text = String(v); node.children.length = 0; },
      setAttribute(k, v) { node.attrs[k] = String(v); },
      getAttribute(k) { return node.attrs[k] ?? null; },
      addEventListener(ev, fn) { (node.listeners[ev] ??= []).push(fn); },
      append(...kids) {
        for (const k of kids.flat()) {
          if (k == null) continue;
          const child = typeof k === 'string' ? Object.assign(mk('#text'), { _text: k }) : k;
          child.parent = node;
          node.children.push(child);
        }
      },
      replaceChildren(...kids) { node.children.length = 0; node.append(...kids); },
      remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); },
      querySelector(sel) { return walk(node).find((n) => matches(n, sel)) ?? null; },
      querySelectorAll(sel) { return walk(node).filter((n) => matches(n, sel)); },
      closest(sel) { let n = node; while (n) { if (matches(n, sel)) return n; n = n.parent; } return null; },
      // classList over className, so the suite's page/nav toggles can be observed.
      classList: {
        add(c) { if (!node.classList.contains(c)) node.className = `${node.className} ${c}`.trim(); },
        remove(c) { node.className = String(node.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle(c, on = !node.classList.contains(c)) { if (on) node.classList.add(c); else node.classList.remove(c); return on; },
        contains(c) { return String(node.className).split(/\s+/).includes(c); },
      },
      focus() {}, select() {}, scrollIntoView() {},
      click() { for (const fn of node.listeners.click ?? []) fn({ target: node }); },
      get childNodes() { return node.children; },
    };
    return node;
  };
  const document = {
    createElement: mk,
    body: mk('body'),
    head: mk('head'),
    querySelector(sel) { return document.body.querySelector(sel) ?? document.head.querySelector(sel); },
    querySelectorAll(sel) { return document.body.querySelectorAll(sel); },
  };
  globalThis.document = document;
  // navigator is a getter-only global on modern Node, so it is defined rather than
  // assigned. The suite touches it only for the "copy raw" button.
  if (!globalThis.navigator?.clipboard) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: async () => {} } },
      configurable: true, writable: true,
    });
  }
  return { document, mk };
}


// Two wallets on two nodes, in the { node, wallet } shape /api/admin/status returns since
// 2026-09-19. The second deliberately shares nothing with the first, so a request that
// carries the wrong half of a pair is visible in the log.
const WALLETS = [{ node: 'regtest', wallet: 'hot' }, { node: 'cold-node', wallet: 'bmc-run27' }];

const qs = (path) => Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? ''));

/** An error shaped the way public/js/app.js's api() throws one. */
const apiError = (message, code) => Object.assign(new Error(message), { payload: { error: { message, code } } });

/**
 * A wallet's worth of plausible answers, shaped exactly as the real routes return them.
 * `calls` gets each path; `log` gets { path, method, body }. `over[path-prefix]` replaces
 * the default answer, and may be a function of (path, opts) -- which is how the tests below
 * delay one answer or refuse one once.
 */
function fakeApi(calls, log = [], over = {}) {
  return async (path, opts = {}) => {
    calls.push(path);
    log.push({ path, method: opts.method ?? 'GET', body: opts.body ?? null });
    for (const [prefix, answer] of Object.entries(over)) {
      if (path.startsWith(prefix)) return typeof answer === 'function' ? answer(path, opts) : answer;
    }
    if (path.startsWith('/api/admin/status')) {
      return {
        enabled: true,
        wallets: WALLETS,
        elevation: { elevated: true, leftMs: 300_000 },
        capabilities: ['elevation', 'wallet.read', 'wallet.receive', 'wallet.spend'],
        you: { username: 'admin', role: 'admin', walletAccess: true },
        gates: { https: true, accounts: true, walletsNamed: 2, spendCapSat: 5_000_000 },
      };
    }
    if (path.startsWith('/api/admin/elevate')) return { ok: true, leftMs: 300_000 };
    if (path.startsWith('/api/admin/wallet/history')) {
      return {
        ok: true,
        transactions: [
          { txid: 'a'.repeat(64), category: 'send', address: 'bcrt1qpaid', label: 'rent', amountSat: -100_000, feeSat: -282, confirmations: 0, time: 1789718000000, bip125Replaceable: 'yes' },
          { txid: 'b'.repeat(64), category: 'receive', address: 'bcrt1qgot', label: '', amountSat: 250_000, feeSat: null, confirmations: 3, time: 1789717000000, bip125Replaceable: 'no' },
          { txid: 'c'.repeat(64), category: 'immature', address: 'bcrt1qmined', label: '', amountSat: 5_000_000_000, feeSat: null, confirmations: 12, time: 1789716000000, bip125Replaceable: 'no' },
        ],
      };
    }
    if (path.startsWith('/api/admin/wallet/utxos')) {
      return { ok: true, utxos: [{ txid: 'd'.repeat(64), vout: 0, address: 'bcrt1qcoin', label: '', amountSat: 400_000, confirmations: 6, spendable: true, solvable: true, safe: true }] };
    }
    if (path.startsWith('/api/admin/wallet/labels')) return { ok: true, labels: [{ label: 'rent', addresses: ['bcrt1qpaid'] }] };
    if (path.startsWith('/api/admin/addressbook')) {
      return { ok: true, entries: [{ address: 'bcrt1qbookentry', label: 'cold storage' }], editable: false, note: 'read only' };
    }
    if (path.startsWith('/api/admin/wallet/address')) {
      return { ok: true, address: `bcrt1q${opts.body?.wallet}derived`, label: opts.body?.label ?? '' };
    }
    if (path.startsWith('/api/admin/wallet/send/build')) {
      const b = opts.body ?? {};
      return {
        ok: true,
        build: {
          id: 'build-1', wallet: b.wallet, node: b.node, chain: 'regtest', to: b.address,
          sendingSat: 100_000, feeSat: 282, totalSat: 100_282, changeSat: 49_899_718, changeAddresses: ['bcrt1qchange'],
          inputs: 1, vsize: 141, feeRateSatPerVb: 2, replaceable: true, addressBook: false, phrase: 'send on regtest', expiresAt: Date.now() + 60_000,
        },
      };
    }
    if (path.startsWith('/api/admin/wallet/send/confirm')) {
      return { ok: true, txid: 'e'.repeat(64), sendingSat: 100_000, feeSat: 282, to: 'bcrt1qdest' };
    }
    if (path.startsWith('/api/admin/tx/bump/confirm')) return { ok: true, txid: 'f'.repeat(64) };
    if (path.startsWith('/api/admin/tx/bump')) return { ok: true, oldFeeSat: 282, newFeeSat: 705, deltaSat: 423, note: 'priced' };
    if (path.startsWith('/api/admin/wallet')) {
      const q = qs(path);
      return {
        ok: true, wallet: q.wallet, node: q.node, canSpend: true, encrypted: true, scanning: null,
        balances: { trustedSat: 5_000_000_000, untrustedPendingSat: 0, immatureSat: 500_000_000_000, totalSat: 505_000_000_000 },
      };
    }
    throw new Error(`unexpected call: ${path}`);
  };
}

async function mount({ over = {}, page = 'wallet' } = {}) {
  const { document, mk } = makeDom();
  // The suite injects its own nav button and page section, so the page it lands on only
  // has to provide a nav and a section to sit beside.
  const nav = mk('nav');
  nav.className = 'pages';
  const main = mk('main');
  const existing = mk('section');
  existing.className = 'page';
  existing.setAttribute('data-page', 'overview');
  main.append(existing);
  document.body.append(nav, main);
  const calls = [];
  const log = [];
  const toasts = [];
  const mod = await import('../public/js/admin/suite.js');
  const state = { page };
  const suite = await mod.initAdminSuite({
    api: fakeApi(calls, log, over),
    toast: (t) => toasts.push(t),
    state,
  });
  if (suite) suite.state = state;
  return { suite, calls, log, toasts, document };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text || b.textContent.startsWith(text));
const click = async (node) => { for (const fn of node.listeners.click ?? []) await fn({ target: node }); };
const lastModal = () => document.body.querySelectorAll('div.modal').pop();
async function toScreen(suite, name) {
  const tab = suite.page.querySelectorAll('button.screen').find((b) => b.textContent === name);
  tab.click();
  await suite.render();
}

test('the module evaluates and mounts', async () => {
  const { suite } = await mount();
  assert.ok(suite, 'initAdminSuite returned nothing, so the suite did not mount');
  assert.ok(suite.page, 'no page section was created');
  assert.ok(document.querySelector('nav.pages button'), 'no nav button was added');
});

test('every screen renders without a ReferenceError', async () => {
  // THE TEST THE BLANK PAGE NEEDED. Each of these calls a different set of panels, and a
  // panel function that is missing — deleted, renamed, never written — throws here rather
  // than in somebody's browser.
  const { suite } = await mount();
  await suite.render();
  for (const screen of ['Overview', 'Send', 'Receive', 'Transactions']) {
    // The tabs are rebuilt on every render, so each one is found fresh rather than held.
    const tab = suite.page.querySelectorAll('button.screen').find((b) => b.textContent === screen);
    assert.ok(tab, `no tab for the ${screen} screen`);
    tab.click();
    await suite.render();
    assert.ok(suite.page.childNodes.length > 1, `the ${screen} screen rendered nothing`);
    // Every panel on the screen must have produced a card, not an empty shell.
    assert.ok(suite.page.querySelectorAll('div.card').length >= 1, `${screen} rendered no panels`);
  }
});

test('the overview shows Core\'s four balance rows, in Core\'s order', async () => {
  const { suite } = await mount();
  await suite.render();
  const labels = [...suite.page.querySelectorAll('dl.balances dt')].map((n) => n.textContent);
  assert.deepEqual(labels, ['Available:', 'Pending:', 'Immature:', 'Total:']);
});

test('the transaction table has Core\'s columns and status wording', async () => {
  const { suite, calls } = await mount();
  await suite.render();
  const heads = [...suite.page.querySelectorAll('table.tx th')].map((n) => n.textContent);
  assert.deepEqual(heads, ['', 'Date', 'Type', 'Label', 'Amount']);
  const titles = [...suite.page.querySelectorAll('table.tx tbody tr')].map((r) => r.getAttribute('title'));
  assert.ok(titles.includes('Unconfirmed'), `expected Core's "Unconfirmed", got ${JSON.stringify(titles)}`);
  assert.ok(titles.some((t) => /^Confirming \(3 of 6 recommended confirmations\)$/.test(t)), 'Core\'s confirming wording, verbatim');
  assert.ok(calls.some((c) => c.startsWith('/api/admin/wallet/history')), 'the history route was actually called');
});

test('a receive row and a labelled address both open the QR dialog', async () => {
  // The gap this covers: the rows rendered, and nothing happened when they were clicked.
  // A list that looks interactive and is not is worse than a list that looks inert.
  const { suite } = await mount();
  await suite.render();
  const receiveTab = suite.page.querySelectorAll('button.screen').find((b) => b.textContent === 'Receive');
  receiveTab.click();
  await suite.render();

  // An address under a label opens it -- and announces that it will, to a mouse and to a
  // keyboard. It was clickable with neither hover nor cursor nor focus for a while, which
  // is indistinguishable from not being clickable at all.
  const addr = suite.page.querySelectorAll('code.clickable')[0];
  assert.ok(addr, 'a labelled address should be clickable');
  assert.equal(addr.attrs.tabindex, '0', 'a control must be reachable by keyboard');
  assert.equal(addr.attrs.role, 'button');
  assert.ok(addr.attrs.title, 'and say what it does on hover');
  assert.ok(addr.listeners.keydown?.length, 'Enter and Space must work, not just a click');
  addr.listeners.click[0]({ target: addr });
  const dialog = document.body.querySelectorAll('div.modal').pop();
  assert.ok(dialog, 'no dialog opened');
  assert.ok(dialog.querySelector('canvas.qr'), 'the dialog must carry the QR');
  assert.ok(dialog.querySelector('code.big-addr'), 'and the address in full');
  const buttons = dialog.querySelectorAll('button').map((b) => b.textContent);
  assert.deepEqual(buttons, ['Copy address', 'Copy URI', 'Send to this address', 'Close']);
});

test('every clickable row carries the affordance, not just the handler', async () => {
  const { suite } = await mount();
  await suite.render();
  const rows = suite.page.querySelectorAll('tr.clickable');
  assert.ok(rows.length >= 1, 'the recent-transactions rows should be clickable');
  for (const row of rows) {
    assert.equal(row.attrs.tabindex, '0', 'reachable by keyboard');
    assert.ok(row.attrs.title, 'says what it does');
    assert.ok(row.listeners.click?.length && row.listeners.keydown?.length, 'mouse and keyboard');
  }
});

test('the send screen can choose from the address book and from history', async () => {
  // Operator, 2026-09-18: "I should be able to see the address book on send as well." The
  // panel was already there; what was missing was Core's "Choose previously used address"
  // beside the Pay To field, and the distinction between an address you have VOUCHED for
  // (the book, no phrase) and one you have merely PAID before (history, phrase still asked).
  const { suite } = await mount();
  await suite.render();
  const sendTab = suite.page.querySelectorAll('button.screen').find((b) => b.textContent === 'Send');
  sendTab.click();
  await suite.render();

  const choose = suite.page.querySelectorAll('button').find((b) => b.textContent === 'Choose…');
  assert.ok(choose, 'the Pay To field needs a chooser beside it');
  choose.listeners.click[0]({ target: choose });
  await new Promise((r) => setTimeout(r, 0));   // the picker loads its two lists

  const dialog = document.body.querySelectorAll('div.modal').pop();
  assert.ok(dialog, 'no picker opened');
  const headings = dialog.querySelectorAll('h4').map((h) => h.textContent);
  assert.deepEqual(headings, ['Address book', 'Previously used']);
  const notes = dialog.querySelectorAll('div.sub').map((n) => n.textContent);
  assert.ok(notes.includes('no confirmation phrase needed'), 'the book must say what it buys');
  assert.ok(notes.includes('still asks for the confirmation phrase'), 'and history must say what it does not');

  // Picking one fills the field rather than navigating away.
  const payee = dialog.querySelectorAll('div.payee')[0];
  assert.ok(payee, 'no pickable entries');
  assert.equal(payee.attrs.tabindex, '0');
  payee.listeners.click[0]({ target: payee });
  const field = suite.page.querySelectorAll('input').find((i) => (i.attrs.placeholder ?? '').startsWith('Pay To'));
  assert.equal(field.value, 'bcrt1qbookentry');
});

test('a row opens its detail view, and the Bump button does not', async () => {
  const { suite } = await mount();
  await suite.render();
  const row = suite.page.querySelector('table.tx tbody tr');
  assert.ok(row, 'no rows rendered');
  // The guard that keeps the two apart: a click on the button inside the row must not
  // also open the transaction.
  const button = row.querySelector('button');
  assert.ok(button, 'the unconfirmed replaceable send should offer a fee bump');
  assert.ok(typeof row.onclick === 'function' || row.listeners?.click, 'the row is not clickable');
});

// ---------------------------------------------------------- the review of 2026-09-19
// Each test below is a finding from that review, written to fail against the code as it
// was, before the fix.

test('the picker names node and wallet, and every wallet request carries both', async () => {
  // /api/admin/status lists { node, wallet } pairs since 2026-09-19: one wallet name can
  // exist on two nodes, and a request naming only the wallet let the server guess which.
  const { suite, log } = await mount();
  await suite.render();
  const select = suite.page.querySelector('select');
  const labels = select.querySelectorAll('option').map((o) => o.textContent);
  assert.deepEqual(labels, ['regtest · hot', 'cold-node · bmc-run27']);

  const second = select.querySelectorAll('option')[1];
  select.listeners.change[0]({ target: { value: second.attrs.value } });
  await settle();
  log.length = 0;
  for (const screen of ['Overview', 'Send', 'Receive', 'Transactions']) await toScreen(suite, screen);
  const walletCalls = log.filter((c) => c.path.startsWith('/api/admin/wallet'));
  assert.ok(walletCalls.length >= 5, 'the screens should have asked about the wallet');
  for (const c of walletCalls) {
    assert.deepEqual({ node: qs(c.path).node, wallet: qs(c.path).wallet }, { node: 'cold-node', wallet: 'bmc-run27' },
      `${c.path} does not name the selected pair`);
  }
});

test('an older render that finishes late does not overwrite a newer one', async () => {
  // Wallet A's overview answers slowly; the operator switches to B meanwhile. Unordered,
  // A's result landed last and the page showed A under a picker that said B -- and a send
  // built from that page went from whichever wallet the code happened to read.
  let gate = null;                                    // open until the test closes it
  let releaseA;
  const { suite } = await mount({
    page: 'overview',
    over: {
      '/api/admin/wallet?': async (path) => {
        const q = qs(path);
        if (q.wallet === 'hot' && gate) await gate;
        return {
          ok: true, wallet: q.wallet, node: q.node, canSpend: true, encrypted: true, scanning: null,
          balances: { trustedSat: 1, untrustedPendingSat: 0, immatureSat: 0, totalSat: 1 },
        };
      },
    },
  });
  suite.state.page = 'wallet';
  await suite.render();                               // A, drawn: the picker is on the page
  gate = new Promise((r) => { releaseA = r; });
  const first = suite.render();                       // A again, stuck on the slow answer
  await tick();
  suite.page.querySelector('select').listeners.change[0]({ target: { value: '1' } });   // -> B
  await settle();
  releaseA();
  await first;
  await settle();
  const sub = suite.page.querySelectorAll('div.sub').map((n) => n.textContent);
  assert.ok(sub.includes('bmc-run27 on cold-node'), `the page should show B, shows ${JSON.stringify(sub)}`);
  assert.ok(!sub.includes('hot on regtest'), 'A\'s late answer must be dropped, not drawn');
});

async function buildASend(opts = {}) {
  const m = await mount(opts);
  await m.suite.render();
  await toScreen(m.suite, 'Send');
  const pay = m.suite.page.querySelectorAll('input').find((i) => (i.attrs.placeholder ?? '').startsWith('Pay To'));
  const amount = m.suite.page.querySelectorAll('input').find((i) => (i.attrs.placeholder ?? '').startsWith('amount'));
  pay.value = 'bcrt1qdest';
  amount.value = '100000';
  await click(button(m.suite.page, 'Review'));
  await settle();
  return m;
}

test('the confirm screen names the wallet it spends from, as the server built it', async () => {
  const { suite, log } = await buildASend();
  const build = log.find((c) => c.path === '/api/admin/wallet/send/build');
  assert.deepEqual({ node: build.body.node, wallet: build.body.wallet }, { node: 'regtest', wallet: 'hot' });
  const confirm = suite.page.querySelector('div.confirm');
  assert.ok(confirm, 'no confirm screen');
  assert.ok(confirm.textContent.includes('Spending from: hot on regtest'), confirm.textContent);
});

test('the wallet passphrase is required on an encrypted wallet, and is not a login password', async () => {
  const { suite, log } = await buildASend();
  const confirm = suite.page.querySelector('div.confirm');
  const pass = confirm.querySelectorAll('input').find((i) => i.attrs.type === 'password');
  assert.ok(pass, 'no passphrase field');
  assert.equal(pass.attrs.required, 'required', 'required on an encrypted wallet (decision of 2026-09-19)');
  // autocomplete="off" is ignored on password fields; a browser would offer to save the
  // wallet passphrase as this site's login, then fill it into the elevation prompt.
  assert.equal(pass.attrs.autocomplete, 'one-time-code');
  assert.equal(pass.attrs.name, 'wallet-passphrase');
  assert.match(confirm.textContent, /[Rr]equired/, 'the hint says it is required, and why');

  // Empty: refused here, before anything reaches the server.
  confirm.querySelectorAll('input').find((i) => i.attrs.type === 'text').value = 'send on regtest';
  await click(button(confirm, 'Send'));
  await settle();
  assert.ok(!log.some((c) => c.path === '/api/admin/wallet/send/confirm'), 'an empty passphrase must not be sent');
});

test('a lapsed elevation at Send asks for the password and then sends', async () => {
  // Elevation is consumed by a spend and lasts minutes, so it can run out between Review
  // and Send. That used to surface as an error and a cleared passphrase field.
  let refused = false;
  const { suite, log, document: doc } = await buildASend({
    over: {
      '/api/admin/wallet/send/confirm': (path, opts) => {
        if (!refused) { refused = true; throw apiError('elevation required', 'elevation-required'); }
        return { ok: true, txid: 'e'.repeat(64), sendingSat: 100_000, feeSat: 282, to: opts.body.address ?? 'bcrt1qdest' };
      },
    },
  });
  const confirm = suite.page.querySelector('div.confirm');
  confirm.querySelectorAll('input').find((i) => i.attrs.type === 'text').value = 'send on regtest';
  confirm.querySelectorAll('input').find((i) => i.attrs.type === 'password').value = 'wallet secret';
  const sending = click(button(confirm, 'Send'));
  await settle();
  const prompt = doc.body.querySelectorAll('div.modal').pop();
  assert.ok(prompt && prompt.textContent.includes('Confirm it is you'), 'the password prompt should open');
  const pw = prompt.querySelector('input');
  assert.equal(pw.attrs.autocomplete, 'current-password', 'the elevation prompt keeps current-password');
  pw.value = 'account password';
  await click(button(prompt, 'Confirm'));
  await sending;
  await settle();
  const confirms = log.filter((c) => c.path === '/api/admin/wallet/send/confirm');
  assert.equal(confirms.length, 2, 'retried once after elevating');
  assert.equal(confirms[1].body.passphrase, 'wallet secret', 'the passphrase survives the prompt');
  assert.deepEqual({ node: confirms[1].body.node, wallet: confirms[1].body.wallet }, { node: 'regtest', wallet: 'hot' });
  assert.ok(suite.page.textContent.includes('Sent'), 'and it sent');
});

test('the requested-payments history belongs to the wallet it was made in', async () => {
  const { suite } = await mount();
  await suite.render();
  await toScreen(suite, 'Receive');
  await click(button(suite.page, 'Create new receiving address'));
  await settle();
  await suite.render();
  assert.ok(suite.page.textContent.includes('Requested payments history'), 'A shows its own history');
  suite.page.querySelector('select').listeners.change[0]({ target: { value: '1' } });
  await settle();
  await suite.render();
  assert.ok(!suite.page.textContent.includes('bcrt1qhotderived'), 'wallet A\'s address must not show under wallet B');
  assert.ok(!suite.page.textContent.includes('Requested payments history'), 'B has made no requests');
  // And back on A, it is still there.
  suite.page.querySelector('select').listeners.change[0]({ target: { value: '0' } });
  await settle();
  await suite.render();
  assert.ok(suite.page.textContent.includes('bcrt1qhotderived'), 'A keeps its own history');
});

test('a fee bump replaces at the rate it priced, not whatever is in the box', async () => {
  const { suite, log, document: doc } = await mount();
  await suite.render();
  await click(button(suite.page, 'Bump fee'));
  const dialog = doc.body.querySelectorAll('div.modal').pop();
  const rate = dialog.querySelector('input');
  rate.value = '5';
  await click(button(dialog, 'Price it'));
  await settle();
  assert.equal(rate.disabled, true, 'the rate is fixed once priced');
  const pass = dialog.querySelectorAll('input').find((i) => i.attrs.type === 'password');
  assert.equal(pass.attrs.required, 'required');
  assert.equal(pass.attrs.autocomplete, 'one-time-code');
  pass.value = 'wallet secret';
  rate.value = '50';                                  // what a stale or scripted edit would do
  await click(button(dialog, 'Replace it'));
  await settle();
  const confirm = log.find((c) => c.path === '/api/admin/tx/bump/confirm');
  assert.ok(confirm, 'nothing was sent');
  assert.equal(confirm.body.feeRate, '5', 'the priced rate, not the edited one');
  assert.deepEqual({ node: confirm.body.node, wallet: confirm.body.wallet }, { node: 'regtest', wallet: 'hot' });
});

test('editing the rate after pricing throws the price away', async () => {
  const { suite, document: doc } = await mount();
  await suite.render();
  await click(button(suite.page, 'Bump fee'));
  const dialog = doc.body.querySelectorAll('div.modal').pop();
  const rate = dialog.querySelector('input');
  rate.value = '5';
  await click(button(dialog, 'Price it'));
  await settle();
  assert.ok(button(dialog, 'Replace it'), 'priced');
  await click(button(dialog, 'Change the rate'));
  assert.equal(rate.disabled, false);
  assert.equal(button(dialog, 'Replace it'), undefined, 'no Replace button for a rate that is no longer priced');
  rate.value = '6';
  for (const fn of rate.listeners.input ?? []) fn({ target: rate });
  assert.equal(button(dialog, 'Replace it'), undefined);
});

test('a transaction\'s outputs are labelled by what they are to this wallet', async () => {
  const detail = (details, outputs) => ({
    ok: true, txid: '9'.repeat(64), wallet: 'hot', amountSat: 0, feeSat: null, confirmations: 1,
    time: 1789718000000, replaceable: 'no', details, inputs: [], outputs, vsize: 141, weight: 564, hex: '00',
  });
  const cases = [
    // A receive: the output that is ours is the payment, not change.
    [detail([{ address: 'bcrt1qme', category: 'receive', amountSat: 250_000, vout: 1 }],
      [{ n: 0, address: 'bcrt1qtheirchange', amountSat: 10, mine: false }, { n: 1, address: 'bcrt1qme', amountSat: 250_000, mine: true }]),
    ['not yours', 'yours (received)']],
    // A send: theirs is the payment out, ours (absent from details) is the change.
    [detail([{ address: 'bcrt1qthem', category: 'send', amountSat: -100_000, vout: 0 }],
      [{ n: 0, address: 'bcrt1qthem', amountSat: 100_000, mine: false }, { n: 1, address: 'bcrt1qchange', amountSat: 5, mine: true }]),
    ['paid out', 'yours (change)']],
    // A send to yourself: the destination is ours and is not change.
    [detail([{ address: 'bcrt1qself', category: 'send', amountSat: -100_000, vout: 0 }, { address: 'bcrt1qself', category: 'receive', amountSat: 100_000, vout: 0 }],
      [{ n: 0, address: 'bcrt1qself', amountSat: 100_000, mine: true }, { n: 1, address: 'bcrt1qchange', amountSat: 5, mine: true }]),
    ['yours (sent to yourself)', 'yours (change)']],
  ];
  for (const [answer, want] of cases) {
    const { suite, document: doc } = await mount({ over: { '/api/admin/wallet/tx': answer } });
    await suite.render();
    const row = suite.page.querySelector('table.tx tbody tr');
    row.listeners.click[0]({ target: row });
    await settle();
    const dialog = doc.body.querySelectorAll('div.modal').pop();
    const table = dialog.querySelectorAll('table.t')[0];
    const got = table.querySelectorAll('tbody tr').map((r) => r.children[3].textContent);
    assert.deepEqual(got, want);
  }
});

test('opening #wallet directly renders the suite once it has loaded', async () => {
  // app.js's setPage('wallet') runs at boot, before the suite's import() resolves -- so the
  // section did not exist to be shown, and adminSuite was not there to render. The page
  // stayed blank until the tab was clicked.
  const { suite } = await mount({ page: 'wallet' });
  await settle();
  assert.ok(suite.page.classList.contains('on'), 'the wallet section is shown');
  assert.ok(suite.btn.classList.contains('on'), 'and its nav button marked');
  assert.ok(suite.page.querySelectorAll('div.card').length >= 1, 'and it rendered without a click');
});

test('landing elsewhere leaves the wallet section hidden', async () => {
  const { suite } = await mount({ page: 'overview' });
  await settle();
  assert.ok(!suite.page.classList.contains('on'));
  assert.equal(suite.page.childNodes.length, 0);
});
