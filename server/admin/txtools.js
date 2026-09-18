// TRANSACTION TOOLS (docs/PLAN-ADMIN-SUITE.md, M5): decode, broadcast, bump.
//
// THE ONE THAT NEEDED THINKING ABOUT IS BROADCAST. A paste-and-send box looks harmless —
// the transaction arrives already signed, and this suite's keys did not sign it — so the
// first instinct is that the spend caps have nothing to do with it. That instinct is
// wrong in one specific case, and it is the case that matters:
//
//   a transaction built and signed by this wallet in another window, or earlier, and
//   pasted here, spends this wallet's coins while sidestepping every limit the send path
//   enforces.
//
// So broadcast decodes first, asks the node which of the inputs belong to the named wallet,
// and when any of them do, it is treated as a send: caps, elevation, audit, the lot. A
// transaction that spends nothing of ours is still elevated and still audited — it is a
// node action — but the caps have nothing to measure and say so.
//
// Decoding is free of all that: it changes nothing, reaches no wallet, and is the tool
// someone reaches for precisely when they do not yet know what they are holding.
import { walletCall, toSats } from './wallet.js';
import { checkCaps, recordSpend } from './send.js';

function deny(message, code = 'admin-refused', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

const HEX = /^[0-9a-fA-F]+$/;
const MAX_TX_CHARS = 2 * 400_000;   // a 400 kB transaction, in hex; far past standardness

/** Is this hex, base64, or neither? The two encodings the two formats arrive in. */
export function sniffTx(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!text) deny('paste a transaction or a PSBT', 'tx-empty');
  if (text.length > MAX_TX_CHARS) deny('that is larger than any standard transaction', 'tx-too-large');
  if (HEX.test(text) && text.length % 2 === 0) return { kind: 'hex', text };
  // A PSBT is base64 and always starts with the magic bytes 0x70736274ff, which base64
  // renders as "cHNidP".
  if (text.startsWith('cHNidP')) return { kind: 'psbt', text };
  deny('that is neither transaction hex nor a base64 PSBT', 'tx-unrecognised');
  return null;
}

/** Everything a person needs to decide whether to broadcast this. */
function summarise(tx, { fee = null } = {}) {
  return {
    txid: tx?.txid ?? null,
    vsize: tx?.vsize ?? null,
    weight: tx?.weight ?? null,
    locktime: tx?.locktime ?? null,
    version: tx?.version ?? null,
    // An unconfirmed transaction that is not replaceable cannot be fee-bumped later, which
    // is worth knowing BEFORE it goes out rather than when it is stuck.
    replaceable: (tx?.vin ?? []).some((v) => (v.sequence ?? 0xffffffff) < 0xfffffffe),
    inputs: (tx?.vin ?? []).map((v) => ({ txid: v.txid ?? null, vout: v.vout ?? null, sequence: v.sequence ?? null })),
    outputs: (tx?.vout ?? []).map((v) => ({
      address: v.scriptPubKey?.address ?? null,
      type: v.scriptPubKey?.type ?? null,
      amountSat: toSats(v.value),
    })),
    outSat: (tx?.vout ?? []).reduce((n, v) => n + toSats(v.value), 0),
    feeSat: fee == null ? null : toSats(fee),
  };
}

/** Decode hex or a PSBT. Reaches no wallet and changes nothing. */
export async function decodeAny(app, { node, wallet, raw }) {
  const { kind, text } = sniffTx(raw);
  if (kind === 'hex') {
    const tx = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'decoderawtransaction', args: [text] });
    return { kind: 'transaction', ...summarise(tx) };
  }
  const psbt = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'decodepsbt', args: [text] });
  const analysis = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'analyzepsbt', args: [text] })
    .catch(() => null);
  return {
    kind: 'psbt',
    ...summarise(psbt?.tx, { fee: psbt?.fee }),
    // What still has to happen to it, in the node's own words -- the thing a person
    // pasting a half-signed PSBT actually wants to know.
    next: analysis?.next ?? null,
    complete: analysis?.next === 'extractor',
    estimatedVsize: analysis?.estimated_vsize ?? null,
    estimatedFeeRate: analysis?.estimated_feerate ?? null,
  };
}

/**
 * Which of these inputs belong to the named wallet?
 *
 * Asked of the node rather than worked out here: `listunspent` is the wallet's own answer
 * to "is this coin mine", and a second implementation of that question is a second chance
 * to get it wrong in the direction that skips the caps.
 */
export async function oursAmong(app, { node, wallet, inputs }) {
  if (!wallet || !inputs?.length) return { ours: [], oursSat: 0 };
  const utxos = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'listunspent', args: [0] });
  const mine = new Map((utxos ?? []).map((u) => [`${u.txid}:${u.vout}`, toSats(u.amount)]));
  const ours = inputs.filter((i) => mine.has(`${i.txid}:${i.vout}`));
  return { ours, oursSat: ours.reduce((n, i) => n + (mine.get(`${i.txid}:${i.vout}`) ?? 0), 0) };
}

/**
 * How much actually LEAVES the wallet: our inputs, less the outputs that come back to us.
 *
 * The first cut of this capped the gross value of our inputs, on the reasoning that
 * over-measuring is the safe direction for a cap. It is not: spending 2,000 sat out of a
 * 50 BTC coin would have been refused by any sane cap, which makes the feature unusable
 * and teaches the operator to raise the cap -- the opposite of what the cap is for. What
 * matters is the net, and change is not a spend.
 *
 * The wallet is asked which outputs are its own, for the same reason it is asked about the
 * inputs: a second implementation of "is this mine" is a second chance to be wrong in the
 * direction that under-counts.
 */
export async function netLeaving(app, { node, wallet, inputs, outputs }) {
  const { ours, oursSat } = await oursAmong(app, { node, wallet, inputs });
  if (!ours.length) return { ours, oursSat, changeSat: 0, netSat: 0 };
  let changeSat = 0;
  for (const out of outputs ?? []) {
    if (!out.address) continue;
    const info = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getaddressinfo', args: [out.address] })
      .catch(() => null);
    if (info?.ismine) changeSat += out.amountSat;
  }
  // Inputs less what came back: the amount paid away plus the fee, which is exactly what
  // the send path caps.
  return { ours, oursSat, changeSat, netSat: Math.max(0, oursSat - changeSat) };
}

/**
 * Broadcast a pasted transaction.
 *
 * `testmempoolaccept` first, always: a refusal from the node before the transaction is
 * anywhere is a message about a fee or a policy rule, and a refusal after it is out is a
 * support question.
 */
export async function broadcastRaw(app, ctx, { node, wallet, raw, acceptSpendingOurs = false }) {
  const { kind, text } = sniffTx(raw);
  if (kind !== 'hex') deny('broadcast takes a finished transaction in hex; finalise the PSBT first', 'tx-not-final');

  const tx = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'decoderawtransaction', args: [text] });
  const summary = summarise(tx);
  const { ours, oursSat, changeSat, netSat } = await netLeaving(app, {
    node, wallet, inputs: summary.inputs, outputs: summary.outputs,
  });

  // THE CASE THIS FUNCTION EXISTS TO CATCH. Spending our own coins through the paste box
  // is a send, and a send has limits.
  if (ours.length) {
    if (!acceptSpendingOurs) {
      deny(`this transaction spends ${ours.length} of this wallet's own coin(s): ${netSat} sat leaves `
        + `(${oursSat} sat in, ${changeSat} sat back as change). That is a send, not a broadcast: confirm it `
        + 'deliberately, and it counts against the spend caps.',
      'spends-ours');
    }
    checkCaps(app, { sendingSat: netSat, feeSat: 0 });
  }

  const [accept] = await walletCall(app, {
    node, wallet: null, capability: 'wallet.spend', method: 'testmempoolaccept', args: [[text]],
  });
  if (!accept?.allowed) {
    deny(`the node would not accept this transaction: ${accept?.['reject-reason'] ?? 'no reason given'}`, 'rejected', 502);
  }

  ctx.consumeElevation?.();
  const txid = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'sendrawtransaction', args: [text] });
  if (ours.length) recordSpend(netSat);
  await app.audit({
    type: 'admin-broadcast', username: ctx.user?.username ?? null,
    node, wallet: ours.length ? wallet : null, txid,
    spentOwnInputs: ours.length, spentOwnSat: ours.length ? netSat : 0,
  });
  return { ok: true, txid, ...summary, spendsOurs: ours.length > 0, oursSat, changeSat, netSat };
}

/**
 * Raise the fee on a stuck transaction.
 *
 * The bump is a new transaction spending the same inputs, so what it costs is the
 * DIFFERENCE in fee -- that is what the caps measure here. Capping the whole amount again
 * would refuse to rescue a transaction that was itself within the cap, which is the wrong
 * answer at the wrong moment.
 */
export async function previewBump(app, ctx, { node, wallet, txid, feeRate = null }) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txid ?? ''))) deny('that is not a transaction id', 'txid-invalid');

  const before = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'gettransaction', args: [txid] });
  if ((before?.confirmations ?? 0) > 0) deny('that transaction is already confirmed; there is nothing to bump', 'already-confirmed', 409);
  if (before?.['bip125-replaceable'] !== 'yes') {
    deny('that transaction did not signal replaceability, so its fee cannot be raised. It has to be waited out '
      + '(or replaced by the receiver, if they will)', 'not-replaceable', 409);
  }

  // ARITHMETIC, NOT A WALLET CALL. The obvious implementation of this preview is
  // `psbtbumpfee`, which builds the replacement and hands it back to be inspected -- but
  // Core requires an UNLOCKED wallet for it, so a two-step preview/confirm built that way
  // asks for the wallet passphrase TWICE for one bump. Typing a passphrase to look at a
  // number is exactly the habit this suite is built to avoid, so the preview is computed
  // from the transaction's own size and the requested fee rate, and the single unlock
  // happens in confirmBump where the signing does.
  const decoded = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'decoderawtransaction', args: [before.hex] });
  const vsize = decoded?.vsize ?? null;
  const oldFeeSat = Math.abs(toSats(before?.fee ?? 0));
  const rate = feeRate == null ? null : Number(feeRate);
  const newFeeSat = rate != null && vsize ? Math.ceil(vsize * rate) : null;
  const deltaSat = newFeeSat == null ? null : newFeeSat - oldFeeSat;
  if (deltaSat != null && deltaSat <= 0) deny('that fee rate would not pay more than the original', 'bump-pointless', 409);
  if (deltaSat != null) checkCaps(app, { sendingSat: 0, feeSat: deltaSat });

  return {
    ok: true, stage: 'preview', txid, vsize, oldFeeSat,
    newFeeSat, deltaSat,
    oldFeeRate: vsize ? Math.round((oldFeeSat / vsize) * 100) / 100 : null,
    feeRate: rate,
    // Said out loud because the numbers above are this monitor's arithmetic; the node's
    // own figure arrives at confirm time and is what the caps are re-checked against.
    note: 'an estimate from the transaction size and the fee rate; the node computes the real '
      + 'replacement when you confirm, and the caps are checked again against that',
  };
}

/** Sign and broadcast a bump that was built above. */
export async function confirmBump(app, ctx, { node, wallet, txid, feeRate = null, passphrase }) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txid ?? ''))) deny('that is not a transaction id', 'txid-invalid');

  let unlocked = false;
  try {
    if (passphrase != null && String(passphrase).length) {
      // ONE unlock, covering both the build and the signing -- see previewBump for why
      // the build cannot happen before this point.
      await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletpassphrase', args: [String(passphrase), 30] });
      unlocked = true;
    }
    const options = feeRate != null ? [{ fee_rate: Number(feeRate) }] : [];
    const bumped = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'psbtbumpfee', args: [txid, ...options] });
    const before = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'gettransaction', args: [txid] });
    const oldFeeSat = Math.abs(toSats(before?.fee ?? 0));
    const newFeeSat = Math.abs(toSats(bumped?.fee ?? 0));
    const deltaSat = newFeeSat - oldFeeSat;
    if (deltaSat <= 0) deny('the replacement would not pay more than the original', 'bump-pointless', 409);
    // THE NODE'S OWN FIGURE, not the preview's estimate: the cap is enforced against what
    // the replacement actually costs.
    checkCaps(app, { sendingSat: 0, feeSat: deltaSat });

    const processed = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletprocesspsbt', args: [bumped.psbt] });
    if (!processed?.complete) deny('the wallet could not fully sign the replacement', 'sign-incomplete', 502);
    const finalized = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'finalizepsbt', args: [processed.psbt] });
    if (!finalized?.hex) deny('the replacement did not finalise', 'finalize-failed', 502);

    ctx.consumeElevation?.();
    const replacement = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'sendrawtransaction', args: [finalized.hex] });
    recordSpend(deltaSat);
    await app.audit({ type: 'admin-fee-bump', username: ctx.user?.username ?? null, node, wallet, txid: replacement, replaced: txid, deltaSat });
    return { ok: true, txid: replacement, replaced: txid, oldFeeSat, newFeeSat, deltaSat };
  } finally {
    if (unlocked) {
      await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletlock', args: [] })
        .catch((err) => app.log({ level: 'error', msg: `admin: the wallet could not be re-locked after a fee bump: ${err.message}` }));
    }
  }
}
