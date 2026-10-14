import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This repository gets pushed. Everything in it is therefore public to whoever can
// see the remote, and the things most likely to slip in are not secrets in the
// API-key sense -- they are the machine's own username and addresses, which ride
// along in systemd units, doc examples and test fixtures without anyone deciding
// to publish them.
//
// So this test does NOT hardcode the values it forbids (that would put them right
// back into the repo). It derives them from the machine at run time and fails if
// any of them appear in a tracked file.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    return null; // not a git checkout; nothing to check
  }
}

// ACCOUNTS THAT NAME A MACHINE, NOT A PERSON. A GitHub runner's username is `runner`; a
// container's is often `root` or `ubuntu`. Those are ordinary English words, and "the test
// runner's own TAP output" -- which appears in three tracked files -- is not a privacy leak.
//
// This file already reasons exactly this way about the bare hostname ("a common English word,
// and matching it would flag ordinary prose"). Usernames never got the same treatment, because
// on the machine this was written on the username is distinctive, so it never fired. The first
// CI run found it immediately: three sentences about test runners, reported as identity leaks.
//
// The guard stays ON in CI -- a push is exactly when leaked identity would escape. What changes
// is that a generic account name is not an identity worth guarding.
export const GENERIC_ACCOUNTS = new Set([
  'runner', 'root', 'user', 'users', 'admin', 'administrator', 'build', 'builder',
  'ubuntu', 'debian', 'centos', 'fedora', 'alpine', 'node', 'nobody', 'default',
  'ci', 'github', 'gitlab', 'jenkins', 'travis', 'circleci', 'vsts', 'azureuser',
  'docker', 'vagrant', 'codespace', 'devcontainer', 'runneradmin',
]);
export const isGenericAccount = (u) => GENERIC_ACCOUNTS.has(String(u ?? '').toLowerCase());

/** Identifiers that say "this particular person's machine". */
function machineIdentity() {
  const out = [];
  const user = os.userInfo().username;
  // A short username can sit inside an ordinary word, so matches are word-bounded.
  if (user && user.length >= 3 && !isGenericAccount(user)) {
    out.push({ kind: 'username', re: new RegExp(`\\b${esc(user)}\\b`, 'i'), shown: user });
  }

  // The bare hostname here is a common English word, and matching it would flag
  // ordinary prose. The resolvable forms are specific enough to be worth checking.
  const host = os.hostname();
  if (host) for (const form of [`${host}.local`, `${host}.lan`, `${host}.internal`]) {
    out.push({ kind: 'hostname', re: new RegExp(esc(form), 'i'), shown: form });
  }

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // Ephemeral bridge IPs (docker0, br-*, veth*) churn and identify nothing about
    // a person; the routed interfaces are the ones worth keeping private.
    if (/^(docker|br-|veth|virbr|lo)/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      out.push({ kind: `interface ${name}`, re: new RegExp(esc(a.address), 'i'), shown: a.address });
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// WORDS THE OPERATOR NAMES AS PRIVATE (2026-10-14; operator: "Don't leak my locations"). The weather feature put the
// operator's own town in a test, a script comment and three screenshots, and the machine-derived rules above cannot know
// a town's name. So a git-ignored file, config/private-terms.txt -- one term a line, # comments -- lists what this
// working copy must never publish, and every tracked TEXT file is checked for each term, word-bounded, whatever its
// case. The file is deliberately absent from the repository (listing the terms here would publish them), so CI and a
// fresh clone check nothing extra; the guard runs where the terms are known, which is where the commits are made.
export function privateTerms(file = path.join(ROOT, 'config', 'private-terms.txt')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l.length >= 3)
    .map((t) => ({ kind: 'private term', re: new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`, 'i'), shown: t }));
}
const TEXT_FILE = /\.(js|mjs|cjs|ts|json|md|txt|html|css|svg|yml|yaml|sh|service|conf|cfg|ini|toml|csv|xml|py|mk|gitignore|dockerignore|npmignore|editorconfig)$|^[^.]+$/i;

test('no tracked file contains this machine username, hostname or addresses', () => {
  const files = trackedFiles();
  if (files === null) return; // skip outside a git checkout
  const identity = machineIdentity();

  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const id of identity) {
      // THE PLACE NAMES OF THE WORLD are not this machine's identity (2026-10-13): public/geo/places-10m.json is
      // Natural Earth's 7,342 towns, and one of them will coincide with somebody's account name (Xi'an did here).
      // The username check alone is set aside for the geo data files; hostnames and addresses are still checked.
      if (id.kind === 'username' && /^public\/geo\/[a-z0-9-]+\.json$/.test(f)) continue;
      if (id.re.test(text)) hits.push(`${f} contains ${id.kind} "${id.shown}"`);
    }
  }
  assert.deepEqual(hits, [], `personal/host identifiers would be published:\n  ${hits.join('\n  ')}`);
});

test('no tracked text file contains a term config/private-terms.txt names as private', () => {
  const files = trackedFiles();
  if (files === null) return;
  const terms = privateTerms();
  if (!terms.length) return; // no list on this machine: nothing extra to check (CI, a fresh clone)
  const hits = [];
  for (const f of files) {
    if (!TEXT_FILE.test(f)) continue;
    // the geography carries every town's name (public/geo/places-10m.json is Natural Earth's list): a town being on the
    // map of the world is not a leak; a town being named in OUR text is
    if (/^public\/geo\/[a-z0-9-]+\.json$/.test(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const t of terms) if (t.re.test(text)) hits.push(`${f} contains ${t.kind} "${t.shown}"`);
  }
  assert.deepEqual(hits, [], `terms the operator marked private would be published:\n  ${hits.join('\n  ')}`);
});

test('the private-terms list is read as words, case-blind, and may be absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'by-priv-'));
  const file = path.join(dir, 'terms.txt');
  assert.deepEqual(privateTerms(file), [], 'no file, no terms');
  fs.writeFileSync(file, '# my town\nSpringfield\n  47.61, -122.33  \nab\n\n');
  const ts = privateTerms(file);
  assert.deepEqual(ts.map((t) => t.shown), ['Springfield', '47.61, -122.33'], 'comments, blanks and two-letter lines dropped');
  assert.ok(ts[0].re.test('near SPRINGFIELD today'), 'case-blind');
  assert.ok(!ts[0].re.test('Springfields'), 'a whole word, not a prefix');
  assert.ok(ts[1].re.test('lat: 47.61, -122.33 there'), 'a coordinate pair is matched literally');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('committed text carries no overlay-network address and no unreviewed host address', () => {
  const files = trackedFiles();
  if (files === null) return;

  // Rule 1, absolute: nothing in 100.64.0.0/10. That is the CGNAT/tailnet range, so
  // an address there is a specific device on someone's overlay network. One turned
  // up in three docs files as an `ip route get` example and nobody noticed, because
  // it looks like a made-up IP.
  const OVERLAY = /\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}\b/;

  // Rule 2: RFC1918 identifies a network. Loopback, the wildcard, docker's default
  // bridge in a hermetic fixture, and one README example CIDR are allowed; anything
  // else must be justified by name here rather than added silently.
  const RFC1918 = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
  const RFC1918_OK = new Set(['172.17.0.1']);

  // Rule 3: routable addresses are only permitted where they are quoted measurements
  // of a public Bitcoin peer -- never as a config value or a host fact. Adding a
  // file here is the review step.
  const PEER_QUOTE_OK = [
    /^test\/fixtures\//, /^test\/logparse\.test\.js$/, /^test\/app-boot\.test\.js$/,
    /^test\/bench-log\.test\.js$/, /^server\/collect\/logparse\.js$/,
    /^scripts\/fake-node\.js$/, /^docs\/MEASUREMENTS\.md$/,
    // Other parser fixtures quoting real peer lines (public bitcoin nodes, not hosts).
    /^test\/rpc-only\.test\.js$/, /^test\/shape-liveness\.test\.js$/, /^test\/node-series\.test\.js$/,
    // The 100% bmc-log rules' own test (2026-09-19) quotes three public peers from real lines --
    // one announcing a fork, one serving a compact block, one closing a leg -- reviewed that day.
    // The node's own address in it is TEST-NET-3 (203.0.113.7) and this box's LAN is 192.0.2.x.
    /^test\/logparse-100\.test\.js$/,
    // The shareware game packages under games/ (DOOM first), byte for byte as id Software shipped it (2026-09-15): HELPME.TXT
    // and the FAQ list the FTP mirrors of 1993 by address. Public archive hosts, not this network,
    // and the files cannot be edited without breaking "unmodified".
    /^games\//,
  ];
  // No `$` in these lookaheads: without /m it means end-of-string, which made
    // "0.0.0.0" fail to be excluded everywhere it appeared mid-line.
    const routable = /\b(?!127\.|0\.0\.0\.0|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|10\.|172\.|192\.168\.|1\.2\.3\.4|8\.8\.8\.8)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;;

  const hits = [];
  for (const f of files) {
    // This file necessarily contains the ranges it forbids, in order to express
    // them. Scanning it would be a self-referential false positive -- the identity
    // rule above still applies to it, because the machine's real values are never
    // written down here.
    if (f === 'test/privacy.test.js') continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    // SVG PATH DATA IS GEOMETRY, NOT TEXT. Compact path data elides separators, so
    // `d="...5.47 7.59.4.07.55-.17..."` contains the run "7.59.4.07", which these rules read as
    // a routable address. That happened twice in one afternoon -- the settings cog and the GitHub
    // mark -- and hand-formatting every path forever is a tax, not a fix. A `d` attribute cannot
    // carry a meaningful address, so it is excluded from the ADDRESS rules only.
    //
    // Note what is NOT excluded: the identity rules above (username, resolvable hostnames) still
    // scan the whole file, path data included. Only the numeric-address patterns skip `d`.
    const scan = text.replace(/\sd="[^"]*"/g, ' d=""');
    if (OVERLAY.test(scan)) hits.push(`${f}: overlay-network (100.64/10) address`);
    for (const m of scan.matchAll(RFC1918)) {
      if (RFC1918_OK.has(m[0])) continue;
      if (f === 'README.md' && m[0].endsWith('.0.0')) continue; // the 192.168.0.0/16 example CIDR
      hits.push(`${f}: RFC1918 address ${m[0]} -- use an RFC 5737 documentation address (192.0.2.x / 198.51.100.x / 203.0.113.x)`);
    }
    if (!PEER_QUOTE_OK.some((re) => re.test(f)) && routable.test(scan)) {
      hits.push(`${f}: a routable address outside the reviewed peer-quote list`);
    }
  }
  assert.deepEqual(hits, [], `addresses that should not be published:\n  ${hits.join('\n  ')}`);
});

test('the unit file names no real account and no real address', () => {
  const file = path.join(ROOT, 'systemd', 'blockyard.service');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const identity = machineIdentity();
  for (const id of identity) assert.ok(!id.re.test(text), `the unit would publish ${id.kind} "${id.shown}"`);
  assert.match(text, /User=blockyard/, 'a neutral placeholder service account');
  assert.match(text, /EDIT ME/, 'and it must be obvious that it is a placeholder');
  // Regression: two Environment= assignments once ended up on one line, which
  // silently discarded BLOCKYARD_PORT.
  assert.doesNotMatch(text, /Environment=\S+=\S*Environment=/, 'one assignment per line');
});

test('the privacy guard ignores accounts that name a machine rather than a person', () => {
  // Found by the first CI run this repository ever had: it runs as `runner`, and three tracked
  // files say "the test runner's own TAP output". The guard reported all three as leaked
  // identity and failed the build -- loudly, and for nothing. Word boundaries did not help,
  // because `runner` really is a whole word in that sentence.
  for (const u of ['runner', 'root', 'ubuntu', 'RUNNER', 'Build', 'codespace']) {
    assert.equal(isGenericAccount(u), true, `"${u}" names a machine, not a person`);
  }
  for (const u of ['bobclawblaw', 'j.smith', 'alice']) {
    assert.equal(isGenericAccount(u), false, `"${u}" could identify a person`);
  }
  // and nothing else was weakened to achieve it: addresses and resolvable hostnames still count
  const src = fs.readFileSync(new URL('./privacy.test.js', import.meta.url), 'utf8');
  assert.ok(src.includes('kind: `interface ${name}`'), 'interface addresses are still checked');
  assert.ok(src.includes("`${host}.local`"), 'resolvable hostnames are still checked');
});
