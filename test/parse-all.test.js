// Every shipped .js file must parse — including the ones nothing imports.
//
// Why this exists: `scripts/manage-users.js`, the documented way to recover a lost
// admin password (AGENTS.md says so in its first code block), had not parsed since
// some editor put a real carriage return *inside a string literal*. That is legal in
// CommonJS and a syntax error in ESM, and this project is `"type": "module"` — so
// `node scripts/manage-users.js passwd admin` threw a SyntaxError before main() ran.
//
// Why nothing caught it: it is a CLI, so no test imports it; `npm test` never
// executed it; and `node --check` on the same bytes succeeds outside the project
// (parsed as CJS), which is exactly the kind of check that passes for the wrong
// reason. The fix is to run the check in the same module context the file actually
// runs in, over the whole shipped set, and to assert the count of files checked — a
// guard that silently inspects nothing is worse than none (rule 21).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['server', 'public/js', 'scripts'];

function shipped() {
  const out = [];
  for (const d of DIRS) {
    const base = path.join(ROOT, d);
    // `recursive: true` gives entries whose NAME is just the basename, so the path
    // must come from parentPath -- joining the base with ent.name silently flattens
    // server/rpc/allowlist.js to server/allowlist.js, and the check then fails on a
    // path that does not exist (a guard that errors on its own bug looks like a real
    // finding, which is the worst kind of noise).
    for (const ent of fs.readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.js')) continue;
      const parent = path.relative(ROOT, ent.parentPath ?? base);
      out.push(path.posix.join(parent.replace(/\\/g, '/'), ent.name));
    }
  }
  return out.sort();
}

test('every shipped JS file parses as the module it will be loaded as', () => {
  const files = shipped();
  assert.ok(files.length >= 20, `expected the shipped set to hold 20+ files, found ${files.length} — a glob that matches nothing turns this test into a no-op`);
  const broken = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    } catch (err) {
      const msg = String(err.stderr ?? err.message).split('\n').slice(0, 4).join(' | ');
      broken.push(`${f}: ${msg}`);
    }
  }
  assert.deepEqual(broken, [], `files that do not parse:\n  ${broken.join('\n  ')}`);
});

test('no shipped source carries a raw control character inside a string', () => {
  // The bug class, not just the instance: raw CR/LF/DEL bytes in source are invisible
  // in editors and patch tools, and a raw CR is what silently killed the CLI above.
  // Escapes (\r, \u007f) say the same thing and survive every tool between here and
  // the next reader.
  const offenders = [];
  for (const f of shipped()) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      // Tab and the line terminator itself are fine; anything else below 0x20 or DEL
      // embedded in the file is not.
      const bad = [...line].filter((c) => (c.codePointAt(0) < 32 && c !== '\t') || c.codePointAt(0) === 0x7f);
      if (bad.length) offenders.push(`${f}:${i + 1} has ${bad.map((c) => `U+${c.codePointAt(0).toString(16).padStart(4, '0')}`).join(', ')}`);
    });
  }
  assert.deepEqual(offenders, [], `raw control characters in source:\n  ${offenders.join('\n  ')}`);
});

test('the user CLI actually runs, and says so when accounts are off', () => {
  // Parsing is necessary, not sufficient: this file is the documented password
  // recovery path, so run it the way an operator in trouble would.
  const dir = fs.mkdtempSync(path.join('/tmp', 'blockyard-cli-'));
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'manage-users.js'), 'list'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, BLOCKYARD_CONFIG: 'none', BLOCKYARD_DATA: dir }, stdio: 'pipe',
    });
    assert.match(out, /no users/, 'an empty store reports no users rather than crashing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
