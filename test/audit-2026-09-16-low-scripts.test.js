// THE 2026-09-16 AUDIT'S LOW FINDINGS IN THE SCRIPTS, CI AND GAME FILES (docs/SECURITY-AUDIT-2026-09-16.md):
// L12 (setup.js echoed the RPC password, took it only on the command line, and left a --force'd
// config at its old mode), L15 (pool-map.js followed redirects to any protocol, wrote without
// showing what changed, pinned nothing, and measured coverage on port 8088), L17's CI half
// (actions pinned by tag), I5 (setup.js backups not ignored, not owner-only) and I6 (no hash
// manifest for games/). Nothing here touches the network or the checkout's own config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeLocalConfig, rpcPasswordFrom, readHidden } from '../scripts/setup.js';
import { redirectTarget, curlArgs, diffPoolMaps, formatDiff, checkExpectedSha, coverageUrl } from '../scripts/pool-map.js';
import { loadConfig } from '../server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const POSIX = process.platform !== 'win32';

// ------------------------------------------------------------------------------------------ L12, I5
test('L12/I5: --force re-applies 0600 to an existing config, and the backup is 0600 too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-audit-low-'));
  try {
    const file = path.join(root, 'config', 'local.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '{"nodes":[]}\n', { mode: 0o644 });
    if (POSIX) fs.chmodSync(file, 0o644);
    writeLocalConfig(file, { nodes: [{ rpcUser: 'u', rpcPassword: 'p' }] }, { force: true, now: new Date('2026-09-16T12:00:00Z') });
    const bak = fs.readdirSync(path.dirname(file)).find((f) => f.startsWith('local.json.bak-'));
    assert.ok(bak, 'a backup is kept');
    assert.equal(fs.readFileSync(path.join(path.dirname(file), bak), 'utf8'), '{"nodes":[]}\n', 'holding exactly what was there');
    if (POSIX) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the replaced file is owner-only, whatever mode it had');
      assert.equal(fs.statSync(path.join(path.dirname(file), bak)).mode & 0o777, 0o600, 'and so is the backup');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('L12: the RPC password comes from a file or stdin without a warning, and from argv with one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-audit-low-'));
  try {
    const pwFile = path.join(root, 'rpc.pw');
    fs.writeFileSync(pwFile, 'from-the-file\nsecond line ignored\n', { mode: 0o600 });
    const f = rpcPasswordFrom(['--yes', '--rpc-password-file', pwFile]);
    assert.deepEqual(f, { password: 'from-the-file', source: 'file', warning: null });
    const s = rpcPasswordFrom(['--rpc-password', '-', '--yes'], { readStdin: () => 'from-stdin\r\n' });
    assert.deepEqual(s, { password: 'from-stdin', source: 'stdin', warning: null }, '"-" reads the first line of stdin');
    const a = rpcPasswordFrom(['--rpc-password', 'on-the-line']);
    assert.equal(a.password, 'on-the-line', 'the old flag still works');
    assert.match(a.warning, /visible to other users/);
    assert.match(a.warning, /shell history/);
    assert.deepEqual(rpcPasswordFrom(['--yes']), { password: null, source: null, warning: null });
    assert.throws(() => rpcPasswordFrom(['--rpc-password', 'x', '--rpc-password-file', pwFile]), /twice/);
    assert.throws(() => rpcPasswordFrom(['--rpc-password-file', path.join(root, 'missing')]), /ENOENT/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('L12: the secret prompt does not echo what is typed; backspace edits it', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let shown = '';
  output.on('data', (d) => { shown += d; });
  const answer = readHidden('rpcPassword › ', { input, output });
  input.write('hunX');
  input.write('\u007fter2\r');
  assert.equal(await answer, 'hunter2');
  assert.equal(shown, 'rpcPassword › \n', 'only the prompt and the newline reach the screen');
  const src = read('scripts/setup.js');
  assert.match(src, /if \(secret\) \{[\s\S]{0,400}readHidden\(/, 'ask() routes a secret question through readHidden');
  assert.doesNotMatch(src, /arg\('rpc-password'\)/, 'the password is not taken from argv bypassing rpcPasswordFrom');
});

test('L12: the documentation names the safe ways first', () => {
  const doc = read('docs/GETTING-STARTED.md');
  assert.match(doc, /--rpc-password-file/);
  assert.match(doc, /--rpc-password -/);
  assert.match(read('scripts/setup.js').split('\nimport ')[0], /--rpc-password-file PATH/, 'and so does the usage header');
});

test('I5: setup.js backups of local.json are ignored by git', () => {
  const lines = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  assert.ok(lines.includes('config/*.bak-*'));
});

// ------------------------------------------------------------------------------------------------ L15
test('L15: redirects go to HTTPS only, on both fetch paths', () => {
  assert.equal(redirectTarget('/mempool/mining-pools/pools-v2.json', 'https://192.0.2.10/a'), 'https://192.0.2.10/mempool/mining-pools/pools-v2.json', 'a relative redirect keeps https');
  assert.equal(redirectTarget('https://198.51.100.7/x', 'https://192.0.2.10/a'), 'https://198.51.100.7/x');
  assert.throws(() => redirectTarget('http://203.0.113.5/pools.json', 'https://192.0.2.10/a'), /HTTPS only/);
  assert.throws(() => redirectTarget('ftp://203.0.113.5/pools.json', 'https://192.0.2.10/a'), /HTTPS only/);
  const args = curlArgs('https://192.0.2.10/pools.json');
  assert.equal(args[args.indexOf('--proto') + 1], '=https');
  assert.equal(args[args.indexOf('--proto-redir') + 1], '=https');
  assert.equal(args.at(-1), 'https://192.0.2.10/pools.json');
});

test('L15: a refresh is summarised pool by pool before it is written', () => {
  const before = { pools: [
    { key: 'alpha', name: 'Alpha', link: null, tags: ['/alpha/'] },
    { key: 'beta', name: 'Beta', link: 'https://192.0.2.1', tags: ['/beta/'] },
    { key: 'gamma', name: 'Gamma', link: null, tags: ['/g/', '/gamma/'] },
  ] };
  const after = { pools: [
    { key: 'alpha', name: 'Alpha', link: null, tags: ['/alpha/'] },
    { key: 'beta', name: 'Beta', link: 'https://192.0.2.1', tags: ['/beta/', '/beta2/'] },
    { key: 'gamma', name: 'Gamma', link: null, tags: ['/gamma/', '/g/'] },
    { key: 'delta', name: 'Delta', link: null, tags: ['/delta/'] },
  ] };
  const d = diffPoolMaps(before, after);
  assert.deepEqual(d, { added: ['delta'], removed: [], changed: ['beta'], unchanged: 2 }, 'tag order alone is not a change');
  assert.deepEqual(diffPoolMaps(after, before), { added: [], removed: ['delta'], changed: ['beta'], unchanged: 2 });
  const text = formatDiff(d, (k) => k.toUpperCase());
  assert.match(text, /1 added, 0 removed, 1 changed, 2 unchanged/);
  assert.match(text, /\+ DELTA/);
  assert.match(text, /~ BETA/);
  const src = read('scripts/pool-map.js');
  assert.match(src, /replacing && !args\.includes\('--yes'\)/, 'an existing map is replaced only on --yes or a confirmation');
});

test('L15: --expect-sha256 pins the download', () => {
  const body = '[{"name":"Alpha","tags":["/alpha/"]}]';
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(checkExpectedSha(body, null), null, 'optional');
  assert.equal(checkExpectedSha(body, sha.toUpperCase()), sha);
  assert.throws(() => checkExpectedSha(body, '0'.repeat(64)), /mismatch/);
  assert.throws(() => checkExpectedSha(body, 'abc'), /64 hex/);
});

test('L15: the coverage check asks the port and scheme the config names, not 8088', () => {
  assert.equal(coverageUrl({ server: { hosts: ['127.0.0.1'], port: 21000 }, tls: true }), 'https://127.0.0.1:21000/api/mining?node=main');
  assert.equal(coverageUrl({ server: { hosts: ['0.0.0.0'], port: 23456 }, tls: false }), 'http://127.0.0.1:23456/api/mining?node=main');
  assert.equal(coverageUrl({ server: { host: '192.0.2.44', port: 21001 } }), 'https://192.0.2.44:21001/api/mining?node=main', 'https unless TLS is off');
  assert.equal(coverageUrl({}), 'https://127.0.0.1:21000/api/mining?node=main', 'the defaults');
  const saved = process.env.BLOCKYARD_PORT;
  process.env.BLOCKYARD_PORT = '24680';
  try {
    assert.match(coverageUrl(loadConfig({ configFile: null })), /^https:\/\/127\.0\.0\.1:24680\//, 'BLOCKYARD_PORT reaches it through loadConfig');
  } finally { if (saved === undefined) delete process.env.BLOCKYARD_PORT; else process.env.BLOCKYARD_PORT = saved; }
  assert.doesNotMatch(read('scripts/pool-map.js'), /:8088\/api/, 'no hardcoded port left in the request');
});

// --------------------------------------------------------------------------------------- L17 (CI)
test('L17: every workflow action is pinned to a full commit SHA naming its tag, and dependabot watches them', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  let uses = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*-?\s*uses:\s*(\S+)(.*)$/);
      if (!m || m[1].startsWith('./')) continue;
      uses++;
      assert.match(m[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${f}: ${m[1]} is pinned by commit`);
      assert.match(m[2], /#\s*v\d/, `${f}: ${m[1]} says which version it is`);
    }
  }
  assert.ok(uses >= 2, 'checkout and setup-node at least');
  const dep = read('.github/dependabot.yml');
  assert.match(dep, /package-ecosystem:\s*github-actions/);
  assert.match(dep, /interval:\s*weekly/);
});

// ------------------------------------------------------------------------------------------------ I6
test('I6: games/SHA256SUMS matches every tracked game file that is present', () => {
  const manifest = new Map(read('games/SHA256SUMS').split(/\r?\n/).filter(Boolean).map((l) => {
    const m = l.match(/^([0-9a-f]{64}) [ *](.+)$/);
    assert.ok(m, `a sha256sum line: ${l}`);
    return [m[2], m[1]];
  }));
  // the tracked files, where git is there to ask; otherwise the manifest's own list
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z', 'games'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean).map((p) => p.replace(/^games\//, ''));
  } catch { tracked = [...manifest.keys()]; }
  tracked = tracked.filter((p) => p !== 'SHA256SUMS');
  if (!tracked.length) tracked = [...manifest.keys()];
  let checked = 0;
  for (const rel of tracked) {
    assert.ok(manifest.has(rel), `games/${rel} is tracked but not in games/SHA256SUMS`);
    const file = path.join(ROOT, 'games', rel);
    if (!fs.existsSync(file)) continue;   // a checkout without the game files
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(sha, manifest.get(rel), `games/${rel} differs from its recorded SHA-256`);
    checked++;
  }
  for (const rel of manifest.keys()) assert.ok(tracked.includes(rel), `games/SHA256SUMS lists ${rel}, which is not tracked`);
  assert.ok(checked > 0 || !fs.existsSync(path.join(ROOT, 'games', 'doom_dos')), 'at least one file was hashed');
  assert.match(read('docs/ARCHITECTURE.md'), /Wolfenstein 3D v1\.4 shareware[\s\S]{0,200}file_id\.diz/, 'the provenance note names the release and the missing licence text');
});
