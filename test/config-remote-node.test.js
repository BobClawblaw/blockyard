// A NODE ON ANOTHER MACHINE, which is what a node appliance is.
//
// (operator, 2026-09-13, preparing a pre-release: "I should be able to follow the instructions to
// get it running on my mac, and pointing at my umbrel?")
//
// It could not. docs/INSTALL.md tells appliance users -- Umbrel, Start9, myNode -- to configure
// rpcUser/rpcPassword with no datadir, because a node on another machine has no cookie file this
// process can read. The config validator refused exactly that shape at boot:
//
//     Invalid configuration:
//       - node umbrel: need datadir or cookieFile for cookie auth
//
// resolveCookie() had always supported configured credentials (it falls through to
// rpcUser/rpcPassword with source "config"); only the validator disagreed, so the documented
// configuration was unreachable. Nothing pinned the old rule, which is why it survived.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveCookie } from '../server/config.js';

const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };

function withConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-remote-'));
  const f = path.join(dir, 'local.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  try { return loadConfig({ configFile: f, ifaces }); } finally { /* dir is temp */ }
}

test('a remote node authenticated by rpcUser/rpcPassword needs no datadir', () => {
  // THE REGRESSION THIS FILE EXISTS FOR: the exact shape docs/INSTALL.md recommends.
  const cfg = withConfig({
    nodes: [{
      id: 'umbrel', label: 'Umbrel', rpcUrl: 'http://umbrel.local:8332',
      rpcUser: 'umbrel', rpcPassword: 'a-long-random-password', chainHint: 'main',
    }],
  });
  assert.equal(cfg.nodes.length, 1);
  assert.equal(cfg.nodes[0].datadir ?? null, null, 'no datadir was given, and none should be invented');
  const auth = resolveCookie(cfg.nodes[0]);
  assert.ok(auth, 'the client must find a credential, or every call is a 401');
  assert.equal(auth.source, 'config', 'it comes from the configured user/password, not a cookie file');
  assert.equal(auth.user, 'umbrel');
});

test('cookie auth on the same machine still works, and still needs a path', () => {
  const cfg = withConfig({
    nodes: [{ id: 'main', rpcUrl: 'http://127.0.0.1:8332', datadir: '/home/you/.bitcoin', chainHint: 'main' }],
  });
  assert.equal(cfg.nodes[0].datadir, '/home/you/.bitcoin');
});

test('a node with NEITHER a cookie path nor credentials is still refused', () => {
  // The rule was not wrong to exist -- a node with no way to authenticate is a node that will
  // 401 on every call, and saying so at boot beats discovering it in the event feed.
  assert.throws(
    () => withConfig({ nodes: [{ id: 'nowhere', rpcUrl: 'http://127.0.0.1:8332', chainHint: 'main' }] }),
    /needs either datadir\/cookieFile.*or rpcUser \+ rpcPassword/s,
    'a node with no authentication route must not boot',
  );
});

test('half-configured credentials are caught, not silently half-used', () => {
  // rpcUser with no password would send `Basic dXNlcjo=` and fail with a confusing 401.
  assert.throws(
    () => withConfig({ nodes: [{ id: 'half', rpcUrl: 'http://127.0.0.1:8332', rpcUser: 'someone', chainHint: 'main' }] }),
    /rpcUser is set but rpcPassword is empty/,
  );
});

test('a remote node is not skipped at boot for having no datadir', () => {
  // main.js skips a node whose datadir is SET but missing, so that a cleaned-up directory does not
  // become a permanently-offline panel. A remote node has no datadir at all and must not trip it.
  const cfg = withConfig({
    nodes: [{ id: 'umbrel', rpcUrl: 'http://umbrel.local:8332', rpcUser: 'u', rpcPassword: 'p', chainHint: 'main' }],
  });
  const n = cfg.nodes[0];
  const wouldSkip = !!(n.datadir && !n.cookieFile && !fs.existsSync(n.datadir));
  assert.equal(wouldSkip, false, 'a credentials-only node must survive the datadir-missing check');
});
