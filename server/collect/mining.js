// Who mined a block, and what that pool's blocks look like.
//
// Pure functions only -- no I/O, no RPC -- so the decoders are testable against real
// coinbase bytes frozen in test/fixtures. The caller (monitor) owns the lane and the
// ledger; this module only turns bytes into facts and folds facts into counters.
//
// WHERE THIS COMES FROM, measured 2026-09-09 through the monitor's own read-only
// console on height 966257:
//   getblock <hash> 1            -> 259,891 bytes, 8 ms  (size, weight, strippedsize and
//                                                          the txid list; tx[0] is the
//                                                          coinbase)
//   getrawtransaction <cb> 2     -> 2,915 bytes, 63 ms   (vin[0].coinbase = the scriptSig
//                                                          as hex)
// Both are cheap enough for the serialized lane at one block per tick; neither is
// anything like getblock verbosity 2, which costs 11 MB per block (MEASUREMENTS 6).
//
// NO INVENTED NAMES. The coinbase text is what a pool chose to put in its own block, so
// it is shown verbatim. A prettier name appears only if a human put it in the alias file
// (`data/pool-aliases.json`, edited by hand). No tag -> name guessing, no "looks like
// Foundry" heuristics: a wrong miner attribution is worse than a raw tag, and it is the
// kind of wrong that gets repeated by everyone who reads the page.

const TEXT_OK = /^[\x20-\x7e\x80-\xff]+$/;

/**
 * Decode the push frames of a scriptSig.
 *
 * Three things this has to survive, all of them seen in real blocks here on 2026-09-09:
 *   - direct pushes (length 1..75), the common case;
 *   - OP_PUSHDATA1/2/3 (0x4c/0x4d/0x4e), which tags longer than 75 bytes use -- stopping
 *     at them would lose the pool's own name and silently file the block as unknown;
 *   - a push that is text followed by binary in the SAME frame (AntPool's
 *     "Mined by AntPool971\x15\x00\"\x00\xe16{m"), which is why tag extraction takes the
 *     printable prefix of a push rather than demanding the whole frame be text.
 * An unparseable frame stops the walk; a coinbase we cannot read is reported as
 * unparseable, not decoded into something plausible.
 */
export function parsePushes(hex) {
  const bytes = Buffer.from(String(hex ?? ''), 'hex');
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    let n = op;
    let head = 1;
    // 2026-09-16 (audit L4): a scriptSig may END on an OP_PUSHDATA opcode with its length
    // bytes missing -- consensus allows any bytes after the BIP34 height, so a pool can
    // put this in its own block for free. readUInt16LE/readUInt32LE past the end threw
    // ERR_OUT_OF_RANGE, the monitor's lane retried that block forever and every later
    // block waited behind it. The length is read only when all of its bytes are there;
    // a truncated frame header ends the walk like any other unparseable frame.
    if (op === 0x4c) head = 2;
    else if (op === 0x4d) head = 3;
    else if (op === 0x4e) head = 5;
    if (i + head > bytes.length) break;
    if (op === 0x4c) { n = bytes[i + 1]; head = 2; }
    else if (op === 0x4d) { n = bytes.readUInt16LE(i + 1); head = 3; }
    else if (op === 0x4e) { n = bytes.readUInt32LE(i + 1); head = 5; }
    if (op === 0 || n < 1 || n > 4096 || i + head + n > bytes.length) break;
    const payload = bytes.subarray(i + head, i + head + n);
    out.push({ len: n, opPushData: op >= 0x4c && op <= 0x4e, hex: payload.toString('hex'), bytes: payload });
    i += head + n;
  }
  return { consumed: i, total: bytes.length, pushes: out };
}

/**
 * decodeCoinbase that cannot throw (2026-09-16, audit L4). The decoder is meant never to
 * throw on any bytes, and the fuzz test holds it to that; this is the belt to that pair of
 * braces for the two lanes that call it on untrusted blocks. A coinbase that still fails
 * to decode is a fact about THAT block -- permanent, so it is recorded as unparseable (an
 * unknown pool, `decodeError` saying why) and the lane moves on. Retrying it would only
 * stall every block queued behind it, which is exactly what L4 found.
 */
export function decodeCoinbaseSafe(hex) {
  try {
    return decodeCoinbase(hex);
  } catch (err) {
    return {
      parseable: false, truncatedAt: 0, height: null, tagText: null, tag: null,
      commitment: null, extraNonce: null, raw: typeof hex === 'string' ? hex : '',
      decodeError: String(err?.message ?? err),
    };
  }
}

/**
 * The longest printable prefix of a push. Pool tags and extra nonces share one frame
 * more often than they get a frame each, so "is this frame text" is the wrong question;
 * the right one is "what did it start with". Returns null for a frame with nothing
 * readable at the front, so a binary extranonce is never mistaken for a name.
 */
export function printablePrefix(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''));
  let end = 0;
  while (end < b.length && b[end] >= 0x20 && b[end] <= 0x7e) end++;
  return end >= 2 ? b.subarray(0, end).toString('ascii') : null;
}

/**
 * A coinbase scriptSig, decoded.
 *
 * Layout as the block-creating software writes it: a 3-5 byte little-endian BIP34 block
 * height, then text the pool chose, then the witness-stripping commitment (0xaa21a9ed…)
 * and/or an extra nonce. Everything after the tag is reported as hex, never as text:
 * calling random bytes "text" is how a field starts lying.
 *
 * Verified against a real block: height 966257 decodes to
 *   push0 71be0e        -> 0x0ebe71 little-endian = 966257, equal to getblock.height
 *   push1 "…/ViaBTC/Mined by ecgbtc/"
 *   push2 starts fabe6d6d (the BIP300-style commitment prefix)
 */
export function decodeCoinbase(hex) {
  const { consumed, total, pushes } = parsePushes(hex);
  const out = {
    parseable: pushes.length > 0,
    truncatedAt: consumed < total ? total - consumed : 0,
    height: null,
    tagText: null,
    tag: null,
    commitment: null,
    extraNonce: null,
    raw: String(hex ?? ''),
  };
  if (!out.parseable) return out;

  const first = pushes[0];
  if (first.len >= 1 && first.len <= 5) out.height = first.bytes.readUIntLE(0, first.len);

  // The first push that starts with readable text containing a letter is the tag the
  // pool chose -- the printable *prefix*, because the extra nonce is routinely appended
  // inside the same frame. Anything else in position 1 is reported where it belongs, not
  // dressed up as a name.
  for (let k = 1; k < pushes.length; k++) {
    const s = printablePrefix(pushes[k].bytes);
    if (pushes[k].len >= 2 && s && /[A-Za-z]/.test(s)) {
      out.tagText = s.replace(/\0+$/, '').slice(0, 100);
      out.tag = cleanTag(out.tagText);
      break;
    }
  }

  if (!out.tagText && pushes.length) {
    const runs = printableRuns(out.raw, 4).filter((r) => r.offset >= (pushes[0]?.len ?? 0) + 1);
    if (runs.length) {
      out.tagText = runs[0].text.slice(0, 100);
      out.tag = cleanTag(out.tagText);
      out.tagSource = 'scan';
    }
  } else if (out.tagText) {
    out.tagSource = 'push';
  }

  const rest = pushes.slice(out.tagText ? 2 : 1);
  let joined = rest.map((p) => p.hex).join('');
  // The walk stops at the first frame header it cannot read, and in a lot of real blocks
  // that is exactly where the witness-stripping commitment lives (it begins with the
  // 4-byte marker fabe6d6d, which is not a valid push length). Searching the remainder
  // for the marker is a fact rather than a guess: either the bytes are there or they are
  // not, and finding it recovers the commitment the pushes lost.
  if (!joined.includes('fabe6d6d')) {
    // `consumed` is where the push walk stopped, in bytes -- not the sum of payload
    // lengths, which forgets the length bytes themselves and would search from the
    // wrong place.
    const tail = out.raw.slice(consumed * 2);
    if (tail.includes('fabe6d6d')) joined = tail;
  }
  const at = joined.indexOf('fabe6d6d');
  if (at >= 0) {
    out.commitment = 'fabe6d6d';
    out.commitmentData = joined.slice(at + 8, at + 8 + 64) || null;
    out.extraNonce = joined.slice(0, at) || out.extraNonce || null;
  } else if (joined) {
    out.extraNonce = joined.slice(0, 32) || null;
  }
  return out;
}


/**
 * Every readable run of at least `min` characters in the scriptSig, in order.
 *
 * This exists because some pools write a scriptSig whose push lengths do not describe
 * the bytes that follow them -- the Foundry block at height 966258 declares a 47-byte
 * push inside a 50-byte scriptSig, so the strict push walk stops with no tag even
 * though "Foundry USA Pool #dropgold" is sitting there in ASCII, in order, in the block.
 * Scanning for runs is a weaker claim than parsing, so it is used only as a fallback and
 * it says which one produced the answer (tagSource: 'push' | 'scan'). Neither invents
 * anything: both read bytes the miner put in the block.
 */
export function printableRuns(buf, min = 4) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''), 'hex');
  const runs = [];
  let start = -1;
  for (let i = 0; i < b.length; i++) {
    const ok = b[i] >= 0x20 && b[i] <= 0x7e;
    if (ok && start < 0) start = i;
    if ((!ok || i === b.length - 1) && start >= 0) {
      const end = ok ? i + 1 : i;
      if (end - start >= min) {
        const text = b.subarray(start, end).toString('ascii');
        if (/[A-Za-z]/.test(text)) runs.push({ offset: start, text });
      }
      start = -1;
    }
  }
  return runs;
}

/** Lowercase, control bytes folded, whitespace collapsed -- the form a tag is matched in. */
export function normalizeTagText(s) {
  return String(s ?? '')
    .replace(/\0+/g, ' ')
    .replace(/[\x01-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Look a coinbase up in a curated tag map (data/pool-map.json, written by
 * scripts/pool-map.js from mempool.space's mining-pools data).
 *
 * The haystack is the WHOLE scriptSig as text, not only the extracted tag, because the
 * pool's chosen fragment sometimes sits in a frame the tag walk never reached. Longest
 * literal tag wins; tags under three normalised characters are dropped at build time, so
 * a bare "pool" can never claim a block. Returns null when nothing matches -- the caller
 * then keeps the raw tag and the unknown fingerprint, which is the point of the exercise.
 */
export function matchPool(map, { tagText = '', rawHex = '' } = {}) {
  if (!map?.matchers?.length) return null;
  const hay = normalizeTagText(
    (rawHex ? Buffer.from(String(rawHex), 'hex').toString('utf8') : '') + ' ' + String(tagText ?? ''));
  if (!hay.trim()) return null;
  for (const m of map.matchers) {
    if (m.tagNorm && hay.includes(m.tagNorm)) return { key: m.key, name: m.name, matchedTag: m.tag };
  }
  return null;
}

/**
 * A comparable key for a pool, without pretending to know its brand.
 * "/ViaBTC/Mined by ecgbtc/" -> "viabtc"; "nanopool" -> "nanopool"; a tag with no
 * letters of its own stays "unknown:<hash>" so it is still countable and never silently
 * merged with another pool.
 */
export function cleanTag(tagText) {
  const s = String(tagText ?? '');
  const parts = s.split(/[\/|\s]+/).map((p) => p.trim()).filter((p) => p && p !== '-');
  // Prefer the first token that is not a verb phrase ("Mined by", "Paid to").
  const noisy = /^(mined|paid|pooled|by|via|from|mempool|space|bitdeer|www|http|https)$/i;
  const picked = parts.find((p) => /^[A-Za-z][A-Za-z0-9 ._-]{1,24}$/.test(p) && !noisy.test(p))
    ?? parts.find((p) => /^[A-Za-z][A-Za-z0-9 ._-]{1,24}$/.test(p));
  if (!picked) return null;
  return picked.toLowerCase().replace(/\s+/g, ' ');
}

/** Short, stable fingerprint so unattributed blocks are countable without a name. */
export function tagFingerprint(tagText) {
  const s = String(tagText ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `unknown:${(h >>> 0).toString(16).slice(0, 6)}`;
}

/** What a decoded coinbase plus a getblockstats row becomes in the ledger. */
export function minerRow({ height, hash, decoded, stats, at }) {
  const key = decoded?.tag ? decoded.tag : tagFingerprint(decoded?.tagText ?? '');
  return {
    height,
    hash: hash ?? null,
    at: at ?? null,
    poolKey: key,
    tagText: decoded?.tagText ?? null,
    tagSource: decoded?.tagSource ?? null,
    tagParseable: !!decoded?.parseable,
    tagHeightMatch: decoded?.height != null && stats?.height != null ? decoded.height === stats.height : null,
    weight: stats?.weight ?? null,
    size: stats?.size ?? null,
    strippedSize: stats?.strippedSize ?? null,
    txs: stats?.txs ?? null,
    totalfee: stats?.totalfee ?? null,
    avgFeerate: stats?.avgFeerate ?? null,
    p50: stats?.p1 ?? null,
    p75: stats?.p2 ?? null,
    p99: stats?.p4 ?? null,
    extraNonce: decoded?.extraNonce ?? null,
    commitment: decoded?.commitment ?? null,
    rawCoinbase: decoded?.raw ?? null,
    // 2026-09-16 (audit L4): present only when the coinbase could not be decoded at all.
    ...(decoded?.decodeError ? { decodeError: decoded.decodeError } : {}),
  };
}

/**
 * Fold one block into the per-pool ledger. Counts are per pool over the rows the monitor
 * has actually seen -- it is a window, not history, and callers must present it that way
 * (share % of the observed window, with the window stated).
 */
export function ledgerApply(ledger, row) {
  if (!row?.poolKey) return ledger;
  const p = ledger.get(row.poolKey) ?? {
    poolKey: row.poolKey, tagText: row.tagText, tagTexts: new Set(), label: row.poolLabel ?? null,
    blocks: 0, txs: 0,
    weightSum: 0, feeSum: 0, feerateSum: 0, feerateN: 0,
    firstHeight: row.height, lastHeight: row.height, lastAt: null, sizes: [], feerates: [],
  };
  p.blocks += 1;
  // Keep the distinct coinbase texts that folded into this row: a group is only as
  // trustworthy as its audit trail, and this is what makes 'AntPool971 grouped into
  // AntPool by a curated label' checkable rather than invisible.
  if (row.tagText) { p.tagTexts.add(String(row.tagText).slice(0, 60)); if (!p.tagText) p.tagText = row.tagText; }
  if (row.poolLabel && !p.label) p.label = row.poolLabel;
  p.txs += row.txs ?? 0;
  if (row.weight != null) p.weightSum += row.weight;
  if (row.totalfee != null) p.feeSum += row.totalfee;
  if (row.avgFeerate != null) { p.feerateSum += row.avgFeerate; p.feerateN += 1; p.feerates.push(row.avgFeerate); }
  if (row.size != null) p.sizes.push(row.size);
  p.lastHeight = Math.max(p.lastHeight, row.height);
  p.firstHeight = Math.min(p.firstHeight, row.height);
  p.lastAt = row.at ?? p.lastAt;
  ledger.set(row.poolKey, p);
  return ledger;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Ledger rows, ranked, with the window they describe so a share % is never bare. */
export function ledgerRows(ledger, { keep = 12 } = {}) {
  const all = [...ledger.values()];
  const totalBlocks = all.reduce((n, p) => n + p.blocks, 0);
  return all
    .map((p) => ({
      poolKey: p.poolKey,
      label: p.label ?? null,
      tagText: p.tagText,
      tags: [...(p.tagTexts ?? new Set())].slice(0, 4),
      blocks: p.blocks,
      sharePct: totalBlocks ? +(100 * p.blocks / totalBlocks).toFixed(1) : null,
      txs: p.txs || null,
      avgWeight: p.blocks ? Math.round(p.weightSum / p.blocks) : null,
      medianSize: median(p.sizes),
      avgFeeRate: p.feerateN ? +(p.feerateSum / p.feerateN).toFixed(2) : null,
      medianFeeRate: median(p.feerates),
      totalFeesSat: p.feeSum || null,
      firstHeight: p.firstHeight,
      lastHeight: p.lastHeight,
    }))
    .sort((a, b) => b.blocks - a.blocks || b.lastHeight - a.lastHeight)
    .slice(0, keep);
}

/**
 * Human labels, only from a file a person wrote. Returns null when there is no label --
 * callers show the raw tag in that case, which is the point.
 */
export function aliasFor(table, key) {
  if (!table || !key) return null;
  const hit = table[key] ?? table[String(key).replace(/\s+/g, ' ').trim()];
  return typeof hit === 'string' && hit.trim() ? hit.trim() : null;
}
