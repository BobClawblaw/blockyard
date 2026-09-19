// SEND (docs/PLAN-ADMIN-SUITE.md, M4). The milestone that moves money.
//
// The shape is two steps, and the second one acts on what the FIRST one built:
//
//   build    walletcreatefundedpsbt -> decode it -> return what the node will actually do
//   confirm  elevate (consuming) -> unlock -> sign -> test -> broadcast -> lock
//
// WHY TWO STEPS AND NOT ONE. The confirmation screen must show the destination, amount and
// fee of the transaction that will be broadcast, not of the form that was submitted. Those
// differ more often than people expect: the node picks the inputs, computes the fee, and
// adds a change output, and a suite that echoes the form back is asking the operator to
// confirm their own typing rather than the node's work. So `build` stores the PSBT server
// side and hands back a build id; `confirm` signs THAT PSBT and nothing else. A malicious
// page that wants to change the destination between the two steps has to produce a build
// id it cannot forge, for a build it cannot see.
//
// WHAT HAS TO BE TRUE BEFORE ANY OF IT RUNS, every one enforced here rather than assumed
// from the route being reachable:
//
//   - the suite loaded at all (edition + gate chain, server/admin-gate.js)
//   - this account holds walletAccess (not merely the admin role)
//   - the wallet is named in admin.wallets
//   - a spend cap is CONFIGURED -- with none, every send is refused (operator's choice at
//     scoping: the size of the largest possible mistake should be a decision somebody made)
//   - this transaction is within the per-send cap and the rolling 24h cap
//   - the destination is in admin.addressBook, or the operator typed the confirmation phrase
//   - on mainnet, the phrase is a different sentence from the one used on test networks
//   - the session is elevated, and confirming CONSUMES that elevation: one password, one
//     spend
//   - an encrypted wallet's passphrase is typed for THIS spend, even if the wallet happens
//     to be unlocked already, and only one signing operation runs per wallet at a time
//
// AND WHAT THE REVIEW OF 2026-09-19 ADDED, each found by reading this file and then
// reproduced against a regtest Core (test/admin-money-regtest.test.js):
//
//   - the rolling cap is checked AND reserved in one synchronous step. It was checked,
//     then five awaits later recorded, and two sessions confirming at once both passed:
//     305,640 sat out under a 250,000 sat cap.
//   - a build locks the coins it chose (lockunspent, in memory), and confirm checks they
//     are still unspent. Without that a second build chose the same coin at a higher fee
//     and, confirmed after the first was reported sent, REPLACED it.
//   - the txid is known before the broadcast, and written to the audit trail before it,
//     so a broadcast whose answer is lost is reported as "may have been broadcast: <txid>"
//     rather than as a failure the operator would retry.
import crypto from 'node:crypto';
import {
  walletCall, toSats, requireNamedWallet, withWalletLock, walletEncrypted, requirePassphrase, relockWallet,
} from './wallet.js';
import { requireElevation } from './elevation.js';

function deny(message, code = 'admin-refused', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

// Builds waiting for confirmation. In memory, short lived, keyed by an unguessable id and
// bound to the session that made them: a build is not a thing another tab can pick up.
const pending = new Map(); // id -> { at, sessionId, wallet, node, psbt, summary, coins, app }
const BUILD_TTL_MS = 10 * 60_000;

function sweep(now = Date.now()) {
  for (const [id, b] of pending) {
    if (now - b.at > BUILD_TTL_MS) {
      pending.delete(id);
      // An expired build gives its coins back. Not awaited: sweep runs on the way into
      // other requests, and a relock that fails leaves a coin held until the node
      // restarts, which is the safe direction.
      releaseCoins(b.app, b).catch(() => {});
    }
  }
}

/** Test seam. */
export function __resetPending() { pending.clear(); }

/**
 * Give a build's coins back to the wallet's coin selection.
 *
 * Core refuses the whole call if any one outpoint is no longer unspent ("expected unspent
 * output") -- and a coin spent by a wallet transaction is unlocked by Core itself, measured
 * on v31.1 -- so a refusal is retried one coin at a time and the spent ones are let go.
 */
async function releaseCoins(app, build) {
  const coins = build?.coins ?? [];
  if (!app || !coins.length) return;
  const unlock = (list) => walletCall(app, {
    node: build.node, wallet: build.wallet, capability: 'wallet.spend', method: 'lockunspent', args: [true, list],
  });
  try { await unlock(coins); } catch {
    for (const c of coins) await unlock([c]).catch(() => {});
  }
}

/**
 * Spends made or in flight, for the rolling cap. In memory: a restart forgives the window.
 *
 * An entry is pushed by reserveSpend at the moment the cap is checked, before anything is
 * awaited, and marked kept once the transaction went out (or may have). A reservation that
 * fails before the broadcast is removed again.
 */
const spent = []; // { at, sat, pending }

function spentIn24h(now = Date.now()) {
  const cutoff = now - 24 * 3600_000;
  while (spent.length && spent[0].at < cutoff) spent.shift();
  return spent.reduce((n, s) => n + s.sat, 0);
}

export function __resetSpent() { spent.length = 0; }

/** For a broadcast that spends nothing of ours: nothing to reserve, nothing to release. */
export const NO_RESERVATION = Object.freeze({ sat: 0, kept: true, keep() {}, release() {} });

/**
 * Check the caps and RESERVE the amount, in one synchronous step.
 *
 * The step being synchronous is the whole point: JavaScript runs nothing else between the
 * check and the push, so a second confirm arriving while the first is still talking to the
 * node sees the first one's sats already counted. Every money-moving path uses this -- the
 * Send screen, the paste box and the fee bumper -- because a rolling cap that only counted
 * one of them would be a cap with two doors beside it (server/admin/txtools.js).
 *
 *   release()  the attempt failed BEFORE anything was broadcast: the sats never left.
 *   keep()     it went out, or may have (a broadcast whose answer was lost): they count.
 *
 * Once kept, a reservation stays kept; release() after keep() does nothing.
 */
export function reserveSpend(app, { sendingSat, feeSat }, now = Date.now()) {
  checkCaps(app, { sendingSat, feeSat }, now);
  const entry = { at: now, sat: sendingSat + feeSat, pending: true };
  spent.push(entry);
  const r = {
    sat: entry.sat,
    kept: false,
    keep() { if (!r.settled) { r.settled = true; r.kept = true; entry.pending = false; } },
    release() {
      if (r.settled) return;
      r.settled = true;
      const i = spent.indexOf(entry);
      if (i >= 0) spent.splice(i, 1);
    },
    settled: false,
  };
  return r;
}

/**
 * An amount in satoshis, from something a browser sent.
 *
 * Refuses anything that is not a whole number of satoshis, including the float that
 * "0.1 + 0.2" produces and the string that looks like a number but carries a space. The
 * suite counts in sats everywhere and converts once, at the edge, for Core.
 */
export function checkAmountSat(raw) {
  // No trim: a padded string is refused rather than quietly accepted. An amount is the
  // one field where "I think I know what you meant" is not a service.
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) deny('the amount must be a whole number of satoshis, with no spaces', 'amount-invalid');
  const sat = Number(raw);
  if (!Number.isInteger(sat)) deny('the amount must be a whole number of satoshis', 'amount-invalid');
  if (sat <= 0) deny('the amount must be more than zero', 'amount-invalid');
  if (sat > 21_000_000 * 100_000_000) deny('that is more than there will ever be', 'amount-invalid');
  // Below the dust threshold Core will refuse anyway; saying so here costs a round trip
  // less and names the number.
  if (sat < 294) deny('that is below the dust threshold (294 sat), and the node would refuse it', 'amount-dust');
  return sat;
}

/** Sats -> the BTC decimal string Core wants, without going through a float. */
export function satToBtcString(sat) {
  const neg = sat < 0;
  const s = String(Math.abs(sat)).padStart(9, '0');
  const out = `${s.slice(0, -8)}.${s.slice(-8)}`;
  return neg ? `-${out}` : out;
}

/** A destination this suite is willing to put in a transaction. */
export function checkAddress(raw) {
  const address = String(raw ?? '').trim();
  // Deliberately a shape check, not a validity check: the NODE decides whether an address
  // is valid and on the right network, and it does so with the same code that will spend
  // to it. A regex here that thought it knew better would be a second opinion that can be
  // wrong in exactly the way that loses money.
  if (!/^[a-zA-Z0-9]{14,120}$/.test(address)) deny('that does not look like an address', 'address-invalid');
  return address;
}

/** Is this destination one the operator has named? */
export function inAddressBook(app, address) {
  return (app.cfg.admin?.addressBook ?? []).some((e) => (typeof e === 'string' ? e : e?.address) === address);
}

/**
 * The address book, as a list a screen can show.
 *
 * Entries may be a bare string or `{ address, label }`; both spellings are accepted
 * because an operator editing JSON by hand will write whichever is shorter, and refusing
 * one of them would be a rule with no purpose behind it.
 *
 * READ-ONLY FROM THE WEB, and the payload says so rather than leaving a screen to discover
 * it at the first save. It lives in the `admin` block, which this suite cannot write
 * (server/admin/config-edit.js): an interface that could add its own destination could skip
 * the typed confirmation that not being in this list requires.
 */
export function addressBook(app) {
  const raw = app.cfg.admin?.addressBook ?? [];
  return {
    entries: raw.map((e) => (typeof e === 'string'
      ? { address: e, label: null }
      : { address: e?.address ?? null, label: e?.label ?? null })).filter((e) => e.address),
    editable: false,
    note: 'The address book is part of the admin block, which the web interface cannot write. '
      + 'Add entries in config/local.json and restart. A destination that is NOT in this list still works '
      + 'it just asks you to type a confirmation phrase first.',
  };
}

/**
 * The phrase the operator must type for a destination outside the address book.
 *
 * Different on mainnet, deliberately (operator's choice at scoping): muscle memory from a
 * test network should not carry over to the network where it is real. That difference is
 * `admin.spend.mainnetPhrase`, default true. It was shown in the status route and read by
 * nothing until the review of 2026-09-19; set false, mainnet asks for "send on main" in the
 * same shape as every other network.
 */
export function confirmationPhrase(chain, { addressBook = false, mainnetPhrase = true } = {}) {
  if (addressBook) return null;
  return chain === 'main' && mainnetPhrase ? 'SEND REAL BITCOIN' : `send on ${chain}`;
}

/** The phrase for this monitor's config: confirmationPhrase with the setting applied. */
export function phraseFor(app, chain, { addressBook = false } = {}) {
  return confirmationPhrase(chain, { addressBook, mainnetPhrase: app.cfg.admin?.spend?.mainnetPhrase !== false });
}

/**
 * Which chain the node is on, asked of the node.
 *
 * Not the monitor's cached chainInfo, and never the config's chainHint: the cache is empty
 * until the first poll lands and the hint is whatever the operator typed, and the answer
 * decides whether the operator is asked for the MAINNET sentence. Before 2026-09-19 a node
 * whose poll had not landed fell through to chainHint, and then to 'main' -- right by
 * accident on mainnet, wrong on every other network, and a guess either way.
 */
export async function chainOf(app, node) {
  const info = await walletCall(app, { node, wallet: null, capability: 'wallet.read', method: 'getblockchaininfo' });
  if (typeof info?.chain !== 'string' || !info.chain) deny('the node did not say which chain it is on', 'chain-unknown', 502);
  return info.chain;
}

/**
 * A fee rate in sat/vB from something a browser sent, or null for "the node's choice".
 *
 * Number(undefined) is NaN and NaN compares false with everything, so a check written as
 * `rate <= 0` let NaN through to arithmetic that then produced NaN fees (review,
 * 2026-09-19). Finite and positive, or refused.
 */
export function checkFeeRate(raw) {
  if (raw == null) return null;
  const n = typeof raw === 'string' && !raw.trim() ? NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) deny('the fee rate must be a positive number of sat/vB', 'fee-rate-invalid');
  return n;
}

/**
 * Take the elevation for an irreversible step, re-checking it as it is taken.
 *
 * ctx.consumeElevation is set by the route wrapper (server/admin/index.js) and itself calls
 * requireElevation({ consume: true }), so a second request riding the same elevation throws
 * here rather than proceeding; the fallback is for a caller outside a route.
 */
export function consumeElevation(ctx, what) {
  if (typeof ctx.consumeElevation === 'function') return ctx.consumeElevation();
  return requireElevation(ctx, { consume: true, what });
}

/**
 * Is this transaction on the node now? Asked after a broadcast whose answer was lost.
 *
 * The mempool first, then the wallet (which also knows a transaction that has already been
 * mined). Either failing to answer is "cannot tell", which the caller reports as such.
 */
async function seenByNode(app, { node, wallet, txid }) {
  const fast = { priority: 0, maxWaitMs: 60_000 };
  try {
    await walletCall(app, { node, wallet: null, capability: 'wallet.read', method: 'getmempoolentry', args: [txid], rpc: fast });
    return true;
  } catch { /* not in the mempool, or no answer */ }
  if (!wallet) return false;
  try {
    const tx = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'gettransaction', args: [txid], rpc: fast });
    return Boolean(tx?.txid);
  } catch { return false; }
}

/**
 * Broadcast a finished transaction whose txid is already known, and settle the reservation.
 *
 * THE SHAPE, and why each step is where it is:
 *
 *   1. an `*-attempt` audit record, with the txid, BEFORE the broadcast. If this process
 *      dies between the broadcast and the answer, the trail still says what may have gone.
 *      If the audit write fails here, nothing has been broadcast and the caller releases.
 *   2. sendrawtransaction. A refusal from Core (an `rpc` error), an open breaker or a stale
 *      drop means it was not sent. A timeout, a reset socket or an unreadable answer means
 *      it MAY have been: Core can accept a transaction and the answer still not arrive.
 *   3. on "may have": the reservation is KEPT, the node is asked whether it has the txid,
 *      and if it cannot say so the operator is told "may have been broadcast: <txid>" --
 *      not "failed", which is an invitation to send it again.
 *   4. the done record. If THAT write fails the money has already moved, so the failure is
 *      logged and the txid is returned anyway: an operator told "error" after a successful
 *      spend is an operator who spends twice.
 */
export async function broadcastSettled(app, ctx, { node, wallet, hex, txid, reservation, attempt, done }) {
  await app.audit({ ...attempt, username: ctx.user?.username ?? null, node, txid });
  let answer;
  try {
    answer = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'sendrawtransaction', args: [hex] });
  } catch (err) {
    // `auth` is a 401: Core refused the request before running it. No `kind` at all is
    // this suite's own refusal, thrown before anything was sent.
    const definite = !err.kind || ['rpc', 'breaker', 'stale', 'auth'].includes(err.kind);
    if (definite) throw err;
    reservation.keep();
    if (await seenByNode(app, { node, wallet, txid })) {
      answer = txid;
    } else {
      await app.audit({ ...attempt, type: `${attempt.type.replace(/-attempt$/, '')}-uncertain`, username: ctx.user?.username ?? null, node, txid, error: String(err.message ?? '').slice(0, 160) })
        .catch(() => {});
      deny(`the node did not answer the broadcast (${err.message}), and the transaction may have been broadcast: ${txid}. `
        + 'Look for that txid before sending again. It counts against the spend caps until the window passes.',
      'broadcast-uncertain', 502);
    }
  }
  reservation.keep();
  const sent = typeof answer === 'string' && answer ? answer : txid;
  try {
    await app.audit({ ...done, username: ctx.user?.username ?? null, node, txid: sent });
  } catch (err) {
    app.log?.({ level: 'error', msg: `admin: ${done.type} ${sent} went out but its audit record could not be written: ${err.message}` });
  }
  return sent;
}

/** Cap checks, against the BUILT transaction rather than the requested amount. */
export function checkCaps(app, { sendingSat, feeSat }, now = Date.now()) {
  const cap = app.cfg.admin?.spend?.capSat ?? null;
  if (cap == null) {
    deny('no spend cap is configured, so this interface will not send anything. Set admin.spend.capSat '
      + '(and optionally capSat24h) on disk -- the size of the largest possible mistake is a decision to make '
      + 'deliberately rather than discover', 'no-spend-cap', 403);
  }
  const total = sendingSat + feeSat;
  if (total > cap) {
    deny(`this send is ${total} sat including fee, over the cap of ${cap} sat (admin.spend.capSat)`, 'over-cap', 403);
  }
  const cap24 = app.cfg.admin?.spend?.capSat24h ?? null;
  if (cap24 != null) {
    const already = spentIn24h(now);
    if (already + total > cap24) {
      deny(`this send would take the last 24 hours to ${already + total} sat, over the rolling cap of ${cap24} sat `
        + `(admin.spend.capSat24h); ${already} sat has already gone out`, 'over-cap-24h', 403);
    }
  }
  return { cap, cap24, spent24h: spentIn24h(now) };
}

/**
 * Step one: ask the node to build the transaction, and describe what it built.
 *
 * Nothing is signed here and nothing can leave: `walletcreatefundedpsbt` neither unlocks
 * the wallet nor touches a key. The wallet does not even have to be unlocked yet.
 *
 * The coins it chose are LOCKED in the wallet until the build is confirmed, cancelled or
 * expires. Without that (review, 2026-09-19, reproduced on regtest) a second build made
 * while the first was pending chose the same coin -- the node had no reason not to -- and
 * because builds are replaceable, confirming it after the first was reported sent quietly
 * REPLACED the first: "sent" on the screen, gone from the mempool. The lock is Core's own
 * (`lockunspent`, in memory, never written to the wallet file), so coin selection skips
 * the coin by itself. A restart of BlockYard forgets its builds but not Core's locks; those
 * last until the node restarts or the coin is unlocked at a terminal, which holds coins
 * rather than spending them, the safe way round.
 */
export async function buildSpend(app, ctx, { node, wallet, address, amountSat, feeRate = null, subtractFee = false, inputs = null }) {
  sweep();
  const to = checkAddress(address);
  const sat = checkAmountSat(amountSat);
  const rate = checkFeeRate(feeRate);

  // COIN CONTROL (M5). Naming the inputs is the caller saying "spend these and nothing
  // else"; the node still decides the change and the fee. Shape-checked here because
  // these go straight into an RPC argument, and a malformed one is a confusing node error
  // rather than a sentence about what was wrong.
  const chosen = (inputs ?? []).map((i) => {
    if (!/^[0-9a-fA-F]{64}$/.test(String(i?.txid ?? ''))) deny('an input needs a transaction id', 'input-invalid');
    const vout = Number(i?.vout);
    if (!Number.isInteger(vout) || vout < 0) deny('an input needs an output index', 'input-invalid');
    return { txid: String(i.txid), vout };
  });

  const chain = await chainOf(app, node);
  const options = {
    // Core's own replaceability default is what a fee-bump screen depends on later.
    replaceable: true,
    ...(rate != null ? { fee_rate: rate } : {}),
    ...(subtractFee ? { subtractFeeFromOutputs: [0] } : {}),
  };
  let built;
  try {
    built = await walletCall(app, {
      node, wallet, capability: 'wallet.spend', method: 'walletcreatefundedpsbt',
      // With inputs named, add `add_inputs: false` so the node cannot quietly reach for
      // another coin to cover the shortfall -- "spend these" has to mean these.
      args: [chosen, [{ [to]: satToBtcString(sat) }], 0, chosen.length ? { ...options, add_inputs: false } : options],
    });
  } catch (err) {
    if (err.kind !== 'rpc') throw err;
    // Most often "Insufficient funds" -- and when other builds are holding coins, that is
    // the reason, so it is said rather than left for the operator to work out.
    const held = [...pending.values()].filter((b) => b.node === node && b.wallet === wallet).length;
    deny(`the node could not build this: ${err.message}`
      + (held ? `. ${held} pending build(s) of this wallet hold their coins until they are confirmed, cancelled or expire` : ''),
    'build-failed', 409);
  }
  if (!built?.psbt) deny('the node did not return a transaction to sign', 'build-failed', 502);

  // Read back what was ACTUALLY built. Everything the confirmation screen shows comes from
  // here, so a mismatch between the form and the transaction shows up as a different number
  // on the screen rather than as a surprise on the chain.
  const decoded = await walletCall(app, {
    node, wallet, capability: 'wallet.spend', method: 'decodepsbt', args: [built.psbt],
  });
  const outputs = (decoded?.tx?.vout ?? []).map((v) => ({
    address: v.scriptPubKey?.address ?? null,
    amountSat: toSats(v.value),
  }));
  const paying = outputs.filter((o) => o.address === to);
  const change = outputs.filter((o) => o.address !== to);
  const sendingSat = paying.reduce((n, o) => n + o.amountSat, 0);
  const feeSat = toSats(built.fee ?? 0);

  if (!paying.length) deny('the transaction the node built pays nothing to that address', 'build-mismatch', 502);

  const caps = checkCaps(app, { sendingSat, feeSat });
  const known = inAddressBook(app, to);
  // For the confirm screen, which asks for the passphrase only when there is one. Confirm
  // asks the node again rather than trusting this: a wallet can be encrypted between the
  // two steps.
  const encrypted = await walletEncrypted(app, { node, wallet });

  // Hold the coins. Core refuses to lock a coin that is already locked ("output already
  // locked", code -8, measured on v31.1) -- which is exactly the case of coin control naming
  // a coin another pending build holds, since Core funds from an explicitly named coin
  // whether it is locked or not.
  const coins = (decoded?.tx?.vin ?? []).map((v) => ({ txid: v.txid, vout: v.vout }));
  try {
    await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'lockunspent', args: [false, coins] });
  } catch (err) {
    if (err.kind !== 'rpc') throw err;
    if (/already locked/i.test(err.message)) {
      deny('a coin this build needs is held by another pending build (or was locked at a terminal); confirm or '
        + 'cancel that build first, or pick other coins', 'coins-held', 409);
    }
    deny(`the node would not hold this build's coins: ${err.message}`, 'build-failed', 409);
  }

  const id = crypto.randomBytes(18).toString('base64url');
  const summary = {
    id,
    wallet,
    node,
    chain,
    // FROM THE BUILT TRANSACTION, not from the request.
    to,
    sendingSat,
    feeSat,
    totalSat: sendingSat + feeSat,
    changeSat: change.reduce((n, o) => n + o.amountSat, 0),
    changeAddresses: change.map((o) => o.address),
    inputs: coins.length,
    coinControl: chosen.length ? chosen : null,
    vsize: decoded?.tx?.vsize ?? null,
    feeRateSatPerVb: decoded?.tx?.vsize ? Math.round((feeSat / decoded.tx.vsize) * 100) / 100 : null,
    replaceable: true,
    encrypted,
    addressBook: known,
    // null when the destination is known: no phrase to type.
    phrase: phraseFor(app, chain, { addressBook: known }),
    caps,
    expiresAt: Date.now() + BUILD_TTL_MS,
  };
  pending.set(id, {
    at: Date.now(),
    sessionId: ctx.session?.tokenHash ?? null,
    wallet, node, psbt: built.psbt, summary, coins, app,
  });
  return summary;
}

/** The build this session made, or the refusal. */
function ownBuild(ctx, id) {
  const build = pending.get(String(id ?? ''));
  if (!build) deny('that build has expired or does not exist; build the transaction again', 'no-such-build', 410);
  if (build.sessionId !== (ctx.session?.tokenHash ?? null)) {
    // A build belongs to the session that made it. Another tab, another browser, another
    // person with the same account: build your own.
    deny('that build belongs to a different session', 'build-not-yours', 403);
  }
  return build;
}

/** Throw a build away and give its coins back. Needs no elevation: it can only un-spend. */
export async function cancelBuild(app, ctx, { id }) {
  sweep();
  const build = ownBuild(ctx, id);
  pending.delete(build.summary.id);
  await releaseCoins(app, build);
  return { ok: true, id: build.summary.id, released: build.coins.length };
}

/**
 * Step two: sign and broadcast the build, and nothing but the build.
 *
 * The passphrase arrives, is used, and is gone. It is not stored, not logged, not audited
 * and not put in an error. The wallet is locked again as soon as the transaction is
 * signed, and in a `finally` besides, so no path out of this function leaves the wallet
 * unlocked -- including the ones where the node refuses the transaction.
 *
 * THE ORDER, since each step's position is a decision:
 *
 *   refusals that cost nothing   the build, the session, the pair, the phrase, the passphrase
 *                                being present -- a typo here keeps the build and the elevation
 *   one synchronous step         reserve the cap, consume the elevation, take the build
 *   under the wallet's lock      coins still unspent -> unlock -> sign -> relock -> test ->
 *                                attempt record -> broadcast -> done record
 */
export async function confirmSpend(app, ctx, { id, phrase, passphrase, node: askedNode = null, wallet: askedWallet = null }) {
  sweep();
  const build = ownBuild(ctx, id);
  const { summary, wallet, node } = build;
  // The pair the build was made for, checked again; and when the request names a pair
  // (the UI sends both on every wallet route), it must be that one.
  requireNamedWallet(app, node, wallet);
  if ((askedNode != null && askedNode !== node) || (askedWallet != null && askedWallet !== wallet)) {
    deny(`that build is for "${wallet}" on ${node}, not "${askedWallet ?? wallet}" on ${askedNode ?? node}`, 'build-other-wallet', 409);
  }
  if (summary.phrase && String(phrase ?? '').trim() !== summary.phrase) {
    deny(`this destination is not in the address book, so type exactly: ${summary.phrase}`, 'phrase-required');
  }

  // THE PASSPHRASE EVERY TIME (operator, 2026-09-19). Before, a confirm with no passphrase
  // skipped the unlock and signed with whatever unlock the wallet already had -- another
  // session's, mid-confirm, or a terminal's. Reproduced on regtest: sent.
  const encrypted = await walletEncrypted(app, { node, wallet });
  if (encrypted) requirePassphrase(passphrase, wallet);

  // A concurrent confirm of the same build (same session, two clicks) may have taken it
  // while this one awaited.
  if (pending.get(summary.id) !== build) deny('that build has already been confirmed or cancelled', 'no-such-build', 410);

  // ONE SYNCHRONOUS STEP. Nothing can run between these lines, so a second confirm sees
  // this one's reservation, finds the elevation gone, and cannot find the build.
  const reservation = reserveSpend(app, { sendingSat: summary.sendingSat, feeSat: summary.feeSat });
  try {
    // Elevation is CONSUMED here: one password authorises one spend, not everything done
    // in the next five minutes. After the phrase, so a typo in the phrase does not cost it.
    requireElevation(ctx, { consume: true, what: 'sending' });
  } catch (err) { reservation.release(); throw err; }
  pending.delete(summary.id);   // one build, one attempt: no replay of a confirmed spend

  try {
    return await withWalletLock([[node, wallet]], async () => {
      // Still unspent? A coin spent since the build -- at a terminal, by the paste box, by
      // a transaction the lock did not stop -- makes this a double spend, and a replaceable
      // one could evict the other.
      for (const c of build.coins) {
        const out = await walletCall(app, { node, wallet: null, capability: 'wallet.read', method: 'gettxout', args: [c.txid, c.vout, true] });
        if (!out) {
          deny('these coins were spent by another transaction since the build, so confirming it would replace that '
            + 'transaction; build again', 'inputs-spent', 409);
        }
      }

      let unlocked = false;
      let hex;
      try {
        if (encrypted) {
          // Set BEFORE the await: an unlock whose answer is lost is still an unlock.
          unlocked = true;
          // 30 seconds: long enough to sign, far too short to be a session. The allowlist
          // refuses anything over 120 (server/rpc/admin-allowlist.js).
          await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletpassphrase', args: [String(passphrase), 30] })
            .catch((err) => {
              if (err.code === -14) deny('that is not the wallet passphrase', 'passphrase-wrong', 403);
              throw err;
            });
        }
        const processed = await walletCall(app, {
          node, wallet, capability: 'wallet.spend', method: 'walletprocesspsbt', args: [build.psbt],
        });
        if (!processed?.complete) deny('the wallet could not fully sign this transaction', 'sign-incomplete', 502);

        const finalized = await walletCall(app, {
          node, wallet, capability: 'wallet.spend', method: 'finalizepsbt', args: [processed.psbt],
        });
        if (!finalized?.complete || !finalized?.hex) deny('the signed transaction did not finalise', 'finalize-failed', 502);
        hex = finalized.hex;
      } finally {
        // EVERY path, including the ones that threw. A wallet left unlocked because a
        // transaction was rejected is the worst combination of the two outcomes. And as
        // soon as it is signed: nothing after this line needs a key.
        if (unlocked) await relockWallet(app, { node, wallet, what: 'a send' });
      }

      // The txid, before the broadcast, so there is something to look for if its answer
      // never comes back.
      const { txid } = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'decoderawtransaction', args: [hex] });

      // Ask the node whether it would accept this before broadcasting it. A refusal here is
      // a message about a fee or a policy rule; a refusal after broadcast is a mystery.
      const [accept] = await walletCall(app, {
        node, wallet, capability: 'wallet.spend', method: 'testmempoolaccept', args: [[hex]],
      });
      if (!accept?.allowed) {
        deny(`the node would not accept this transaction: ${accept?.['reject-reason'] ?? 'no reason given'}`, 'rejected', 502);
      }

      const record = {
        wallet, to: summary.to, sendingSat: summary.sendingSat, feeSat: summary.feeSat, addressBook: summary.addressBook,
      };
      const sent = await broadcastSettled(app, ctx, {
        node, wallet, hex, txid, reservation,
        attempt: { type: 'admin-spend-attempt', ...record },
        done: { type: 'admin-spend', ...record },
      });
      return { ok: true, ...summary, txid: sent };
    });
  } catch (err) {
    // Failed BEFORE anything was broadcast: the sats never left and the coins are free.
    // A broadcast that may have happened has kept its reservation, and keeps its coins.
    if (!reservation.kept) {
      reservation.release();
      await releaseCoins(app, build);
    }
    throw err;
  }
}

/** For the UI: what is waiting, without the PSBT itself. */
export function pendingFor(ctx) {
  sweep();
  const mine = [...pending.values()].filter((b) => b.sessionId === (ctx.session?.tokenHash ?? null));
  return mine.map((b) => b.summary);
}
