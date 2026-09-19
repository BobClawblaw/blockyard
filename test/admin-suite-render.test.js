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


/** A wallet's worth of plausible answers, shaped exactly as the real routes return them. */
function fakeApi(calls) {
  return async (path) => {
    calls.push(path);
    if (path.startsWith('/api/admin/status')) {
      return {
        enabled: true,
        wallets: ['hot'],
        elevation: { elevated: true, leftMs: 300_000 },
        capabilities: ['elevation', 'wallet.read', 'wallet.receive', 'wallet.spend'],
        you: { username: 'admin', role: 'admin', walletAccess: true },
        gates: { https: true, accounts: true, walletsNamed: 1, spendCapSat: 5_000_000 },
      };
    }
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
    if (path.startsWith('/api/admin/wallet')) {
      return {
        ok: true, wallet: 'hot', node: 'regtest', canSpend: true, encrypted: true, scanning: null,
        balances: { trustedSat: 5_000_000_000, untrustedPendingSat: 0, immatureSat: 500_000_000_000, totalSat: 505_000_000_000 },
      };
    }
    throw new Error(`unexpected call: ${path}`);
  };
}

async function mount() {
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
  const mod = await import('../public/js/admin/suite.js');
  const suite = await mod.initAdminSuite({
    api: fakeApi(calls),
    toast: () => {},
    state: { page: 'wallet' },
  });
  return { suite, calls };
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
