#!/usr/bin/env node
// THE COMMAND, for an install from npm (`npm install -g blockyard`):
//
//   blockyard setup          ask where the node is, check it, write the config, build the index
//   blockyard start          run the monitor
//   blockyard check          the same checks as setup, any time
//   blockyard index-build    build the address index by hand (--out <dir> [--workers N])
//   blockyard users          manage accounts (list / create / passwd / role)
//
// A global install lives wherever npm puts packages, which is nowhere to keep a config or 124 GB
// of index; so unless the environment says otherwise, this command keeps everything under
// ~/.blockyard: local.json (the config), data/ (state, and the index at data/index). A checkout
// run with `npm run …` keeps config/ and data/ inside the checkout, as before, because it does
// not come through here.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const home = process.env.BLOCKYARD_HOME ?? path.join(os.homedir(), '.blockyard');
process.env.BLOCKYARD_CONFIG ??= path.join(home, 'local.json');
process.env.BLOCKYARD_DATA ??= path.join(home, 'data');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = {
  setup: 'scripts/setup.js',
  check: 'scripts/check.js',
  start: 'server/main.js',
  'index-build': 'scripts/index-build.js',
  users: 'scripts/manage-users.js',
};
const cmd = process.argv[2];
if (!COMMANDS[cmd]) {
  const version = JSON.parse((await import('node:fs')).readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  process.stdout.write(`BlockYard ${version}\n\n  blockyard setup          ask where the node is, check it, write the config, build the index\n  blockyard start          run the monitor\n  blockyard check          the same checks as setup, any time\n  blockyard index-build    build the address index by hand (--out <dir> [--workers N])\n  blockyard users          manage accounts\n\nconfig ${process.env.BLOCKYARD_CONFIG}\ndata   ${process.env.BLOCKYARD_DATA}\n`);
  process.exit(cmd ? 2 : 0);
}
// the scripts decide "am I being run directly?" by comparing argv[1] to their own path, so hand
// them the path they expect rather than this file's
process.argv.splice(1, 2, path.join(root, COMMANDS[cmd]));
await import(path.join(root, COMMANDS[cmd]));
