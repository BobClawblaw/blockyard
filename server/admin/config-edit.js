// THE CONFIG EDITORS (docs/PLAN-ADMIN-SUITE.md §7, M7).
//
// Two files, two different kinds of danger:
//
//   bitcoin.conf     can lock the operator out of their own node, or open it to the world
//   BlockYard's own  can turn off the things that restrain this suite
//
// The second is handled by a carve-out rather than by care: **the `admin` block is not
// editable from here at all.** Not validated-and-then-written, not warned about — refused,
// with the whole block returned read-only so the UI can show it greyed. A suite that can
// widen its own gates, grant walletAccess or raise a spend cap is not restrained by them,
// and the only place those move is a shell on the host.
//
// For bitcoin.conf the danger is different: the node's config is the node's, and this
// suite has no business deciding which settings are sensible. What it does instead is
// read it faithfully, write it back atomically with a timestamped backup, show a real diff
// first, and name the keys whose change can cost the operator access before they commit.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

function deny(message, code = 'admin-refused', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

// Changing one of these can end with a node nobody can reach, a node everybody can reach,
// or a chain that has to be downloaded again. They are not refused -- an operator may
// genuinely need to change any of them -- but each is called out in the diff and needs its
// own acknowledgement.
export const WEIGHTY_KEYS = new Set([
  // who can reach the node, and with what credential
  'rpcauth', 'rpcpassword', 'rpcuser', 'rpcallowip', 'rpcbind', 'rpcport',
  'bind', 'listen', 'onlynet', 'proxy', 'tor', 'onion',
  // what data exists, i.e. what a mistake costs in hours of resync
  'prune', 'txindex', 'blockfilterindex', 'coinstatsindex', 'assumevalid',
  // where the node and its wallets live
  'wallet', 'disablewallet', 'datadir',
]);
// NOT in that set, deliberately: dbcache, maxconnections, maxuploadtarget and the other
// resource knobs. They can make a node slow; they cannot lock anyone out, open anything up
// or cost a resync. Asking for an acknowledgement on a performance setting is how an
// acknowledgement becomes a thing people click through without reading, which would spend
// the attention this mechanism exists to buy. (Both were in the first draft of this list.)

/**
 * Parse bitcoin.conf, keeping everything it is made of.
 *
 * Comments, blank lines, ordering and section headers are preserved as their own entries,
 * because writing the file back means writing back the operator's file -- not a
 * regenerated approximation of the settings this parser happened to understand.
 */
export function parseConf(text) {
  const lines = String(text ?? '').split('\n');
  let section = null;
  return lines.map((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed) return { kind: 'blank', raw: line, n: i + 1 };
    if (trimmed.startsWith('#')) return { kind: 'comment', raw: line, n: i + 1 };
    const sec = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sec) { section = sec[1]; return { kind: 'section', raw: line, section, n: i + 1 }; }
    const eq = trimmed.indexOf('=');
    if (eq < 0) return { kind: 'other', raw: line, n: i + 1 };
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    return { kind: 'set', raw: line, key, value, section, n: i + 1 };
  });
}

/** Back to text, from the parsed form. Round-trips byte for byte when nothing changed. */
export function renderConf(entries) {
  return entries.map((e) => (e.kind === 'set' ? `${e.key}=${e.value}` : e.raw)).join('\n');
}

/** The settings, as a list a UI can show, with their section and line. */
export function confSettings(entries) {
  return entries.filter((e) => e.kind === 'set').map((e) => ({
    key: e.key, value: e.value, section: e.section ?? null, line: e.n, weighty: WEIGHTY_KEYS.has(e.key),
  }));
}

/**
 * Apply a set of changes to the parsed file.
 *
 * `changes` is [{ key, value, section, remove }]. A key that exists is changed in place,
 * keeping its position and its section; a key that does not is appended to its section.
 * Nothing is reordered and nothing else is touched, which is what makes the diff small
 * enough to actually read.
 */
export function applyChanges(entries, changes) {
  const out = [...entries];
  const touched = [];
  for (const change of changes ?? []) {
    const key = String(change.key ?? '').trim();
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) deny(`that is not a setting name: ${key}`, 'key-invalid');
    const section = change.section ?? null;
    const value = change.remove ? null : String(change.value ?? '');
    if (value != null && /[\n\r]/.test(value)) deny('a value cannot contain a line break', 'value-invalid');

    const at = out.findIndex((e) => e.kind === 'set' && e.key === key && (e.section ?? null) === section);
    if (at >= 0) {
      if (change.remove) { touched.push({ key, from: out[at].value, to: null, section }); out.splice(at, 1); }
      else { touched.push({ key, from: out[at].value, to: value, section }); out[at] = { ...out[at], value }; }
      continue;
    }
    if (change.remove) continue;   // removing what is not there is not an error
    // Append inside the section, at its end, or at the end of the file for the global one.
    let insertAt = out.length;
    if (section) {
      const start = out.findIndex((e) => e.kind === 'section' && e.section === section);
      if (start < 0) {
        out.push({ kind: 'section', raw: `[${section}]`, section });
        insertAt = out.length;
      } else {
        let end = start + 1;
        while (end < out.length && out[end].kind !== 'section') end++;
        insertAt = end;
      }
    }
    out.splice(insertAt, 0, { kind: 'set', raw: `${key}=${value}`, key, value, section });
    touched.push({ key, from: null, to: value, section });
  }
  return { entries: out, touched };
}

/** A line diff a person can read, rather than a character one they cannot. */
export function diffText(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const rows = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) rows.push({ sign: '-', line: a[i], n: i + 1 });
    if (b[i] !== undefined) rows.push({ sign: '+', line: b[i], n: i + 1 });
  }
  return rows;
}

/** Where the node's config is, if the operator told us. */
export function confPathFor(app, nodeId) {
  const m = app.monitors.get(nodeId);
  if (!m) deny(`no such node: ${nodeId}`, 'no-such-node', 404);
  const explicit = m.cfg?.confFile ?? null;
  const fromDatadir = m.cfg?.datadir ? path.join(m.cfg.datadir, 'bitcoin.conf') : null;
  const file = explicit ?? fromDatadir;
  if (!file) {
    deny('this node has no datadir and no confFile, so its configuration file cannot be found from here', 'no-conf-file', 409);
  }
  return file;
}

/** Read it, parse it, and say what is in it. */
export async function readNodeConf(app, nodeId) {
  const file = confPathFor(app, nodeId);
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') deny(`there is no file at ${file}`, 'no-conf-file', 404);
    if (err.code === 'EACCES') deny(`${file} is not readable by this monitor`, 'conf-unreadable', 403);
    throw err;
  }
  const entries = parseConf(text);
  return { file, text, settings: confSettings(entries), lines: entries.length };
}

/**
 * Write it back, through a backup, atomically.
 *
 * The backup is the same convention scripts/setup.js already uses, and it is taken before
 * anything is written -- so the worst outcome of a bad edit is a file to copy back rather
 * than a node that will not start and no way to see what it used to say.
 */
export async function writeNodeConf(app, ctx, nodeId, { changes, acknowledge = [] }) {
  const file = confPathFor(app, nodeId);
  const before = await fsp.readFile(file, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  const { entries, touched } = applyChanges(parseConf(before), changes);
  const after = renderConf(entries);
  if (after === before) return { ok: true, file, unchanged: true, touched: [], diff: [] };

  // Every weighty key in this change has to be named in `acknowledge`. Not a single
  // "yes I am sure" for the whole edit: the operator says which dangerous thing they meant.
  const weighty = touched.filter((t) => WEIGHTY_KEYS.has(t.key)).map((t) => t.key);
  const missing = weighty.filter((k) => !acknowledge.includes(k));
  if (missing.length) {
    deny(`these settings can cost you access to the node or open it up: ${missing.join(', ')}. `
      + 'Acknowledge each one by name to write it.', 'acknowledge-required');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-${stamp}`;
  await fsp.copyFile(file, backup).catch((err) => {
    if (err.code !== 'ENOENT') deny(`could not back up ${file}: ${err.message}`, 'backup-failed', 500);
  });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, after, { mode: 0o600 });
  await fsp.rename(tmp, file);

  await app.audit({
    type: 'admin-node-conf-write',
    username: ctx.user?.username ?? null,
    node: nodeId, file, backup,
    // The KEYS, and never the values: rpcpassword is one of these.
    keys: touched.map((t) => t.key),
  });

  return {
    ok: true, file, backup, touched: touched.map((t) => ({ key: t.key, section: t.section })),
    diff: diffText(before, after),
    // Nothing here takes effect until the node is restarted, and a config screen that does
    // not say so produces an operator who thinks they changed something.
    needsRestart: true,
  };
}

/**
 * BlockYard's own config, read-only in one specific place.
 *
 * Returns the whole thing with `admin` separated out, so a UI can render it and mark it
 * as what it is: the block that restrains this suite, which this suite may not edit.
 */
export function readOwnConfig(app) {
  const cfg = app.cfg ?? {};
  const { admin, ...rest } = cfg;
  return {
    file: app.configFile ?? null,
    editable: redactConfig(rest),
    // Shown, so the operator can see what is in force, and flagged as unwritable here.
    locked: { admin: admin ?? null },
    lockedNote: 'The admin block is not editable from the web interface, by design: a suite that can '
      + 'widen its own gates is not restrained by them. Change it on disk and restart.',
  };
}

/** Never hand a password back to a browser, even to an administrator. */
function redactConfig(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg ?? {}));
  for (const node of clone.nodes ?? []) {
    if (node.rpcPassword) node.rpcPassword = '********';
    if (node.rpcUser) node.rpcUser = String(node.rpcUser);
  }
  if (clone.auth?.secret) clone.auth.secret = '********';
  return clone;
}

/** The block the suite refuses to write, by name, so the refusal is testable. */
export const LOCKED_BLOCKS = Object.freeze(['admin']);

/** Write BlockYard's own config -- anything except the locked blocks. */
export async function writeOwnConfig(app, ctx, { patch }) {
  if (!app.configFile) deny('this monitor was started without a config file, so there is nothing to write', 'no-config-file', 409);
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) deny('send an object of settings to change', 'patch-invalid');
  for (const block of LOCKED_BLOCKS) {
    if (Object.prototype.hasOwnProperty.call(patch, block)) {
      deny(`the "${block}" block is not editable from the web interface: it is what restrains this interface. `
        + 'Change it on disk and restart.', 'block-locked', 403);
    }
  }

  const before = await fsp.readFile(app.configFile, 'utf8');
  const current = JSON.parse(before);
  const next = { ...current, ...patch };
  // Whatever the patch said, the locked blocks come from the file on disk. Belt and
  // braces: the check above refuses them, and this makes a miss harmless.
  for (const block of LOCKED_BLOCKS) {
    if (Object.prototype.hasOwnProperty.call(current, block)) next[block] = current[block];
    else delete next[block];
  }

  const after = `${JSON.stringify(next, null, 2)}\n`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${app.configFile}.bak-${stamp}`;
  await fsp.copyFile(app.configFile, backup);
  const tmp = `${app.configFile}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, after, { mode: 0o600 });
  await fsp.rename(tmp, app.configFile);

  await app.audit({
    type: 'admin-own-config-write',
    username: ctx.user?.username ?? null,
    file: app.configFile, backup, blocks: Object.keys(patch),
  });
  return { ok: true, file: app.configFile, backup, diff: diffText(before, after), needsRestart: true };
}

/** Used by the tests, and by a future "is this file still there" check. */
export function confExists(file) { return fs.existsSync(file); }
