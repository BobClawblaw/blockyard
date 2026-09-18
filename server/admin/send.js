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
import crypto from 'node:crypto';
import { walletCall, toSats } from './wallet.js';
import { requireElevation } from './elevation.js';

function deny(message, code = 'admin-refused', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

// Builds waiting for confirmation. In memory, short lived, keyed by an unguessable id and
// bound to the session that made them: a build is not a thing another tab can pick up.
const pending = new Map(); // id -> { at, sessionId, wallet, node, psbt, summary }
const BUILD_TTL_MS = 10 * 60_000;

function sweep(now = Date.now()) {
  for (const [id, b] of pending) if (now - b.at > BUILD_TTL_MS) pending.delete(id);
}

/** Test seam. */
export function __resetPending() { pending.clear(); }

/** Spends already made, for the rolling cap. In memory: a restart forgives the window. */
const spent = []; // { at, sat }

function spentIn24h(now = Date.now()) {
  const cutoff = now - 24 * 3600_000;
  while (spent.length && spent[0].at < cutoff) spent.shift();
  return spent.reduce((n, s) => n + s.sat, 0);
}

export function __resetSpent() { spent.length = 0; }

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
 * The phrase the operator must type for a destination outside the address book.
 *
 * Different on mainnet, deliberately (operator's choice at scoping): muscle memory from a
 * test network should not carry over to the network where it is real.
 */
export function confirmationPhrase(chain, { addressBook = false } = {}) {
  if (addressBook) return null;
  return chain === 'main' ? 'SEND REAL BITCOIN' : `send on ${chain}`;
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
 */
export async function buildSpend(app, ctx, { node, wallet, address, amountSat, feeRate = null, subtractFee = false }) {
  sweep();
  const to = checkAddress(address);
  const sat = checkAmountSat(amountSat);

  const options = {
    // Core's own replaceability default is what a fee-bump screen depends on later.
    replaceable: true,
    ...(feeRate != null ? { fee_rate: Number(feeRate) } : {}),
    ...(subtractFee ? { subtractFeeFromOutputs: [0] } : {}),
  };
  const built = await walletCall(app, {
    node, wallet, capability: 'wallet.spend', method: 'walletcreatefundedpsbt',
    args: [[], [{ [to]: satToBtcString(sat) }], 0, options],
  });
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
  const chain = app.monitors.get(node)?.state?.chainInfo?.chain ?? app.monitors.get(node)?.cfg?.chainHint ?? 'main';
  const known = inAddressBook(app, to);

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
    inputs: (decoded?.tx?.vin ?? []).length,
    vsize: decoded?.tx?.vsize ?? null,
    feeRateSatPerVb: decoded?.tx?.vsize ? Math.round((feeSat / decoded.tx.vsize) * 100) / 100 : null,
    replaceable: true,
    addressBook: known,
    // null when the destination is known: no phrase to type.
    phrase: confirmationPhrase(chain, { addressBook: known }),
    caps,
    expiresAt: Date.now() + BUILD_TTL_MS,
  };
  pending.set(id, {
    at: Date.now(),
    sessionId: ctx.session?.tokenHash ?? null,
    wallet, node, psbt: built.psbt, summary,
  });
  return summary;
}

/**
 * Step two: sign and broadcast the build, and nothing but the build.
 *
 * The passphrase arrives, is used, and is gone. It is not stored, not logged, not audited
 * and not put in an error. `walletlock` runs in a `finally` so no path out of this function
 * leaves the wallet unlocked -- including the ones where the node refuses the transaction.
 */
export async function confirmSpend(app, ctx, { id, phrase, passphrase }) {
  sweep();
  const build = pending.get(String(id ?? ''));
  if (!build) deny('that build has expired or does not exist; build the transaction again', 'no-such-build', 410);
  if (build.sessionId !== (ctx.session?.tokenHash ?? null)) {
    // A build belongs to the session that made it. Another tab, another browser, another
    // person with the same account: build your own.
    deny('that build belongs to a different session', 'build-not-yours', 403);
  }

  const { summary, wallet, node } = build;
  if (summary.phrase && String(phrase ?? '').trim() !== summary.phrase) {
    deny(`this destination is not in the address book, so type exactly: ${summary.phrase}`, 'phrase-required');
  }

  // Elevation is CONSUMED here: one password authorises one spend, not everything done in
  // the next five minutes. Checked after the phrase so a typo in the phrase does not cost
  // the elevation.
  requireElevation(ctx, { consume: true, what: 'sending' });

  // Re-check the caps at confirm time. The build may be minutes old and other spends may
  // have gone out since; a cap checked only at build time is a cap with a race in it.
  checkCaps(app, { sendingSat: summary.sendingSat, feeSat: summary.feeSat });

  pending.delete(summary.id);   // one build, one attempt: no replay of a confirmed spend

  const encrypted = summary.encrypted ?? true;
  let unlocked = false;
  try {
    if (passphrase != null && String(passphrase).length) {
      // 30 seconds: long enough to sign, far too short to be a session. The allowlist
      // refuses anything over 120 (server/rpc/admin-allowlist.js).
      await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletpassphrase', args: [String(passphrase), 30] });
      unlocked = true;
    }

    const processed = await walletCall(app, {
      node, wallet, capability: 'wallet.spend', method: 'walletprocesspsbt', args: [build.psbt],
    });
    if (!processed?.complete) deny('the wallet could not fully sign this transaction', 'sign-incomplete', 502);

    const finalized = await walletCall(app, {
      node, wallet, capability: 'wallet.spend', method: 'finalizepsbt', args: [processed.psbt],
    });
    if (!finalized?.complete || !finalized?.hex) deny('the signed transaction did not finalise', 'finalize-failed', 502);

    // Ask the node whether it would accept this before broadcasting it. A refusal here is
    // a message about a fee or a policy rule; a refusal after broadcast is a mystery.
    const [accept] = await walletCall(app, {
      node, wallet, capability: 'wallet.spend', method: 'testmempoolaccept', args: [[finalized.hex]],
    });
    if (!accept?.allowed) {
      deny(`the node would not accept this transaction: ${accept?.['reject-reason'] ?? 'no reason given'}`, 'rejected', 502);
    }

    const txid = await walletCall(app, {
      node, wallet, capability: 'wallet.spend', method: 'sendrawtransaction', args: [finalized.hex],
    });

    spent.push({ at: Date.now(), sat: summary.totalSat });
    await app.audit({
      type: 'admin-spend',
      username: ctx.user?.username ?? null,
      wallet, node, txid,
      to: summary.to, sendingSat: summary.sendingSat, feeSat: summary.feeSat,
      addressBook: summary.addressBook,
    });
    return { ok: true, txid, ...summary };
  } finally {
    // EVERY path, including the ones that threw. A wallet left unlocked because a
    // transaction was rejected is the worst combination of the two outcomes.
    if (unlocked) {
      await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletlock', args: [] })
        .catch((err) => app.log({ level: 'error', msg: `admin: the wallet could not be re-locked after a send: ${err.message}` }));
    }
  }
}

/** For the UI: what is waiting, without the PSBT itself. */
export function pendingFor(ctx) {
  sweep();
  const mine = [...pending.values()].filter((b) => b.sessionId === (ctx.session?.tokenHash ?? null));
  return mine.map((b) => b.summary);
}
