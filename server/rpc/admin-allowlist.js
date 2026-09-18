// WHAT THE ADMINISTRATIVE SUITE MAY CALL (docs/PLAN-ADMIN-SUITE.md §4).
//
// A SECOND list, deliberately not a loosening of the first. `server/rpc/allowlist.js`
// keeps its deny-all posture and its by-name refusal of every wallet method (audit
// 2026-09-16, M4), because that list governs the RPC CONSOLE -- a free-form command box
// where a method name arrives as text from a browser, and M4's reasoning about it has not
// changed one bit.
//
// This list governs typed routes: each entry is reachable only from a specific handler
// that builds its own arguments. The console cannot reach these, and these cannot be
// reached by name; there is no route anywhere that takes a method from the request and
// looks it up here.
//
// Grouped by capability so the grant chain is readable rather than inferred:
//
//   wallet.read     nothing changes; nothing leaves the node but numbers you already own
//   wallet.receive  derives and PERSISTS a new key in the wallet (a write, despite "get")
//   wallet.spend    builds, signs, broadcasts, unlocks
//   node.control    stops the daemon
//
// Two rules that are not obvious and cost real money if forgotten:
//
//   1. `listdescriptors` is here; `listdescriptors true` is NOT THE SAME CALL. The boolean
//      returns private descriptors -- xprvs. The read handler passes no argument and the
//      argument checker below refuses one, so the private form cannot be reached through
//      this suite at all. Same story for `gethdkeys` (private: true), which is simply
//      absent: there is no screen that needs it.
//   2. `dumpprivkey`, `dumpwallet`, `sethdseed`, `importprivkey` and `backupwallet` are
//      absent and stay absent (plan §9). A web page that can show or export a key is a
//      different product from this one.
export const CAPABILITIES = Object.freeze({
  'wallet.read': [
    'listwallets', 'getwalletinfo', 'getbalances', 'listunspent', 'listtransactions',
    'gettransaction', 'listlabels', 'getaddressesbylabel', 'getaddressinfo',
    'listreceivedbyaddress', 'listreceivedbylabel', 'listsinceblock', 'listdescriptors',
    'estimatesmartfee', 'getnetworkinfo', 'getblockchaininfo',
  ],
  'wallet.receive': ['getnewaddress', 'setlabel'],
  'wallet.spend': [
    'walletcreatefundedpsbt', 'walletprocesspsbt', 'finalizepsbt', 'decodepsbt',
    'analyzepsbt', 'testmempoolaccept', 'sendrawtransaction', 'walletpassphrase',
    'walletlock', 'bumpfee', 'psbtbumpfee', 'getrawtransaction', 'decoderawtransaction',
  ],
  'node.control': ['stop', 'uptime', 'getblockcount'],
});

/** Every method this suite can ever call, in any capability. */
export const ADMIN_METHODS = new Set(Object.values(CAPABILITIES).flat());

// Methods whose arguments carry the whole risk, checked here rather than at each call
// site: one place to read when asking "can this suite reach a private key".
const ARG_RULES = {
  // No argument at all. `listdescriptors true` returns private descriptors.
  listdescriptors: (args) => (args.length === 0
    ? null
    : 'listdescriptors takes no argument here: the boolean form returns PRIVATE descriptors (xprvs), which this suite never asks for'),
  // The passphrase and a timeout, and the timeout must be short: an unlock that outlives
  // the action it was for is an unlocked wallet nobody is watching.
  walletpassphrase: (args) => {
    if (args.length !== 2) return 'walletpassphrase takes the passphrase and a timeout';
    const secs = Number(args[1]);
    if (!Number.isFinite(secs) || secs <= 0) return 'the unlock timeout must be a positive number of seconds';
    if (secs > 120) return 'the unlock timeout may not exceed 120s: the wallet is unlocked for one action, not for a session';
    return null;
  },
};

/**
 * May this capability call this method with these arguments?
 *
 * Returns `{ ok }` or `{ ok: false, why }`. The refusal text is written to be shown to a
 * person, because every one of them is a thing somebody will hit while wiring a screen.
 */
export function adminCallAllowed(capability, method, args = []) {
  const list = CAPABILITIES[capability];
  if (!list) return { ok: false, why: `no such capability: ${capability}` };
  if (!list.includes(method)) {
    const elsewhere = Object.entries(CAPABILITIES).find(([, ms]) => ms.includes(method));
    return {
      ok: false,
      why: elsewhere
        ? `${method} belongs to ${elsewhere[0]}, not to ${capability}`
        : `${method} is not in any administrative capability; it was left out deliberately, and adding it is a decision for docs/PLAN-ADMIN-SUITE.md §4 rather than a one-line edit`,
    };
  }
  const rule = ARG_RULES[method];
  const why = rule ? rule(args) : null;
  return why ? { ok: false, why } : { ok: true };
}

/** For the UI and the docs: what this build can do, in words. */
export function capabilitySummary() {
  return Object.entries(CAPABILITIES).map(([name, methods]) => ({ capability: name, methods: methods.length }));
}
