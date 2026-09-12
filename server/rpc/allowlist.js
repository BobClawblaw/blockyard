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

// This node prefaces every command of its own with bmc* (the operator's rule,
// 2026-09-10; the same marker its bmc.* config keys carry, so a name Core does
// not have can never collide with one Core might later add). Those still have
// to earn a read classification: the marker plus a READ VERB is allowed, a
// bare "bmc" prefix is not. "bmc" alone would pre-authorise a future
// bmcsetban or bmcimportmempool -- exactly the hole this file's header warns
// about -- whereas bmcgetdownloadinfo matches bmcget and a bmcset* does not
// match anything and stays denied by default.
const ALLOW_PREFIXES = ['get', 'list', 'estimate', 'verify', 'estimat', 'help', 'uptime', 'decoderaw', 'decodescript', 'createraw', 'analyzepsbt', 'decodepsbt', 'convertbits', 'getrpcinfo',
  'bmcget', 'bmclist', 'bmcestimate', 'bmcverify'];

// Explicitly not allowed even though they look read-shaped: they build or sign
// transactions, which is a write in every way that matters.
const DENY_PREFIXES = ['generate', 'invalidate', 'reconsider', 'import', 'send', 'set', 'unload', 'load', 'sign',
  // the bmc* mutating shapes, named rather than left to default-deny
  'bmcset', 'bmcsend', 'bmcimport', 'bmcload', 'bmcsign', 'bmcgenerate', 'bmcinvalidate', 'bmcreconsider'];

export function classifyMethod(method) {
  if (typeof method !== 'string' || !method) return { allowed: false, kind: 'unknown', reason: 'method name must be a string' };
  if (DENY_EXACT.has(method)) return { allowed: false, kind: 'write-or-heavy', reason: 'this method mutates state or monopolises the node\'s single-threaded RPC server' };
  for (const p of DENY_PREFIXES) if (method.startsWith(p) && !ALLOW_PREFIXES.includes(method)) return { allowed: false, kind: 'write', reason: `method starts with "${p}" and is treated as a mutation` };
  if (method === 'help' || method === 'uptime' || method === 'stop') {
    return method === 'stop'
      ? { allowed: false, kind: 'write', reason: 'stop shuts the node down; not exposed to the web UI' }
      : { allowed: true, kind: 'read' };
  }
  for (const p of ALLOW_PREFIXES) if (method.startsWith(p)) return { allowed: true, kind: 'read' };
  return { allowed: false, kind: 'unknown', reason: 'not recognised as a read-only method; add it to server/rpc/allowlist.js if this is wrong' };
}

// Methods the node itself documents as refusing (or as needing the worker
// channel). Surfaced so the UI can label a refusal as expected rather than as a
// monitor bug. Lifted from docs/RPC_LIVE_NODE.md's refusal catalogue.
export const NODE_REFUSES = new Set([
  'loadtxoutset', 'getopenrpcinfo', 'rpc.discover', 'exportasmap', 'enumeratesigners',
  'walletdisplayaddress', 'getmempoolcluster', 'getblockfrompeer', 'preciousblock',
  'pruneblockchain', 'submitheader', 'getblockfilter',
]);

export function allowlistSummary() {
  return {
    denyExactCount: DENY_EXACT.size,
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
