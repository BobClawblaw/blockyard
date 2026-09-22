#!/usr/bin/env node
// CLI user administration, for the cases where the web UI is unreachable
// (lost password, locked out, first boot went wrong) or a script needs an
// account. Never prints or accepts a password on a command line where it would
// land in shell history: use stdin or the interactive prompt.
//
//   node scripts/manage-users.js list
//   node scripts/manage-users.js create <username> [role]
//   node scripts/manage-users.js passwd <username>
//   node scripts/manage-users.js role <username> <role>
//   node scripts/manage-users.js disable <username> | enable <username>
//   node scripts/manage-users.js rm <username>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, ROOT } from '../server/config.js';
import { UserStore, ROLES } from '../server/auth/users.js';
import { SessionStore } from '../server/auth/sessions.js';

const cfg = loadConfig();
// Accounts are OFF by default, so this CLI can edit a user file the running server
// will never consult. Say that up front instead of letting someone create an
// account, fail to log in, and conclude the tool is broken.
if (!cfg.auth.enabled) {
  process.stderr.write('note: accounts are DISABLED on this config (auth.enabled=false), so the\n'
    + 'server is open without sign-in and ignores users.json. Start with BLOCKYARD_AUTH=1\n'
    + 'to use accounts.\n');
}
const file = path.join(cfg.auth.dataDir, 'users.json');
const store = new UserStore(file, cfg.auth);
// REVOKED, NOT JUST CHANGED (audit 2026-09-22, M2). This is the lost-password/locked-out
// recovery tool -- which is also, unavoidably, what an operator reaches for during a
// SUSPECTED COMPROMISE. `passwd` used to leave every existing session for the account valid
// for up to 72h (the absolute session TTL) after the reset, with only a printed reminder to
// "sign them out from the UI if needed" -- not a real option when the reason you're on the
// CLI is that you don't trust the account to sign anyone out from. `/api/password` (the web
// route for changing your own password) already revokes; this now matches it, and does the
// same for `disable`, which had the identical gap (the web route for disabling a user does
// revoke, at server/http/api.js -- this CLI command did not).
const sessions = new SessionStore(path.join(cfg.auth.dataDir, 'sessions.json'), cfg.auth);
await sessions.load();
async function revokeSessions(username) {
  const user = store.find(username);
  if (!user) return 0;
  const n = sessions.destroyForUser(user.id);
  if (n) await sessions.save();
  return n;
}

const [cmd, ...args] = process.argv.slice(2);

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdout.isTTY });
    if (!hidden) { rl.question(question, (a) => { rl.close(); resolve(a.trim()); }); return; }
    process.stdout.write(question);
    // Turn off echo rather than logging the prompt into a tty that keeps it.
    const tty = process.stdin;
    if (tty.isTTY) tty.setRawMode(true);
    let buf = '';
    tty.resume();
    tty.setEncoding('utf8');
    const onData = (ch) => {
      // Enter arrives as LF or CR depending on the terminal; both are handled.
      // (This line used to carry a third comparison whose operand was a raw CR
      // inside the quotes -- a pasted keystroke. Legal in CJS, a syntax error as
      // ESM, and nothing ever imported this file to find out.)
      if (ch === '\n' || ch === '\r') {
        tty.removeListener('data', onData);
        if (tty.isTTY) tty.setRawMode(false);
        tty.pause();
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u007f') { // DEL: what backspace sends on a tty
        buf = buf.slice(0, -1);
      } else if (ch === '\u0003') { // Ctrl-C
        process.stdout.write('\n');
        process.exit(130);
      }
      else buf += ch;
    };
    tty.on('data', onData);
  });
}

async function main() {
  const loaded = await store.load();
  if (!loaded.loaded && cmd !== 'create' && cmd !== 'list') {
    process.stdout.write(`no user store at ${file} yet -- start the server once, or: create <username>\n`);
  }
  switch (cmd) {
    case 'list': {
      if (!store.count) { process.stdout.write('no users\n'); break; }
      const rows = store.list();
      process.stdout.write(rows.map((u) =>
        `${u.username.padEnd(24)} ${u.role.padEnd(9)} ${u.disabled ? 'disabled' : 'enabled '}  created ${new Date(u.createdAt).toISOString().slice(0, 10)}  last ${u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().slice(0, 16) : 'never'}`
      ).join('\n') + '\n');
      break;
    }
    case 'create': {
      const username = args[0] || await ask('username: ');
      const role = args[1] || await ask(`role (${ROLES.join('/')}): `) || 'viewer';
      const pw = await ask('password (stdin, not echoed): ', { hidden: true });
      try {
        const u = await store.createUser(username, pw, { role });
        process.stdout.write(`created ${u.username} as ${u.role}\n`);
      } catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; }
      break;
    }
    case 'passwd': {
      const username = args[0] || await ask('username: ');
      const pw = await ask('new password (stdin, not echoed): ', { hidden: true });
      try {
        await store.setPassword(username, pw);
        const n = await revokeSessions(username);
        process.stdout.write(`password set for ${username}; ${n} existing session(s) signed out\n`);
      }
      catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; }
      break;
    }
    case 'role': {
      const [username, role] = args;
      if (!username || !role) { process.stderr.write('usage: role <username> <viewer|operator|admin>\n'); process.exitCode = 2; break; }
      try { const r = await store.setRole(username, role); process.stdout.write(`${r.username} is now ${r.role}\n`); }
      catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; }
      break;
    }
    case 'disable':
    case 'enable': {
      const username = args[0] || await ask('username: ');
      try {
        const r = await store.setDisabled(username, cmd === 'disable');
        const n = cmd === 'disable' ? await revokeSessions(username) : 0;
        process.stdout.write(`${r.username} ${r.disabled ? 'disabled' : 'enabled'}${n ? `; ${n} existing session(s) signed out` : ''}\n`);
      }
      catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; }
      break;
    }
    case 'rm': {
      const username = args[0] || await ask('username to delete: ');
      const sure = await ask(`delete ${username}? type the username to confirm: `);
      if (sure !== username) { process.stdout.write('not deleted\n'); break; }
      try { const r = await store.deleteUser(username); process.stdout.write(`deleted ${r.deleted}\n`); }
      catch (err) { process.stderr.write(`${err.message}\n`); process.exitCode = 1; }
      break;
    }
    default:
      process.stdout.write(`usage: manage-users.js <list|create|passwd|role|disable|enable|rm> [args]

users file: ${file}  (0600, scrypt hashes only -- no recoverable passwords)
roles:      ${ROLES.join(' < ')}   viewer=read, operator=+enabled actions, admin=+users and audit
`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
