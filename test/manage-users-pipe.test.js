// A PASSWORD PIPED IN ONE CHUNK (2026-09-30). scripts/manage-users.js compared each stdin chunk with '\n' as if a chunk
// were one keystroke: a password piped in -- `echo "$PW" | manage-users.js create alice` -- arrived as one chunk, the
// newline went into the password, and the script exited having done nothing. Found as audit-2026-09-22's M2 test
// failing only under load (its typed characters coalesced); reproduced 6 of 12 with every core busy, 0 of 12 fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args, env, stdin) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/manage-users.js'), ...args], { env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { child.kill(9); reject(new Error(`timed out: ${out}`)); }, 20_000);
  child.stdin.end(stdin);                                   // ONE write: the whole password and its newline at once
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
});

test('a password piped in one chunk is read to its newline, and to the end of the input without one', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-mu-pipe-'));
  const env = { ...process.env, BLOCKYARD_CONFIG: 'none', BLOCKYARD_DATA: scratch };
  try {
    const a = await run(['create', 'carol', 'viewer'], env, 'piped-password-789\n');
    assert.match(a.out, /created carol as viewer/, a.out);
    const b = await run(['passwd', 'carol'], env, 'no-newline-password-1');
    assert.match(b.out, /password set for carol/, b.out);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
