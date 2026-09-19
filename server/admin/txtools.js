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
//
// THE REVIEW OF 2026-09-19 found the paste box's idea of "ours" too narrow, reproduced
// each hole on regtest, and closed them here: ownership is now decided from each input's
// PREVOUT, across every named wallet on the node (see oursAmong); a spend of ours needs
// the same typed phrase and the same wallet passphrase the Send screen does; and the cap
// is reserved in the same synchronous step as it is checked (server/admin/send.js).
import {
  walletCall, toSats, namedWallets, walletsOnNode, withWalletLock, walletEncrypted, requirePassphrase, relockWallet, verifyPassphrase,
} from './wallet.js';
import {
  checkCaps, reserveSpend, NO_RESERVATION, inAddressBook, phraseFor, chainOf, checkFeeRate, consumeElevation, broadcastSettled,
} from './send.js';

function deny(message, code = 'admin-refused', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

const HEX = /^[0-9a-fA-F]+$/;
const MAX_TX_CHARS = 2 * 400_000;   // a 400 kB transaction, in hex; far past standardness

// The most inputs, and separately the most outputs, a pasted transaction may have before
// this suite refuses to check it. Each one costs a round trip per named wallet to a node
// that answers one call at a time; a 400 kB transaction can carry about 9,000 outputs, and
// at the ~10 ms a local getaddressinfo takes that is minutes of a lane the monitor's own
// polls are waiting on. A thousand is past any payment a person pastes by hand
// (review, 2026-09-19).
export const MAX_TX_ENTRIES = 1000;

function checkWidth(inputs, outputs) {
  if ((inputs?.length ?? 0) > MAX_TX_ENTRIES || (outputs?.length ?? 0) > MAX_TX_ENTRIES) {
    deny(`this transaction has ${inputs?.length ?? 0} inputs and ${outputs?.length ?? 0} outputs; the paste box checks at most `
      + `${MAX_TX_ENTRIES} of each against the wallets, so broadcast it from the node directly`, 'tx-too-wide');
  }
}

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
 * Which of these inputs belong to a wallet named in admin.wallets for this node?
 *
 * DECIDED FROM THE PREVOUT, NOT FROM listunspent (review, 2026-09-19). The first version
 * asked `listunspent` of the selected wallet -- the wallet's answer to "which coins can I
 * spend right now", which is a different question. It leaves out a coin already spent by
 * one of the wallet's own unconfirmed transactions, and a LOCKED coin, so both looked like
 * somebody else's and went out with no cap, no phrase and no record. Reproduced on regtest:
 * a replacement re-spending our coin sent 10 BTC uncapped; a locked coin, 49.999 BTC. And
 * it asked only the wallet selected in the form, so a coin of a second named wallet was
 * foreign too.
 *
 * So, for each input: `gettransaction` of the PARENT on each named wallet (a wallet knows
 * every transaction that paid it, spent or not, locked or not), the parent's output at the
 * input's index, and `getaddressinfo` on its address -- `ismine` is the wallet's own
 * answer, and a second implementation of it here would be a second chance to be wrong in
 * the direction that skips the caps. An output with no address (bare script) falls back to
 * the parent's `details`.
 *
 * FAILS CLOSED. "Invalid or non-wallet transaction id" (code -5) is the wallet saying the
 * parent is not its business. Anything else -- a named wallet that is not loaded (-18), a
 * timeout -- means the question was not answered, and an unanswered question is refused,
 * not read as "not ours".
 */
export async function oursAmong(app, { node, inputs, mine = mineCache(app, node) }) {
  // A bare name in a config with several nodes belongs to no node in particular, so its
  // coins could be on this one: refused rather than left out of the question.
  const unplaced = namedWallets(app).filter((e) => e.node == null).map((e) => e.wallet);
  if (unplaced.length) {
    deny(`admin.wallets names ${unplaced.map((w) => `"${w}"`).join(', ')} without a node, so this suite cannot tell whether `
      + 'a pasted transaction spends its coins. Write each entry as { "node": "<node id>", "wallet": "<name>" }.', 'wallet-node-unnamed', 403);
  }
  const wallets = walletsOnNode(app, node);
  const none = { ours: [], oursSat: 0, byWallet: new Map() };
  if (!wallets.length || !inputs?.length) return none;
  checkWidth(inputs, []);
  const parents = [...new Set(inputs.map((i) => i.txid).filter(Boolean))];
  const claimed = new Map();   // "txid:vout" -> { wallet, sat }
  for (const wallet of wallets) {
    for (const txid of parents) {
      let tx;
      try {
        tx = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'gettransaction', args: [txid, true, true] });
      } catch (err) {
        if (err.code === -5) continue;
        deny(`could not ask the wallet "${wallet}" whether it knows ${txid} (${err.message}); this suite will not guess whether `
          + 'a transaction spends a named wallet\'s coins, so it is not broadcasting this one', 'ownership-unknown', 502);
      }
      for (const input of inputs.filter((i) => i.txid === txid)) {
        const key = `${input.txid}:${input.vout}`;
        if (claimed.has(key)) continue;
        const out = (tx?.decoded?.vout ?? []).find((v) => v.n === input.vout);
        if (!out) continue;
        const address = out.scriptPubKey?.address ?? null;
        const ours = address
          ? await mine(wallet, address, { strict: true })
          : (tx?.details ?? []).some((d) => d.vout === input.vout && d.category !== 'send');
        if (ours) claimed.set(key, { wallet, sat: toSats(out.value) });
      }
    }
  }
  const ours = inputs.filter((i) => claimed.has(`${i.txid}:${i.vout}`))
    .map((i) => ({ ...i, ...claimed.get(`${i.txid}:${i.vout}`) }));
  const byWallet = new Map();
  for (const o of ours) byWallet.set(o.wallet, (byWallet.get(o.wallet) ?? 0) + o.sat);
  return { ours, oursSat: ours.reduce((n, o) => n + o.sat, 0), byWallet };
}

/**
 * `getaddressinfo ismine`, asked once per (wallet, address) within one paste.
 *
 * `strict` is for inputs, where no answer must not be read as "not ours"; for outputs, a
 * missing answer counts the output as leaving, which over-measures the spend -- the safe
 * direction for a cap.
 */
function mineCache(app, node) {
  const answers = new Map();
  const ask = async (wallet, address, { strict = false } = {}) => {
    const key = `${wallet}\u0000${address}`;
    if (!answers.has(key)) {
      answers.set(key, walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getaddressinfo', args: [address] })
        .then((info) => ({ ok: true, mine: Boolean(info?.ismine) }), (err) => ({ ok: false, err })));
    }
    const a = await answers.get(key);
    if (!a.ok && strict) {
      deny(`could not ask the wallet "${wallet}" about ${address} (${a.err?.message}); refusing rather than guessing`, 'ownership-unknown', 502);
    }
    return a.ok && a.mine;
  };
  return ask;
}

/**
 * How much actually LEAVES the named wallets: our inputs, less the outputs that come back.
 *
 * The first cut of this capped the gross value of our inputs, on the reasoning that
 * over-measuring is the safe direction for a cap. It is not: spending 2,000 sat out of a
 * 50 BTC coin would have been refused by any sane cap, which makes the feature unusable
 * and teaches the operator to raise the cap -- the opposite of what the cap is for. What
 * matters is the net, and change is not a spend.
 *
 * "Back" means to ANY wallet named for this node: moving coins between two named wallets
 * costs the fee, the same as paying yourself within one. Each distinct output address is
 * asked about once (review, 2026-09-19: one call per output, in sequence, and a 9,000
 * output transaction was minutes of the node's lane).
 *
 * `strangers` are the outputs that leave -- what the address-book rule is applied to.
 */
export async function netLeaving(app, { node, inputs, outputs }) {
  checkWidth(inputs, outputs);
  const mine = mineCache(app, node);
  const { ours, oursSat, byWallet } = await oursAmong(app, { node, inputs, mine });
  if (!ours.length) return { ours, oursSat, byWallet, changeSat: 0, netSat: 0, strangers: [] };
  const wallets = walletsOnNode(app, node);
  const back = new Map();   // address -> bool
  for (const address of new Set((outputs ?? []).map((o) => o.address).filter(Boolean))) {
    let isOurs = false;
    for (const wallet of wallets) {
      if (await mine(wallet, address)) { isOurs = true; break; }
    }
    back.set(address, isOurs);
  }
  let changeSat = 0;
  const strangers = [];
  for (const out of outputs ?? []) {
    if (out.address && back.get(out.address)) changeSat += out.amountSat;
    else strangers.push(out);
  }
  // Inputs less what came back: the amount paid away plus the fee, which is exactly what
  // the send path caps.
  return { ours, oursSat, byWallet, changeSat, netSat: Math.max(0, oursSat - changeSat), strangers };
}

/**
 * Broadcast a pasted transaction.
 *
 * `testmempoolaccept` first, always: a refusal from the node before the transaction is
 * anywhere is a message about a fee or a policy rule, and a refusal after it is out is a
 * support question.
 *
 * When it spends coins of ours it is a SEND, and asks what a send asks (review and
 * operator, 2026-09-19): `acceptSpendingOurs` to say so, the caps, the typed phrase unless
 * every output that leaves is in the address book (the paste box had skipped it -- a
 * pasted transaction to a stranger needed one checkbox where the Send screen needed a
 * sentence), and the passphrase of every encrypted wallet whose coins it spends, checked
 * against the wallet even though nothing is signed here: a stolen session plus a
 * transaction signed elsewhere must not add up to a spend. `passphrases` maps wallet names
 * to passphrases for the rare transaction spending from two; `passphrase` covers the rest.
 */
export async function broadcastRaw(app, ctx, { node, wallet, raw, acceptSpendingOurs = false, phrase = null, passphrase = null, passphrases = null }) {
  const { kind, text } = sniffTx(raw);
  if (kind !== 'hex') deny('broadcast takes a finished transaction in hex; finalise the PSBT first', 'tx-not-final');

  const tx = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'decoderawtransaction', args: [text] });
  const summary = summarise(tx);
  checkWidth(summary.inputs, summary.outputs);
  const { ours, oursSat, byWallet, changeSat, netSat, strangers } = await netLeaving(app, {
    node, inputs: summary.inputs, outputs: summary.outputs,
  });
  const involved = [...byWallet.keys()];
  const passFor = (w) => (passphrases && typeof passphrases === 'object' ? passphrases[w] : null) ?? passphrase;

  // THE CASE THIS FUNCTION EXISTS TO CATCH. Spending our own coins through the paste box
  // is a send, and a send has limits.
  const encrypted = [];
  let chain = null;
  if (ours.length) {
    const whose = involved.map((w) => `"${w}"`).join(' and ');
    if (!acceptSpendingOurs) {
      deny(`this transaction spends ${ours.length} coin(s) of ${whose}: ${netSat} sat leaves `
        + `(${oursSat} sat in, ${changeSat} sat back as change). That is a send, not a broadcast: confirm it `
        + 'deliberately, and it counts against the spend caps.',
      'spends-ours');
    }
    // Early and readable; the binding check is the reservation below.
    checkCaps(app, { sendingSat: netSat, feeSat: 0 });
    chain = await chainOf(app, node);
    const unknown = strangers.filter((o) => o.amountSat > 0 && !(o.address && inAddressBook(app, o.address)));
    const expected = unknown.length ? phraseFor(app, chain) : null;
    if (expected && String(phrase ?? '').trim() !== expected) {
      deny(`this transaction pays ${unknown.length} output(s) outside the address book, so type exactly: ${expected}`, 'phrase-required');
    }
    for (const w of involved) {
      if (await walletEncrypted(app, { node, wallet: w })) {
        requirePassphrase(passFor(w), w);
        encrypted.push(w);
      }
    }
  }

  const [accept] = await walletCall(app, {
    node, wallet: null, capability: 'wallet.spend', method: 'testmempoolaccept', args: [[text]],
  });
  if (!accept?.allowed) {
    deny(`the node would not accept this transaction: ${accept?.['reject-reason'] ?? 'no reason given'}`, 'rejected', 502);
  }

  // ONE SYNCHRONOUS STEP: the cap reserved and the elevation taken, with nothing between.
  const reservation = ours.length ? reserveSpend(app, { sendingSat: netSat, feeSat: 0 }) : NO_RESERVATION;
  try { consumeElevation(ctx, 'broadcasting a transaction'); } catch (err) { reservation.release(); throw err; }

  try {
    return await withWalletLock(involved.map((w) => [node, w]), async () => {
      for (const w of encrypted) await verifyPassphrase(app, { node, wallet: w, passphrase: passFor(w) });
      const record = {
        wallet: ours.length ? involved.join(',') : null,
        spentOwnInputs: ours.length, spentOwnSat: ours.length ? netSat : 0,
      };
      const txid = await broadcastSettled(app, ctx, {
        node, wallet: involved[0] ?? null, hex: text, txid: summary.txid, reservation,
        attempt: { type: 'admin-broadcast-attempt', ...record },
        done: { type: 'admin-broadcast', ...record },
      });
      return {
        ok: true, ...summary, txid, spendsOurs: ours.length > 0, wallets: involved, chain,
        oursSat, changeSat, netSat,
      };
    });
  } catch (err) {
    if (!reservation.kept) reservation.release();
    throw err;
  }
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
  // Before anything is asked of the node: a fee rate that is not a number made NaN fees
  // and a NaN delta that no comparison refuses (review, 2026-09-19).
  const rate = checkFeeRate(feeRate);
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
  const newFeeSat = rate != null && vsize ? Math.ceil(vsize * rate) : null;
  const deltaSat = newFeeSat == null ? null : newFeeSat - oldFeeSat;
  if (deltaSat != null && deltaSat <= 0) deny('that fee rate would not pay more than the original', 'bump-pointless', 409);
  if (deltaSat != null) checkCaps(app, { sendingSat: 0, feeSat: deltaSat });

  return {
    ok: true, stage: 'preview', txid, vsize, oldFeeSat,
    newFeeSat, deltaSat,
    oldFeeRate: vsize ? Math.round((oldFeeSat / vsize) * 100) / 100 : null,
    feeRate: rate,
    encrypted: await walletEncrypted(app, { node, wallet }),
    // Said out loud because the numbers above are this monitor's arithmetic; the node's
    // own figure arrives at confirm time and is what the caps are re-checked against.
    note: 'an estimate from the transaction size and the fee rate; the node computes the real '
      + 'replacement when you confirm, and the caps are checked again against that',
  };
}

/**
 * Build, sign and broadcast the replacement.
 *
 * Under the wallet's lock from the unlock to the relock, with the passphrase required of
 * an encrypted wallet every time (operator, 2026-09-19: before, an empty passphrase skipped
 * the unlock and bumped with whatever unlock the wallet already had). The cap is reserved
 * the moment the node's own figure for the delta is known, in the same synchronous step
 * as the elevation is taken.
 */
export async function confirmBump(app, ctx, { node, wallet, txid, feeRate = null, passphrase }) {
  const rate = checkFeeRate(feeRate);
  if (!/^[0-9a-fA-F]{64}$/.test(String(txid ?? ''))) deny('that is not a transaction id', 'txid-invalid');
  const encrypted = await walletEncrypted(app, { node, wallet });
  if (encrypted) requirePassphrase(passphrase, wallet);

  return withWalletLock([[node, wallet]], async () => {
    let unlocked = false;
    let reservation = NO_RESERVATION;
    try {
      let hex; let oldFeeSat; let newFeeSat; let deltaSat;
      try {
        if (encrypted) {
          // ONE unlock, covering both the build and the signing -- see previewBump for why
          // the build cannot happen before this point. Flagged before the await, so an
          // unlock whose answer is lost is still locked again.
          unlocked = true;
          await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletpassphrase', args: [String(passphrase), 30] })
            .catch((err) => {
              if (err.code === -14) deny('that is not the wallet passphrase', 'passphrase-wrong', 403);
              throw err;
            });
        }
        const options = rate != null ? [{ fee_rate: rate }] : [];
        const bumped = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'psbtbumpfee', args: [txid, ...options] });
        const before = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'gettransaction', args: [txid] });
        oldFeeSat = Math.abs(toSats(before?.fee ?? 0));
        newFeeSat = Math.abs(toSats(bumped?.fee ?? 0));
        deltaSat = newFeeSat - oldFeeSat;
        if (!(deltaSat > 0)) deny('the replacement would not pay more than the original', 'bump-pointless', 409);

        // THE NODE'S OWN FIGURE, not the preview's estimate: the cap is enforced against
        // what the replacement actually costs -- and reserved as it is checked, with the
        // elevation taken in the same step.
        reservation = reserveSpend(app, { sendingSat: 0, feeSat: deltaSat });
        consumeElevation(ctx, 'sending a fee bump');

        const processed = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'walletprocesspsbt', args: [bumped.psbt] });
        if (!processed?.complete) deny('the wallet could not fully sign the replacement', 'sign-incomplete', 502);
        const finalized = await walletCall(app, { node, wallet, capability: 'wallet.spend', method: 'finalizepsbt', args: [processed.psbt] });
        if (!finalized?.hex) deny('the replacement did not finalise', 'finalize-failed', 502);
        hex = finalized.hex;
      } finally {
        if (unlocked) { unlocked = false; await relockWallet(app, { node, wallet, what: 'a fee bump' }); }
      }

      const { txid: replacementTxid } = await walletCall(app, { node, wallet: null, capability: 'wallet.spend', method: 'decoderawtransaction', args: [hex] });
      const record = { wallet, replaced: txid, deltaSat };
      const replacement = await broadcastSettled(app, ctx, {
        node, wallet, hex, txid: replacementTxid, reservation,
        attempt: { type: 'admin-fee-bump-attempt', ...record },
        done: { type: 'admin-fee-bump', ...record },
      });
      return { ok: true, txid: replacement, replaced: txid, oldFeeSat, newFeeSat, deltaSat };
    } catch (err) {
      if (!reservation.kept) reservation.release();
      throw err;
    } finally {
      if (unlocked) await relockWallet(app, { node, wallet, what: 'a fee bump' });
    }
  });
}
