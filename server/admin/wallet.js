// THE WALLET, READ-ONLY (docs/PLAN-ADMIN-SUITE.md, M2).
//
// Balances, UTXOs, history, labels. Nothing here changes anything: every call goes through
// the `wallet.read` capability of server/rpc/admin-allowlist.js, which contains no method
// that writes, derives or unlocks. M3 adds receive and M4 adds send, each in its own file
// and its own capability, so "what can this screen do" stays answerable by reading one
// import line.
//
// PER-WALLET OPT-IN is enforced here rather than trusted to the node (plan §2.5). The node
// will happily list and load every wallet it has; `admin.wallets` is the operator's list
// of the ones this web interface may touch, and a name not on it is refused before any RPC
// is made -- not filtered out of the answer afterwards, which would still have asked.
import { adminCallAllowed } from '../rpc/admin-allowlist.js';

/** The suite's refusal shape; the route layer turns it into a 403. */
function deny(message, code = 'admin-refused', status = 403) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

/** The ids of the configured nodes, in the operator's order. */
function nodeIds(app) {
  if (app.monitors?.size) return [...app.monitors.keys()];
  return (app.cfg?.nodes ?? []).map((n) => n.id);
}

/**
 * The wallets this monitor may touch, as `{ node, wallet }` pairs, in the operator's order.
 *
 * A WALLET NAME IS NOT AN IDENTITY ACROSS NODES (operator, 2026-09-19). Two nodes can each
 * have a wallet called "hot", and they are different wallets holding different coins; an
 * opt-in list of bare names opted in every node's "hot" at once, including a node added to
 * the config later for watching only. So an entry names its node:
 * `{ "node": "<node id>", "wallet": "<name>" }`. A bare string is still read when exactly
 * one node is configured -- there it can mean only one thing, and every config written
 * before this date is that shape -- and otherwise comes back with `node: null`, which
 * requireNamedWallet refuses with the sentence that fixes it. It is refused at USE rather
 * than at boot so that adding a second node to a working install does not stop the
 * monitor from starting; it only stops the wallet screens until the entry is rewritten.
 */
export function namedWallets(app) {
  const ids = nodeIds(app);
  const only = ids.length === 1 ? ids[0] : null;
  return (app.cfg.admin?.wallets ?? []).map((e) => (typeof e === 'string'
    ? { node: only, wallet: e }
    : { node: e?.node ?? null, wallet: e?.wallet ?? null })).filter((e) => typeof e.wallet === 'string' && e.wallet.length);
}

/** The wallet names opted in on one node -- every one of them, for the paste box. */
export function walletsOnNode(app, node) {
  return namedWallets(app).filter((e) => e.node === node).map((e) => e.wallet);
}

/**
 * Check a (node, wallet) pair against the opt-in list and return it, or refuse.
 *
 * The comparison is exact. No prefix matching, no normalisation, no "close enough": a
 * wallet name is a path component on the node, and a suite that guesses which wallet you
 * meant is a suite that eventually guesses wrong about which wallet it is spending from.
 * The PAIR is checked, not the name: "cold" named for one node is no permission on another.
 */
export function requireNamedWallet(app, node, wallet) {
  const entries = namedWallets(app);
  if (!entries.length) {
    deny('no wallet is named in admin.wallets, so no wallet is reachable from the web interface', 'no-wallets');
  }
  if (typeof wallet !== 'string' || !wallet.length) deny('name the wallet', 'wallet-required');
  if (typeof node !== 'string' || !node.length) {
    deny(`name the node as well as the wallet: ${nodeIds(app).length} nodes are configured`, 'node-required');
  }
  if (entries.some((e) => e.node === node && e.wallet === wallet)) return { node, wallet };
  if (entries.some((e) => e.node == null && e.wallet === wallet)) {
    deny(`admin.wallets names "${wallet}" without saying which node it is on, and ${nodeIds(app).length} nodes are `
      + `configured. Write the entry as { "node": "<node id>", "wallet": "${wallet}" } in config/local.json and restart.`,
    'wallet-node-unnamed');
  }
  const list = entries.map((e) => `${e.wallet} on ${e.node ?? '(no node named)'}`).join(', ');
  deny(`"${wallet}" on node ${node} is not in admin.wallets (${list}), so this interface will not touch it`, 'wallet-not-named');
  return null;
}

/**
 * The node a request means when it did not say: the only one, or none.
 *
 * With one node configured there is nothing to choose between. With several, an omitted
 * node is refused by requireNamedWallet rather than defaulted to the first -- the first
 * node in a config file is an accident of editing, not a decision about money.
 */
export function defaultNode(app) {
  const ids = nodeIds(app);
  return ids.length === 1 ? ids[0] : null;
}

/** The person must hold the grant, whatever their role (plan §2.4). */
export function requireWalletAccess(app, user) {
  const rec = user?.username ? app.users?.find?.(user.username) : null;
  if (!rec?.walletAccess) {
    deny('your account does not have wallet access; an administrator grants it per account, and being an administrator is not enough on its own', 'wallet-access-required');
  }
  return true;
}

/**
 * One RPC call, checked against the capability list, addressed to one wallet.
 *
 * Bitcoin Core addresses a wallet by URL path (`/wallet/<name>`), which is why this takes
 * the name rather than letting a caller pass it in the arguments -- there is exactly one
 * place that decides which wallet a call lands on, and it is this function.
 *
 * `rpc` passes lane options through (priority, maxWaitMs, ignoreBreaker); only the relock
 * below uses it, and why is written there.
 */
export async function walletCall(app, { node, wallet, capability, method, args = [], rpc = {} }) {
  const verdict = adminCallAllowed(capability, method, args);
  if (!verdict.ok) deny(verdict.why, 'method-not-allowed');
  const m = app.monitors.get(node);
  if (!m) deny(`no such node: ${node}`, 'no-such-node');
  // The wallet is addressed by URL path, per call, through the shared client -- see the
  // `walletPath` note in server/rpc/client.js. Encoded, because a wallet name is a path
  // component and Core allows names this monitor must not paste raw into a URL.
  const walletPath = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '';
  // adminAuthorized: the one flag RpcClient's batch() requires before a WALLET_METHODS call is
  // allowed to leave the process at all (audit 2026-09-22, M1) -- set here, and only here, because
  // this line is only reached after adminCallAllowed(capability, method, args) has already said yes.
  return m.rpc.call(method, args, { ...rpc, walletPath, adminAuthorized: true });
}

/**
 * Sats from a BTC figure, exactly: Core speaks BTC, this suite counts sats.
 *
 * NUMBERS GO THROUGH toFixed(8), STRINGS THROUGH THEIR DIGITS. Core prints 0.00000011, and
 * JSON.parse makes that the number 1.1e-7, whose String() is "1.1e-7" -- the first version
 * of this function split that on the dot and handed "1e-7"'s pieces to BigInt, which threw
 * (review, 2026-09-19). Every amount under 0.000001 BTC takes that form, and fees under
 * 100 sat are ordinary at 0.1 sat/vB relay, so this was a crash on a normal transaction.
 * toFixed(8) of a double is exact to the satoshi for |x| < 2^53 / 1e8, about 9e7 BTC --
 * four times all the bitcoin there will be -- and it is also what makes 0.1 + 0.2 come out
 * as 30,000,000 rather than 30,000,000.000000004. A string is parsed digit by digit,
 * exponent included, and never goes through a float at all.
 */
export function toSats(btc) {
  if (btc == null) return null;
  const bad = () => { const e = new Error(`not an amount: ${String(btc).slice(0, 40)}`); e.status = 502; e.code = 'amount-unreadable'; throw e; };
  let text;
  if (typeof btc === 'number') {
    if (!Number.isFinite(btc)) bad();
    text = btc.toFixed(8);
  } else {
    text = String(btc).trim();
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!m || !((m[2] ?? '') + (m[3] ?? '')).length) bad();
  const [, sign, whole = '', frac = '', exp = '0'] = m;
  // The digits as one integer, and how far to move the point to land on satoshis.
  const shift = 8 - frac.length + Number(exp);
  let v = BigInt((whole + frac) || '0');
  // Truncating below a satoshi, as the string version always did; Core never prints one.
  v = shift >= 0 ? v * 10n ** BigInt(shift) : v / 10n ** BigInt(-shift);
  return Number(sign === '-' ? -v : v);
}

// ONE SIGNING OPERATION AT A TIME PER WALLET (operator, 2026-09-19). An unlock is a state
// of the WALLET, not of the request that typed the passphrase: while session A's confirm
// has the wallet unlocked for 30 seconds, session B's confirm could sign with that unlock
// without ever knowing the passphrase. So everything between an unlock and its relock --
// and every broadcast of the wallet's coins, since the cap reservation and the coin checks
// belong to it -- runs under a per-(node, wallet) lock, and the passphrase is required of
// every request that takes it. In memory: one BlockYard process is one set of locks, and a
// signer outside this process (a terminal) is outside any lock this file could hold.
const walletLocks = new Map(); // "node\u0000wallet" -> promise that settles when the holder is done

/**
 * Run `fn` holding the lock of every (node, wallet) pair in `pairs`.
 *
 * Several pairs are taken in sorted order, so two callers wanting overlapping sets cannot
 * each hold one and wait for the other.
 */
export async function withWalletLock(pairs, fn) {
  const keys = [...new Set(pairs.map(([n, w]) => `${n}\u0000${w}`))].sort();
  const releases = [];
  try {
    for (const key of keys) {
      const before = walletLocks.get(key) ?? Promise.resolve();
      let release;
      const mine = new Promise((r) => { release = r; });
      const chained = before.then(() => mine);
      walletLocks.set(key, chained);
      releases.push(() => { release(); if (walletLocks.get(key) === chained) walletLocks.delete(key); });
      await before;
    }
    return await fn();
  } finally {
    for (const r of releases.reverse()) r();
  }
}

/** Is this wallet encrypted? Core reports `unlocked_until` only for one that is. */
export async function walletEncrypted(app, { node, wallet }) {
  const info = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getwalletinfo' });
  return info?.unlocked_until !== undefined;
}

/** The refusal for an encrypted wallet and no passphrase, in one place. */
export function requirePassphrase(passphrase, wallet) {
  if (passphrase == null || !String(passphrase).length) {
    deny(`the wallet "${wallet}" is encrypted, so this needs its passphrase -- every time, even if the wallet `
      + 'happens to be unlocked already: somebody else\'s unlock is not your authorisation', 'passphrase-required', 400);
  }
}

/**
 * Lock the wallet again, and mean it.
 *
 * THE ONE CALL THAT MUST NOT BE DROPPED. Every other call in this suite goes through the
 * node's shared lane like a poll does, and the lane is built to give up: a call that waited
 * past its freshness budget is dropped as stale, and while the breaker is open nothing is
 * sent at all. Both are right for "what is the mempool now" and wrong for "lock the wallet
 * I just unlocked" -- the review of 2026-09-19 found a relock that a breaker opened by a
 * slow poll would have refused, leaving the wallet open for the rest of its 30 seconds. So
 * this goes at the front of the queue (priority 0), waits as long as it takes (two
 * minutes), passes an open breaker (`ignoreBreaker`, which exists for this call), and is
 * tried three times. If all of that fails the unlock still expires on its own timeout,
 * which is why that timeout is 30 seconds rather than a session.
 */
export async function relockWallet(app, { node, wallet, what = 'an action' }) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await walletCall(app, {
        node, wallet, capability: 'wallet.spend', method: 'walletlock', args: [],
        rpc: { priority: 0, maxWaitMs: 120_000, ignoreBreaker: true },
      });
      return true;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  app.log?.({ level: 'error', msg: `admin: the wallet "${wallet}" on ${node} could not be re-locked after ${what} (three tries): ${last?.message}; its unlock expires by itself within 30 s` });
  return false;
}

/**
 * Prove the passphrase without leaving the wallet open: unlock, then relock at once.
 *
 * For the paste box, whose transaction is already signed and needs no key -- the operator
 * chose (2026-09-19) that broadcasting this wallet's coins asks for the same passphrase a
 * send does, so a stolen session plus a transaction signed elsewhere is still not a spend.
 * The caller holds the wallet's lock.
 */
export async function verifyPassphrase(app, { node, wallet, passphrase }) {
  let unlocked = false;
  try {
    // Set BEFORE the await: if the answer is lost after Core unlocked, the finally below
    // must still lock. A walletlock on a locked wallet is harmless.
    unlocked = true;
    await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletpassphrase', args: [String(passphrase), 5] });
  } catch (err) {
    // -14 is Core's "The wallet passphrase entered was incorrect".
    if (err.code === -14) deny(`that is not the passphrase of the wallet "${wallet}"`, 'passphrase-wrong');
    throw err;
  } finally {
    if (unlocked) await relockWallet(app, { node, wallet, what: 'checking the passphrase' });
  }
}

/**
 * The wallet overview: what it is, what it holds, and what it can answer.
 *
 * Deliberately one call per figure rather than one screen-shaped RPC: each is in the
 * capability list by name, and a future screen that wants more has to add its method
 * there rather than widening an existing call.
 */
export async function walletOverview(app, { node, wallet }) {
  const info = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getwalletinfo' });
  const balances = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getbalances' });
  const mine = balances?.mine ?? {};
  return {
    wallet,
    node,
    // `private_keys_enabled: false` is a watch-only wallet: it can never spend whatever
    // the rest of this suite allows, and the UI says so rather than offering a Send
    // button that would fail at the last step.
    canSpend: info?.private_keys_enabled !== false,
    // An encrypted wallet has an unlock step; an unencrypted one does not, and that is a
    // fact worth showing rather than discovering at the confirm screen.
    encrypted: info?.unlocked_until !== undefined,
    unlockedUntil: info?.unlocked_until ?? null,
    descriptors: info?.descriptors ?? null,
    blocks: info?.lastprocessedblock?.height ?? null,
    balances: {
      trustedSat: toSats(mine.trusted ?? 0),
      untrustedPendingSat: toSats(mine.untrusted_pending ?? 0),
      immatureSat: toSats(mine.immature ?? 0),
      totalSat: toSats(mine.trusted ?? 0) + toSats(mine.untrusted_pending ?? 0) + toSats(mine.immature ?? 0),
    },
    // Scanning means every number above is provisional, and a page that does not say so
    // invites someone to conclude their coins are gone.
    scanning: info?.scanning && info.scanning !== false ? info.scanning : null,
  };
}

/** Spendable outputs, newest first, with what a coin-control screen needs. */
export async function walletUtxos(app, { node, wallet, minconf = 0 }) {
  const rows = await walletCall(app, {
    node, wallet, capability: 'wallet.read', method: 'listunspent', args: [Number(minconf) || 0],
  });
  return (rows ?? []).map((u) => ({
    txid: u.txid,
    vout: u.vout,
    address: u.address ?? null,
    label: u.label ?? null,
    amountSat: toSats(u.amount),
    confirmations: u.confirmations ?? 0,
    spendable: Boolean(u.spendable),
    solvable: Boolean(u.solvable),
    // Core marks what it cannot sign for; a UTXO that is not `safe` must not be silently
    // included in a coin-control default selection.
    safe: u.safe !== false,
  })).sort((a, b) => a.confirmations - b.confirmations);
}

/** Recent history, mapped to the fields a list needs and nothing more. */
export async function walletHistory(app, { node, wallet, count = 50, skip = 0 }) {
  const rows = await walletCall(app, {
    node, wallet, capability: 'wallet.read', method: 'listtransactions',
    args: ['*', Math.min(Number(count) || 50, 200), Number(skip) || 0],
  });
  return (rows ?? []).map((t) => ({
    txid: t.txid,
    category: t.category,
    address: t.address ?? null,
    label: t.label ?? null,
    amountSat: toSats(t.amount),
    feeSat: t.fee == null ? null : toSats(t.fee),
    confirmations: t.confirmations ?? 0,
    time: (t.time ?? 0) * 1000,
    // A replaceable transaction that is still unconfirmed is the one a fee-bump screen
    // acts on, so the flag travels with the row rather than being fetched again.
    bip125Replaceable: t['bip125-replaceable'] ?? 'unknown',
    abandoned: Boolean(t.abandoned),
  })).reverse();
}

/**
 * Descriptors, PUBLIC ONLY.
 *
 * `listdescriptors true` returns xprvs. The argument is not passed here and the allowlist
 * refuses it if it ever were, so there is no path through this suite that reaches a
 * private descriptor -- see server/rpc/admin-allowlist.js.
 */
export async function walletDescriptors(app, { node, wallet }) {
  const out = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'listdescriptors' });
  return {
    wallet: out?.wallet_name ?? wallet,
    descriptors: (out?.descriptors ?? []).map((d) => ({
      desc: d.desc, active: Boolean(d.active), internal: Boolean(d.internal),
      range: d.range ?? null, next: d.next ?? null, timestamp: d.timestamp ?? null,
    })),
  };
}

/** Labels, and the addresses under each. */
export async function walletLabels(app, { node, wallet }) {
  const labels = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'listlabels' });
  const out = [];
  for (const label of labels ?? []) {
    const addresses = await walletCall(app, {
      node, wallet, capability: 'wallet.read', method: 'getaddressesbylabel', args: [label],
    });
    out.push({ label, addresses: Object.keys(addresses ?? {}) });
  }
  return out;
}

/**
 * One transaction, in full: what the wallet knows plus what the raw transaction says.
 *
 * `gettransaction` with verbose gives the decoded body in the same call, so the inputs and
 * outputs come back without a second round trip. Each output is checked against the wallet
 * so the detail view can say which of them are YOURS -- the difference between "this paid
 * out 1 BTC" and "this paid out 1 BTC and 48 came back as change" is the whole meaning of
 * the row, and a list of outputs without it invites the wrong reading.
 */
export async function walletTransaction(app, { node, wallet, txid }) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txid ?? ''))) {
    const err = new Error('that is not a transaction id');
    err.status = 400; err.code = 'txid-invalid';
    throw err;
  }
  const tx = await walletCall(app, {
    node, wallet, capability: 'wallet.read', method: 'gettransaction', args: [txid, true, true],
  });
  const decoded = tx?.decoded ?? null;

  const outputs = [];
  for (const v of decoded?.vout ?? []) {
    const address = v.scriptPubKey?.address ?? null;
    let mine = false;
    if (address) {
      const info = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getaddressinfo', args: [address] })
        .catch(() => null);
      mine = Boolean(info?.ismine);
    }
    outputs.push({ n: v.n, address, type: v.scriptPubKey?.type ?? null, amountSat: toSats(v.value), mine });
  }

  return {
    txid,
    wallet,
    amountSat: toSats(tx?.amount ?? 0),
    feeSat: tx?.fee == null ? null : toSats(tx.fee),
    confirmations: tx?.confirmations ?? 0,
    blockHash: tx?.blockhash ?? null,
    blockHeight: tx?.blockheight ?? null,
    blockTime: tx?.blocktime ? tx.blocktime * 1000 : null,
    time: (tx?.time ?? 0) * 1000,
    receivedTime: (tx?.timereceived ?? 0) * 1000,
    replaceable: tx?.['bip125-replaceable'] ?? 'unknown',
    // Per-address rows as the WALLET sees them: this is where a send and its change both
    // show up, each with its own category.
    details: (tx?.details ?? []).map((d) => ({
      address: d.address ?? null, category: d.category, amountSat: toSats(d.amount),
      label: d.label ?? null, vout: d.vout, feeSat: d.fee == null ? null : toSats(d.fee),
      abandoned: Boolean(d.abandoned),
    })),
    inputs: (decoded?.vin ?? []).map((v) => ({ txid: v.txid ?? null, vout: v.vout ?? null, sequence: v.sequence ?? null, coinbase: Boolean(v.coinbase) })),
    outputs,
    vsize: decoded?.vsize ?? null,
    weight: decoded?.weight ?? null,
    version: decoded?.version ?? null,
    locktime: decoded?.locktime ?? null,
    feeRateSatPerVb: tx?.fee != null && decoded?.vsize ? Math.round((Math.abs(toSats(tx.fee)) / decoded.vsize) * 100) / 100 : null,
    // The raw transaction, for pasting somewhere else. It is public data -- it is on the
    // chain or in a mempool -- so there is nothing here to withhold.
    hex: tx?.hex ?? null,
  };
}
