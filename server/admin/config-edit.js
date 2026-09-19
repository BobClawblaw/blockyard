// THE CONFIG EDITORS (docs/PLAN-ADMIN-SUITE.md §7, M7).
//
// Two files, two different kinds of danger:
//
//   bitcoin.conf     can lock the operator out of their own node, open it to the world,
//                    or run a command as the node's user
//   BlockYard's own  can turn off the things that restrain this suite
//
// Both are answered the same way since the review of 2026-09-19: by what the editor
// REFUSES, not by how carefully it writes. The first cut refused only the `admin` block
// and acknowledged everything else, and the review found that "everything else" included
// a node config path (so the node editor could be pointed at ~/.bashrc), a section name
// written raw into the file (so one field could add any line), rpcallowip behind a
// checkbox, and -- in BlockYard's own file -- server.trustProxy and auth.enabled, which
// switch off the HTTPS and accounts gates the admin block relies on. Operator, 2026-09-19:
//
//   (1) "The web config editor may NOT touch RPC credentials or binding, and may not
//       redirect which file it writes."
//   (4) "BlockYard's own config editor edits only an ALLOWLIST of display and polling
//       settings; everything else is locked like the admin block."
//
// A suite that can widen its own gates is not restrained by them, and RPC credentials and
// binding are a gate: whoever can rewrite rpcauth or rpcallowip can reach the wallet RPC
// directly, past every check in this directory. The only place those move is a shell.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function deny(message, code = 'admin-refused', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

// What the web never writes in bitcoin.conf (operator decision (1), 2026-09-19). Refused,
// not acknowledged: an acknowledgement is a checkbox, and a checkbox is not a gate.
//
//   credentials and binding  -- the path around every wallet gate in this suite
//   file and chain selection -- move or lock out the node, or silently point it at a
//                               different chain (and a different set of wallets)
export const REFUSED_KEYS = new Set([
  'rpcauth', 'rpcuser', 'rpcpassword', 'rpcbind', 'rpcallowip', 'rpcport', 'rpccookiefile',
  'rpccookieperms', 'rpcwhitelist', 'rpcwhitelistdefault', 'server', 'rest',
  'includeconf', 'conf', 'datadir', 'walletdir', 'blocksdir', 'whitebind', 'whitelist',
  'chain', 'testnet', 'testnet4', 'regtest', 'signet', 'signetchallenge', 'signetseednode',
  // NOT ON THE OPERATOR'S LIST, refused for a worse reason than theirs: each of these runs
  // a shell command as the node's user (signer, an external program), so a config editor
  // that writes them is a remote shell with extra steps. Found while building the list
  // above, 2026-09-19.
  'alertnotify', 'blocknotify', 'walletnotify', 'startupnotify', 'shutdownnotify', 'signer',
  // Paths the node WRITES to, as its own user: a way to clobber any file the node can reach.
  'debuglogfile', 'pid', 'settings', 'ipcbind',
]);
const REFUSED_PREFIXES = ['zmqpub'];   // zmqpubrawtx, zmqpubhashblock, ... -- every one binds a socket

// Values that never go back to a browser, in the file text, the settings list or a diff:
// the refused credential keys, plus Tor's control password.
const SECRET_KEYS = new Set(['rpcauth', 'rpcuser', 'rpcpassword', 'torpassword']);
const REDACTED = '********';

// Changing one of these can end with a node nobody can reach over the network, or a chain
// that has to be downloaded again. They are allowed -- an operator may genuinely need any of
// them -- but each is called out in the diff and needs its own acknowledgement by name.
// The RPC keys that used to head this list are refused above now, not acknowledged.
export const WEIGHTY_KEYS = new Set([
  // who can reach the node over P2P, and how it reaches out
  'bind', 'listen', 'onlynet', 'proxy', 'onion', 'tor', 'listenonion', 'torcontrol', 'externalip', 'discover',
  // what data exists, i.e. what a mistake costs in hours of resync
  'prune', 'txindex', 'blockfilterindex', 'coinstatsindex', 'assumevalid', 'reindex', 'reindex-chainstate',
  // which wallets the node loads
  'wallet', 'disablewallet',
]);
// NOT in that set, deliberately: dbcache, maxconnections, maxuploadtarget and the other
// resource knobs. They can make a node slow; they cannot lock anyone out, open anything up
// or cost a resync. Asking for an acknowledgement on a performance setting is how an
// acknowledgement becomes a thing people click through without reading, which would spend
// the attention this mechanism exists to buy. (Both were in the first draft of this list.)

// The networks a [section] can name. Anything else is refused rather than written: the
// section goes into the file as `[${section}]`, and until 2026-09-19 it went in unchecked --
// a section of "main]\nrpcallowip=0.0.0.0/0\n[main" added a line of the sender's choosing.
export const SECTIONS = new Set(['main', 'test', 'testnet4', 'signet', 'regtest']);

/**
 * A setting name, taken apart the way the node reads it.
 *
 * `main.rpcallowip` is rpcallowip in [main] and `norpcallowip` is rpcallowip negated, so a
 * check that compared the literal name would let either spelling walk past it. Every check
 * runs on the base name, and on the base without its `no` when it has one.
 */
export function keyParts(raw) {
  const key = String(raw ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}(\.[a-zA-Z0-9_-]{1,64})?$/.test(key)) deny(`that is not a setting name: ${key}`, 'key-invalid');
  const dot = key.indexOf('.');
  const qualifier = dot >= 0 ? key.slice(0, dot) : null;
  if (qualifier != null && !SECTIONS.has(qualifier)) deny(`${qualifier} is not a network section, in ${key}`, 'key-invalid');
  const base = (dot >= 0 ? key.slice(dot + 1) : key).toLowerCase();
  const names = base.startsWith('no') && base.length > 2 ? [base, base.slice(2)] : [base];
  return { key, qualifier, base, names };
}

function isRefused(names) {
  return names.some((n) => REFUSED_KEYS.has(n) || REFUSED_PREFIXES.some((p) => n.startsWith(p)));
}
function weightyName(names) { return names.find((n) => WEIGHTY_KEYS.has(n)) ?? null; }
function namesOf(key) {
  // A line the node itself would reject still has to be classified; its literal name will do.
  try { return keyParts(key).names; } catch { return [String(key).toLowerCase()]; }
}
function isSecret(key) { return namesOf(key).some((n) => SECRET_KEYS.has(n)); }

/**
 * Parse bitcoin.conf, keeping everything it is made of.
 *
 * Comments, blank lines, ordering and section headers are preserved as their own entries,
 * and every entry keeps its raw line INCLUDING a CR, because writing the file back means
 * writing back the operator's file -- not a regenerated approximation of the settings this
 * parser happened to understand.
 */
export function parseConf(text) {
  const lines = String(text ?? '').split('\n');
  let section = null;
  return lines.map((raw, i) => {
    const cr = raw.endsWith('\r');
    const line = cr ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    const n = i + 1;
    if (!trimmed) return { kind: 'blank', raw, cr, n };
    if (trimmed.startsWith('#')) return { kind: 'comment', raw, cr, n };
    const sec = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sec) { section = sec[1]; return { kind: 'section', raw, cr, section, n }; }
    const eq = trimmed.indexOf('=');
    if (eq < 0) return { kind: 'other', raw, cr, n };
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    return { kind: 'set', raw, cr, key, value, section, n };
  });
}

/**
 * Back to text. Every line is its raw self; applyChanges gives a new raw only to the lines
 * it changed or added. (Until 2026-09-19 every set line was re-rendered as key=value, so
 * saving one setting rewrote the spacing and line endings of all of them, and the diff.)
 */
export function renderConf(entries) {
  return entries.map((e) => e.raw).join('\n');
}

/** The file with every credential value masked, for anything that goes to a browser. */
export function redactConfText(text) {
  return renderConf(parseConf(text).map((e) => (e.kind === 'set' && isSecret(e.key)
    ? { ...e, raw: `${e.key}=${REDACTED}${e.cr ? '\r' : ''}` } : e)));
}

/** The settings, as a list a UI can show, with their section and line. Credentials masked. */
export function confSettings(entries) {
  return entries.filter((e) => e.kind === 'set').map((e) => {
    const names = namesOf(e.key);
    return {
      key: e.key,
      value: isSecret(e.key) ? REDACTED : e.value,
      section: e.section ?? null,
      line: e.n,
      weighty: weightyName(names) != null,
      // So a UI can grey out what the write would refuse, before anyone types into it.
      editable: !isRefused(names),
    };
  });
}

/**
 * Apply a set of changes to the parsed file.
 *
 * `changes` is [{ key, value, section, remove }]. A key that exists once in its scope is
 * changed in place, keeping its position; a key that does not is added to its scope. A key
 * that exists more than once is refused: bitcoin.conf allows repeats (addnode, and for
 * single-valued keys the node picks one), and editing whichever came first is a guess at
 * which one the operator meant -- found in review 2026-09-19.
 */
export function applyChanges(entries, changes) {
  if (!Array.isArray(changes ?? [])) deny('changes must be a list', 'changes-invalid');
  const out = [...entries];
  const touched = [];
  const eol = entries.some((e) => e.cr) ? '\r' : '';
  for (const change of changes ?? []) {
    if (change == null || typeof change !== 'object') deny('each change is an object', 'changes-invalid');
    const { key, qualifier, names } = keyParts(change.key);
    const section = change.section ?? null;
    if (section !== null && !(typeof section === 'string' && SECTIONS.has(section))) {
      deny(`a section is one of ${[...SECTIONS].join(', ')}`, 'section-invalid');
    }
    if (qualifier && section) deny(`${key} names its network already; do not also give a section`, 'section-invalid');
    if (isRefused(names)) {
      deny(`${key} is not editable from the web interface and must be edited by hand on the machine: `
        + 'RPC credentials and binding are the path around every wallet gate in this suite, and the '
        + 'file, chain and notification settings can move the node, lock it out, or run a command '
        + 'as its user.', 'key-refused', 403);
    }
    const value = change.remove ? null : String(change.value ?? '');
    if (value != null && /[\n\r\0]/.test(value)) deny('a value cannot contain a line break', 'value-invalid');

    const matches = [];
    out.forEach((e, i) => { if (e.kind === 'set' && e.key === key && (e.section ?? null) === section) matches.push(i); });
    if (matches.length > 1) {
      deny(`${key} appears ${matches.length} times${section ? ` in [${section}]` : ' outside any section'}; `
        + 'edit it by hand, so which one you meant is your decision and not a guess', 'key-repeated', 409);
    }
    if (matches.length === 1) {
      const at = matches[0];
      const was = out[at];
      if (change.remove) {
        touched.push({ key, from: was.value, to: null, section });
        out.splice(at, 1);
      } else if (was.value !== value) {
        touched.push({ key, from: was.value, to: value, section });
        out[at] = { ...was, value, raw: `${key}=${value}${was.cr ? '\r' : ''}` };
      }
      continue;
    }
    if (change.remove) continue;   // removing what is not there is not an error

    const line = { kind: 'set', raw: `${key}=${value}${eol}`, cr: !!eol, key, value, section };
    const needsHeader = section != null && !out.some((e) => e.kind === 'section' && e.section === section);
    const added = needsHeader ? [{ kind: 'section', raw: `[${section}]${eol}`, cr: !!eol, section }, line] : [line];
    out.splice(insertionPoint(out, section), 0, ...added);
    touched.push({ key, from: null, to: value, section });
  }
  return { entries: out, touched };
}

/**
 * Where a new line for `section` goes.
 *
 * After the last setting already in that scope; failing that, right under the section's
 * header -- or, for a global key, above the first header, because a line appended to the
 * end of the file is inside whatever section came last. That was the bug until 2026-09-19:
 * a global key added to a file ending in [main] became a mainnet-only key. A section that
 * does not exist yet goes at the end, above any trailing blank lines, so a file that ended
 * with a newline still does.
 */
function insertionPoint(out, section) {
  let lastSet = -1;
  let header = -1;
  let firstHeader = -1;
  out.forEach((e, i) => {
    if (e.kind === 'section') {
      if (firstHeader < 0) firstHeader = i;
      if (e.section === section) header = i;
    }
    if (e.kind === 'set' && (e.section ?? null) === section) lastSet = i;
  });
  if (lastSet >= 0) return lastSet + 1;
  if (section == null) return firstHeader >= 0 ? firstHeader : endOfContent(out);
  if (header >= 0) return header + 1;
  return endOfContent(out);
}
function endOfContent(out) {
  let end = out.length;
  while (end > 0 && out[end - 1].kind === 'blank') end--;
  return end;
}

/**
 * A line diff a person can read, rather than a character one they cannot.
 *
 * The common head and tail are dropped first, so one inserted line reads as one line and
 * not as every line below it shifted -- which, for a file with a password below the edit,
 * was also how the password reached the browser (review 2026-09-19). Callers diff redacted
 * text as well; this makes the diff readable, the redaction makes it safe.
 */
export function diffText(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const rows = [];
  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  for (let i = 0; i < Math.max(aEnd, bEnd) - head; i++) {
    const x = head + i < aEnd ? a[head + i] : undefined;
    const y = head + i < bEnd ? b[head + i] : undefined;
    if (x === y) continue;
    if (x !== undefined) rows.push({ sign: '-', line: x, n: head + i + 1 });
    if (y !== undefined) rows.push({ sign: '+', line: y, n: head + i + 1 });
  }
  return rows;
}

/**
 * The node's config file: <datadir>/bitcoin.conf, and only that.
 *
 * A per-node `confFile` used to win over the datadir, unchecked -- and with BlockYard's own
 * editor able to write nodes[] at the time, the chain was: set confFile to ~/.bashrc, then
 * "edit a setting" in it (review 2026-09-19, H1). The path is now fixed by the datadir, and
 * a confFile that disagrees is a refusal to read or write, not a choice between the two:
 * the file at the datadir is not the one the node reads, so showing or editing it would be
 * editing the wrong file with a straight face.
 */
export function confPathFor(app, nodeId) {
  const m = app.monitors.get(nodeId);
  if (!m) deny(`no such node: ${nodeId}`, 'no-such-node', 404);
  if (!m.cfg?.datadir) {
    deny('this node has no datadir, so its bitcoin.conf cannot be found from here', 'no-conf-file', 409);
  }
  const file = path.join(path.resolve(m.cfg.datadir), 'bitcoin.conf');
  const explicit = m.cfg?.confFile ?? null;
  if (explicit != null && path.resolve(String(explicit)) !== file) {
    deny(`this node reads its configuration from ${explicit}, not ${file}. The web editor only edits `
      + '<datadir>/bitcoin.conf; edit that file by hand on the machine.', 'conf-file-elsewhere', 409);
  }
  return file;
}

/**
 * Open a config file without following a link, and say what it is.
 *
 * O_NOFOLLOW makes the check and the read one step, so a link swapped in between them is
 * an error rather than a read of wherever it points. A link is refused rather than
 * followed for a second reason: the write replaces the directory entry, so it would turn
 * the operator's link into a plain file.
 */
async function openConfig(file) {
  let fh;
  try { fh = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (err) {
    if (err.code === 'ENOENT') deny(`there is no file at ${file}; create it by hand, owned by the user that reads it`, 'no-conf-file', 404);
    if (err.code === 'ELOOP') deny(`${file} is a symbolic link; the web editor edits only a regular file. Edit it by hand.`, 'conf-not-regular', 409);
    if (err.code === 'EACCES') deny(`${file} is not readable by this monitor`, 'conf-unreadable', 403);
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) deny(`${file} is not a regular file; edit it by hand`, 'conf-not-regular', 409);
    return { st, text: await fh.readFile('utf8') };
  } finally { await fh.close(); }
}

/**
 * Can a replacement file be given this one's owner and group? null if so, the reason if not.
 *
 * The write is a rename of a new file over the old, and a new file belongs to whoever made
 * it. Until 2026-09-19 that meant bitcoin.conf became BlockYard's, mode 0600 -- and a node
 * running as its own `bitcoin` user could no longer read its own config at the next start
 * (review, H4). Root can hand ownership back; anyone else can keep only their own uid, and
 * only a group they are in. `proc` is injectable so the refusal is testable without root.
 */
export function ownershipProblem(st, proc = { uid: process.getuid(), gids: [process.getegid(), ...process.getgroups()] }) {
  if (proc.uid === 0) return null;
  if (st.uid !== proc.uid) {
    return `it is owned by uid ${st.uid} and this monitor runs as uid ${proc.uid}, so a rewritten file `
      + 'would belong to the monitor and the node might no longer be able to read it';
  }
  if (!proc.gids.includes(st.gid)) {
    return `its group ${st.gid} is not one this monitor is in, so a rewritten file could not keep that group`;
  }
  return null;
}

/**
 * Replace `file` with `after`, atomically, keeping its mode and ownership, after a backup.
 *
 * Every created file is opened 'wx' under a random name, so nothing already there -- a
 * planted link included -- is followed or truncated. The backup is written from the same
 * bytes the diff was computed from rather than copied from the path again, which could by
 * then be a different file; and it is 0600, because it holds the RPC credentials.
 */
async function replaceFile(file, st, before, after) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(6).toString('hex');
  const backup = `${file}.bak-${stamp}-${rand}`;
  try { await fsp.writeFile(backup, before, { flag: 'wx', mode: 0o600 }); } catch (err) {
    deny(`could not back up ${file}, so it was not changed: ${err.message}`, 'backup-failed', 500);
  }
  const tmp = `${file}.tmp-${rand}`;
  let fh = null;
  try {
    fh = await fsp.open(tmp, 'wx', 0o600);
    await fh.writeFile(after);
    if (process.getuid() === 0 || st.gid !== process.getegid()) await fh.chown(st.uid, st.gid);
    // After chown (which can clear setgid bits), and exact: the umask trims the mode open() is given.
    await fh.chmod(st.mode & 0o7777);
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, file);
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    deny(`could not write ${file}: ${err.message} (it is unchanged; ${backup} is a copy of it)`, 'write-failed', 500);
  }
  return backup;
}

/** Read it, parse it, and say what is in it -- with every credential value masked. */
export async function readNodeConf(app, nodeId) {
  const file = confPathFor(app, nodeId);
  const { text } = await openConfig(file);
  const entries = parseConf(text);
  return { file, text: redactConfText(text), settings: confSettings(entries), lines: entries.length };
}

/**
 * Write it back, through a backup, atomically.
 *
 * Everything that can refuse runs before anything is written -- the key checks, the
 * acknowledgements, the ownership check -- so a refusal leaves no backup, no temp file and
 * no changed file behind.
 */
export async function writeNodeConf(app, ctx, nodeId, { changes, acknowledge = [] }) {
  if (!Array.isArray(acknowledge) || acknowledge.some((k) => typeof k !== 'string')) {
    // A string was accepted until 2026-09-19, and `includes` on a string is a substring test:
    // acknowledging "rpcbind" also acknowledged "bind".
    deny('acknowledge is a list of setting names', 'acknowledge-invalid');
  }
  const file = confPathFor(app, nodeId);
  const { st, text: before } = await openConfig(file);
  const { entries, touched } = applyChanges(parseConf(before), changes);
  const after = renderConf(entries);
  if (after === before) return { ok: true, file, unchanged: true, touched: [], diff: [] };

  // Every weighty key in this change is named in `acknowledge`, exactly -- by its base name
  // or as written. Not one "yes I am sure" for the whole edit: the operator says which
  // dangerous thing they meant.
  const missing = [...new Set(touched
    .map((t) => ({ key: t.key, weighty: weightyName(keyParts(t.key).names) }))
    .filter((t) => t.weighty && !acknowledge.includes(t.weighty) && !acknowledge.includes(t.key))
    .map((t) => t.weighty))];
  if (missing.length) {
    deny(`these settings can cut the node off from the network or cost a resync: ${missing.join(', ')}. `
      + 'Acknowledge each one by name to write it.', 'acknowledge-required');
  }
  const owner = ownershipProblem(st);
  if (owner) deny(`${file} was not changed: ${owner}. Edit it by hand as its owner.`, 'conf-owner', 409);

  const backup = await replaceFile(file, st, before, after);

  await app.audit({
    type: 'admin-node-conf-write',
    username: ctx.user?.username ?? null,
    node: nodeId, file, backup,
    // The KEYS, and never the values.
    keys: touched.map((t) => t.key),
  });

  return {
    ok: true, file, backup, touched: touched.map((t) => ({ key: t.key, section: t.section })),
    diff: diffText(redactConfText(before), redactConfText(after)),
    // Nothing here takes effect until the node is restarted, and a config screen that does
    // not say so produces an operator who thinks they changed something.
    needsRestart: true,
  };
}

// ----------------------------------------------------------------- BlockYard's own

/** The block refused with its own message, by name, so the refusal is testable. */
export const LOCKED_BLOCKS = Object.freeze(['admin']);

/**
 * What the web may change in BlockYard's own config: display and polling, nothing else
 * (operator decision (4), 2026-09-19). Built by reading server/config.js DEFAULTS leaf by
 * leaf; test/admin-config-edit-hardening.test.js checks every entry still exists there
 * with this type and a default inside this range, so the two cannot drift apart silently.
 *
 *   poll.*        how often each RPC tier runs. The node's lane is protected regardless by
 *                 rpc.maxRatePerSec, which is NOT here; the 1 s floor keeps a typo from
 *                 being a busy loop. blockBackfill is blocks read at start, capped at two
 *                 weeks of them.
 *   markets.*     the Markets tab's cadence and its on switch. The switch only builds the
 *                 feed; polling still waits for the Display setting, so this cannot start
 *                 outbound traffic by itself.
 *   store tuning  how much history is kept, bounded so a slipped digit cannot exhaust
 *                 memory (the block map costs ~310 B a row, measured 2026-09-09). NOT
 *                 store.dir (a path), and NOT auditMaxBytes or auditKeep: shrinking the
 *                 audit trail from the web is erasing the evidence of the web.
 *   log.staleMs, log.healthMs   when the log-silence warning fires. NOT log.enabled or
 *                 level: the log source is off against Core by decision (AGENTS.md), and
 *                 the level decides what the operator can see afterwards.
 *
 * Everything else is locked: admin, auth, server (tls, trustProxy, host, allowCidrs, port
 * -- the HTTPS and reachability gates the admin block leans on), actions, nodes (paths,
 * rpcUrl, credentials, supervisor), rpc, and every path or credential anywhere.
 */
export const SELF_EDITABLE = new Map([
  ['poll.fastMs', { type: 'number', min: 1000, max: 3_600_000 }],
  ['poll.midMs', { type: 'number', min: 1000, max: 3_600_000 }],
  ['poll.poolMs', { type: 'number', min: 1000, max: 3_600_000 }],
  ['poll.slowMs', { type: 'number', min: 1000, max: 86_400_000 }],
  ['poll.rareMs', { type: 'number', min: 1000, max: 86_400_000 }],
  ['poll.blockBackfill', { type: 'number', min: 0, max: 2016 }],
  ['markets.enabled', { type: 'boolean' }],
  ['markets.tickerMs', { type: 'number', min: 1000, max: 86_400_000 }],
  ['markets.candleMs', { type: 'number', min: 1000, max: 86_400_000 }],
  ['markets.bookMs', { type: 'number', min: 1000, max: 86_400_000 }],
  ['markets.idleAfterMs', { type: 'number', min: 1000, max: 86_400_000 }],
  ['markets.timeoutMs', { type: 'number', min: 1000, max: 120_000 }],
  ['store.retentionHours', { type: 'number', min: 1, max: 8760 }],
  ['store.ringCapacity', { type: 'number', min: 100, max: 200_000 }],
  ['store.maxEventLog', { type: 'number', min: 100, max: 200_000 }],
  ['store.blockMapCap', { type: 'number', min: 100, max: 200_000 }],
  ['store.snapshotEveryMs', { type: 'number', min: 10_000, max: 86_400_000 }],
  ['log.staleMs', { type: 'number', min: 60_000, max: 86_400_000 }],
  ['log.healthMs', { type: 'number', min: 1000, max: 3_600_000 }],
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The patch as [dotted path, value] leaves. An array or an empty object is a leaf, so
 * `{ server: {} }` and `{ nodes: [...] }` name a block and are refused as one.
 */
function patchLeaves(obj, prefix = '', out = []) {
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k)) deny(`"${k}" is not a setting name`, 'patch-invalid');
    const dotted = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (isPlain(v) && Object.keys(v).length) patchLeaves(v, dotted, out);
    else out.push([dotted, v]);
  }
  return out;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (isPlain(o) && Object.hasOwn(o, k) ? o[k] : undefined), obj);
}

/**
 * BlockYard's own config: the editable settings with the values in force, and the admin
 * block read-only.
 *
 * Values in force come from the loaded config rather than the file, because a setting the
 * file does not mention is still in force at its default and the UI should show it. They
 * are all numbers and switches, so there is nothing to mask -- which is the point: the
 * first cut returned the whole loaded config with passwords masked, the mask round-tripped
 * into the file as a literal `********`, and every env- and boot-derived value came back
 * with it and was frozen into the file (review 2026-09-19, M1).
 */
export function readOwnConfig(app) {
  const cfg = app.cfg ?? {};
  const editable = {};
  for (const dotted of SELF_EDITABLE.keys()) {
    const v = getPath(cfg, dotted);
    if (v === undefined) continue;
    const parts = dotted.split('.');
    let cur = editable;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {});
    cur[parts.at(-1)] = v;
  }
  return {
    file: app.configFile ?? null,
    editable,
    editableKeys: [...SELF_EDITABLE.keys()],
    rules: Object.fromEntries(SELF_EDITABLE),
    // Shown, so the operator can see what is in force, and flagged as unwritable here.
    locked: { admin: cfg.admin ?? null },
    lockedNote: 'Only the display and polling settings listed here are editable from the web interface. '
      + 'The admin block, accounts, the server and TLS settings, actions, nodes and RPC are not, by design: '
      + 'a suite that can widen its own gates is not restrained by them. Change them on disk and restart.',
  };
}

/** Any key that looks like a secret, masked at any depth -- for the own config's diff. */
function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!isPlain(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /password|secret|passphrase|token/i.test(k) && v != null ? REDACTED : redactJson(v);
  }
  return out;
}

/** Write BlockYard's own config: the allowlisted settings, into the file's own JSON. */
export async function writeOwnConfig(app, ctx, { patch }) {
  if (!app.configFile) deny('this monitor was started without a config file, so there is nothing to write', 'no-config-file', 409);
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) deny('send an object of settings to change', 'patch-invalid');
  for (const block of LOCKED_BLOCKS) {
    if (Object.hasOwn(patch, block)) {
      deny(`the "${block}" block is not editable from the web interface: it is what restrains this interface. `
        + 'Change it on disk and restart.', 'block-locked', 403);
    }
  }
  // Every leaf is checked before any is applied: one locked key refuses the whole patch, so
  // nothing half-applies. The mask a read hands out means "unchanged", never a value.
  const leaves = patchLeaves(patch).filter(([, v]) => v !== REDACTED);
  for (const [dotted] of leaves) {
    if (!SELF_EDITABLE.has(dotted)) {
      deny(`${dotted} is not editable from the web interface; only the display and polling settings are. `
        + 'Change it on disk and restart.', 'setting-locked', 403);
    }
  }
  for (const [dotted, v] of leaves) {
    const rule = SELF_EDITABLE.get(dotted);
    if (typeof v !== rule.type) deny(`${dotted} must be a ${rule.type}`, 'value-invalid');
    if (rule.type === 'number' && !(Number.isInteger(v) && v >= rule.min && v <= rule.max)) {
      deny(`${dotted} must be a whole number from ${rule.min} to ${rule.max}`, 'value-invalid');
    }
  }

  // The FILE's own JSON, not the loaded config: what is written back is what the operator
  // wrote plus these leaves, and nothing the defaults, the env or the boot contributed.
  const { st, text: before } = await openConfig(app.configFile);
  let current;
  try { current = JSON.parse(before); } catch (err) {
    deny(`${app.configFile} is not valid JSON (${err.message}); fix it by hand`, 'config-invalid', 409);
  }
  if (!isPlain(current)) deny(`${app.configFile} is not a JSON object; fix it by hand`, 'config-invalid', 409);

  const next = structuredClone(current);
  for (const [dotted, v] of leaves) {
    const parts = dotted.split('.');
    let cur = next;
    for (const [i, p] of parts.slice(0, -1).entries()) {
      if (!Object.hasOwn(cur, p)) cur[p] = {};
      if (!isPlain(cur[p])) deny(`${parts.slice(0, i + 1).join('.')} in ${app.configFile} is not an object; fix it by hand`, 'value-invalid');
      cur = cur[p];
    }
    cur[parts.at(-1)] = v;
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, file: app.configFile, unchanged: true, diff: [] };
  const owner = ownershipProblem(st);
  if (owner) deny(`${app.configFile} was not changed: ${owner}.`, 'config-owner', 409);

  const after = `${JSON.stringify(next, null, 2)}\n`;
  const backup = await replaceFile(app.configFile, st, before, after);
  const keys = leaves.map(([k]) => k);
  await app.audit({
    type: 'admin-own-config-write',
    username: ctx.user?.username ?? null,
    file: app.configFile, backup, keys,
  });
  return {
    ok: true, file: app.configFile, backup, keys,
    // Masked, re-indented JSON on both sides: the file on disk may not be two-space
    // indented, and re-indenting moves every line -- node passwords included -- into a diff.
    diff: diffText(`${JSON.stringify(redactJson(current), null, 2)}\n`, `${JSON.stringify(redactJson(next), null, 2)}\n`),
    needsRestart: true,
  };
}

/** Used by the tests, and by a future "is this file still there" check. */
export function confExists(file) { return fs.existsSync(file); }
