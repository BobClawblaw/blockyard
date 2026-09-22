// Which RPCs the web UI may call. Default DENY.
//
// A prefix rule like "starts with get" would be a hole, not a guard: this node's
// own docs (docs/RPC_LIVE_NODE.md) record that `getnewaddress` and
// `getrawchangeaddress` derive and persist new wallet keys, and that
// `rescanblockchain` blocks every other RPC for its duration on a server that
// services one connection at a time. So the rules are:
//
//   1. an explicit deny list of mutating and expensive methods, checked first;
//   2. then an allow list of read-shaped prefixes;
//   3. anything unknown is denied, and the reply says what to change to allow it.
//
// Node write operations are not in this file at all: they live behind
// config.actions.allow and are audited. See http/api.js action routes.

// Mutating, wallet-changing, or file-writing. Checked before the allow prefixes.
const DENY_EXACT = new Set([
  // wallet key/materialization -- "get" prefix notwithstanding
  'getnewaddress', 'getrawchangeaddress', 'keypoolrefill', 'addhdkey',
  // spends and broadcasts
  'sendtoaddress', 'sendmany', 'send', 'sendall', 'sendrawtransaction', 'submitpackage',
  'walletcreatefundedpsbt', 'fundrawtransaction', 'bumpfee', 'psbtbumpfee', 'signrawtransactionwithwallet',
  // wallet state
  'walletpassphrase', 'walletlock', 'walletpassphrasechange', 'encryptwallet', 'setlabel',
  'importprivkey', 'importaddress', 'importpublickey', 'importdescriptors', 'importmempool',
  'importmulti', 'importprunedfunds', 'removeprunedfunds', 'createwallet', 'loadwallet',
  'unloadwallet', 'restorewallet', 'migratewallet', 'setwalletflag', 'backupwallet',
  'exportwatchonlywallet', 'abandontransaction', 'lockunspent', 'sethdseed', 'settxfee',
  'signmessage', 'signrawtransactionwithkey', 'walletprocesspsbt', 'descriptorprocesspsbt',
  // peer / network control (the node documents these as worker-channel mutators)
  'addnode', 'removeaddednode', 'disconnectnode', 'setban', 'clearbanned', 'setnetworkactive', 'ping',
  // chain / storage mutators
  'invalidateblock', 'reconsiderblock', 'preciousblock', 'pruneblockchain', 'submitblock',
  'submitheader', 'stop', 'savemempool', 'dumptxoutset', 'loadtxoutset', 'simulateutxo',
  // heavy reads that monopolise a single-threaded RPC server
  'rescanblockchain', 'scanblocks', 'scantxoutset', 'getdescriptoractivity', 'verifychain',
  // can switch logging off; the node refuses the mutating form anyway
  'logging',
]);

// Bitcoin Core's own read verbs, and nothing else: an earlier node this was written against
// namespaced its own commands with a vendor prefix, and those prefixes were admitted here by
// read verb. That node is not supported (2026-09-14), and its prefixes are gone with it -- a
// prefix nobody uses is a hole waiting for a name.
const ALLOW_PREFIXES = ['get', 'list', 'estimate', 'verify', 'estimat', 'help', 'uptime', 'decoderaw', 'decodescript', 'createraw', 'analyzepsbt', 'decodepsbt', 'convertbits', 'getrpcinfo'];

// Explicitly not allowed even though they look read-shaped: they build or sign
// transactions, which is a write in every way that matters.
const DENY_PREFIXES = ['generate', 'invalidate', 'reconsider', 'import', 'send', 'set', 'unload', 'load', 'sign'];

// EVERY WALLET RPC, READ-SHAPED OR NOT (audit 2026-09-16, M4). The `get` and `list` prefixes let
// `listdescriptors true` and `gethdkeys {"private":true}` through, and both return private keys
// from an unlocked wallet -- to anyone the console serves, which in open mode is anyone who can
// reach the port. The monitor has no use for a wallet, so the whole category is refused by name.
// The list is Bitcoin Core's own "== Wallet ==" section of `help` (Core 29/30, taken 2026-09-16),
// plus the legacy-wallet methods older nodes still answer.
export const WALLET_METHODS = new Set([
  'abandontransaction', 'abortrescan', 'addhdkey', 'backupwallet', 'bumpfee', 'createwallet',
  'createwalletdescriptor', 'encryptwallet', 'exportwatchonlywallet', 'getaddressesbylabel',
  'getaddressinfo', 'getbalance', 'getbalances', 'gethdkeys', 'getnewaddress', 'getrawchangeaddress',
  'getreceivedbyaddress', 'getreceivedbylabel', 'gettransaction', 'getwalletinfo', 'importdescriptors',
  'importprunedfunds', 'keypoolrefill', 'listaddressgroupings', 'listdescriptors', 'listlabels',
  'listlockunspent', 'listreceivedbyaddress', 'listreceivedbylabel', 'listsinceblock', 'listtransactions',
  'listunspent', 'listwalletdir', 'listwallets', 'loadwallet', 'lockunspent', 'migratewallet',
  'psbtbumpfee', 'removeprunedfunds', 'rescanblockchain', 'restorewallet', 'send', 'sendall', 'sendmany',
  'sendtoaddress', 'setlabel', 'setwalletflag', 'signmessage', 'signrawtransactionwithwallet',
  'simulaterawtransaction', 'unloadwallet', 'walletcreatefundedpsbt', 'walletdisplayaddress', 'walletlock',
  'walletpassphrase', 'walletpassphrasechange', 'walletprocesspsbt',
  // legacy (pre-descriptor) wallets
  'dumpprivkey', 'dumpwallet', 'importprivkey', 'importaddress', 'importpubkey', 'importmulti',
  'importwallet', 'sethdseed', 'upgradewallet', 'getunconfirmedbalance', 'listaccounts', 'getaccount',
  'getaccountaddress', 'getaddressesbyaccount', 'getreceivedbyaccount', 'listreceivedbyaccount',
]);

export function classifyMethod(method) {
  if (typeof method !== 'string' || !method) return { allowed: false, kind: 'unknown', reason: 'method name must be a string' };
  if (WALLET_METHODS.has(method)) return { allowed: false, kind: 'wallet', reason: 'wallet RPCs are not exposed: some of them return private keys, and the monitor has no use for a wallet' };
  if (DENY_EXACT.has(method)) return { allowed: false, kind: 'write-or-heavy', reason: 'this method mutates state or monopolises the node\'s single-threaded RPC server' };
  // NO EXCEPTION HERE (audit 2026-09-22, L1). This used to read `&& !ALLOW_PREFIXES.includes(method)`,
  // which looks like "unless the method is also allow-prefixed" but is not that: `.includes` on an
  // array of short strings like 'get'/'list' is an EXACT match against `method`, never true for any
  // real RPC name, so the clause could not fire -- harmless today only because it happened to be
  // stricter than it read. A later edit that "fixed" it into an actual prefix test would have opened
  // every DENY_PREFIXES method whose name also happens to start with an ALLOW_PREFIXES entry. A
  // method that starts with a deny prefix is denied, full stop; there was never a real exception to
  // this rule, and the code no longer pretends there might be one.
  for (const p of DENY_PREFIXES) if (method.startsWith(p)) return { allowed: false, kind: 'write', reason: `method starts with "${p}" and is treated as a mutation` };
  if (method === 'help' || method === 'uptime' || method === 'stop') {
    return method === 'stop'
      ? { allowed: false, kind: 'write', reason: 'stop shuts the node down; not exposed to the web UI' }
      : { allowed: true, kind: 'read' };
  }
  for (const p of ALLOW_PREFIXES) if (method.startsWith(p)) return { allowed: true, kind: 'read' };
  return { allowed: false, kind: 'unknown', reason: 'not recognised as a read-only method; add it to server/rpc/allowlist.js if this is wrong' };
}

// Methods Bitcoin Machine Code refuses (by design, or because the forked download worker owns
// what they would change). Surfaced so the UI can label a refusal as expected rather than as a
// monitor bug. RE-MEASURED 2026-09-18 against bmc run 26 and Core, not copied from the node's
// catalogue, which had fallen behind it (docs/MEASUREMENTS.md section 41):
//   * left the list: `getblockfilter` and `getmempoolcluster` answer on bmc as on Core;
//     `enumeratesigners` and `walletdisplayaddress` need `-signer` on bmc exactly as on Core,
//     so an error from them is Core's behaviour, not a bmc refusal;
//   * joined it: `getmemoryinfo`, whose default "stats" mode bmc refuses (it has no secure
//     allocator for those figures to describe); "mallocinfo" answers;
//   * stayed: no OpenRPC description (`getopenrpcinfo`, `rpc.discover`), no asmap (`exportasmap`),
//     no assumeutxo (`loadtxoutset`), and what the worker owns -- `pruneblockchain`,
//     `getblockfrompeer` (both refused live today), `preciousblock`, and `submitheader` for a header
//     the node does not already have (a known one answers null, as on Core).
export const NODE_REFUSES = new Set([
  'loadtxoutset', 'getopenrpcinfo', 'rpc.discover', 'exportasmap', 'getmemoryinfo',
  'getblockfrompeer', 'preciousblock', 'pruneblockchain', 'submitheader',
]);

export function allowlistSummary() {
  return {
    denyExactCount: DENY_EXACT.size,
    walletDenied: WALLET_METHODS.size,
    allowPrefixes: [...new Set(ALLOW_PREFIXES)].sort(),
    denyPrefixes: [...new Set(DENY_PREFIXES)].sort(),
    defaultDecision: 'deny',
  };
}

// Actions the operator can explicitly opt into. Each must appear in
// config.actions.allow to be reachable at all.
export const ACTIONS = {
  broadcast: {
    method: 'sendrawtransaction',
    label: 'Broadcast a raw transaction',
    role: 'operator',
    args: ['hexstring', 'maxfeerate?'],
    note: 'Pushes a signed transaction to the node, which relays it to every live peer leg. Irreversible once relayed.',
  },
  savemempool: {
    method: 'savemempool',
    label: 'Persist the mempool to mempool.dat',
    role: 'operator',
    args: [],
    note: 'Writes mempool.dat in Core\'s format. The node refuses if persistence is disabled.',
  },
  testmempoolaccept: {
    method: 'testmempoolaccept',
    label: 'Dry-run a transaction against mempool policy',
    role: 'viewer',
    args: ['rawtxs', 'maxfeerate?'],
    note: 'Runs the identical consensus and policy validation, stopping at the commit boundary. Accepts a package.',
  },
  verifychain_l1: {
    method: 'verifychain',
    label: 'Verify block data (checklevel <= 2)',
    role: 'admin',
    args: ['checklevel', 'checkdepth'],
    fixed: [2, 6],
    note: 'Levels 0-2 re-read and re-hash block data and check the merkle root. Levels 3-4 are refused by the node because they would disconnect and reconnect blocks.',
  },
};

export function actionAllowed(cfg, name, role) {
  const def = ACTIONS[name];
  if (!def) return { ok: false, reason: `unknown action "${name}"` };
  if (!cfg.actions.enabled) return { ok: false, reason: 'node actions are disabled (set BLOCKYARD_ENABLE_ACTIONS=1 and list BLOCKYARD_ACTIONS)' };
  // With accounts off there is no role to check, so the role gate below is vacuous
  // and every listed action would be reachable by whoever can open a socket. Writes
  // therefore need a second, explicit acknowledgement in open mode.
  if (!cfg.auth.enabled && !cfg.actions.allowWritesWithoutAuth) {
    return { ok: false, reason: 'accounts are off, so there is no identity to hold a node write accountable (enable BLOCKYARD_AUTH=1, or BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1 deliberately)' };
  }
  if (!cfg.actions.allow.includes(name)) return { ok: false, reason: `"${name}" is not in config.actions.allow` };
  const rank = { viewer: 0, operator: 1, admin: 2 };
  if ((rank[role] ?? -1) < (rank[def.role] ?? 99)) return { ok: false, reason: `action "${name}" needs role ${def.role}` };
  return { ok: true, def };
}
