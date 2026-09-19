#!/usr/bin/env node
// BUILD ONE OF THE TWO EDITIONS (docs/PLAN-ADMIN-SUITE.md §2a, server/edition.js).
//
//   node scripts/build-edition.js --edition readonly --out /tmp/blockyard-readonly
//   node scripts/build-edition.js --edition admin    --out /tmp/blockyard-admin
//
// The read-only edition is the default and is what the project ships: the administrative
// suite's code is NOT COPIED INTO IT. Not disabled in it -- absent from it. The whole
// point of the split is that a monitor which will never run a wallet should not have the
// wallet code on its disk, where a future bug, a path traversal or a confused deputy could
// still reach it.
//
// This script is the only place that decides what goes in each, and the test beside it
// (test/edition.test.js) builds both into a temp directory and reads back what landed,
// rather than trusting this comment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITIONS } from '../server/edition.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What a monitor needs to run, in both editions.
const INCLUDE = ['bin', 'server', 'public', 'scripts', 'systemd', 'config/pool-map.json',
  'CHANGELOG.md', 'SECURITY.md', 'NOTICE', 'LICENSE', 'README.md'];

// Never in any artifact: one deployment's state, secrets, private notes, or somebody
// else's games.
const ALWAYS_EXCLUDE = ['data', 'worklog', 'games', 'node_modules', '.git', 'test',
  'config/local.json', 'config/blockyard.json', '.claude'];

// THE SPLIT. Everything the administrative suite is, listed once.
export const ADMIN_PATHS = [
  'server/admin',
  'server/admin-gate.js',
  // Added 2026-09-18 after test/release-guard.test.js found it: the suite's RPC capability
  // list lives under server/rpc/ rather than server/admin/, so the directory exclusion
  // missed it and it was shipping in both the npm tarball and the container image. It is
  // imported only from server/admin/, so excluding it costs a read-only build nothing.
  'server/rpc/admin-allowlist.js',
  'public/js/admin',
  // the suite's stylesheet, which lives under public/css/ beside the monitor's own
  'public/css/admin.css',
];

// admin-gate.js is deliberately NOT in that list -- see below. It is core: a read-only
// build still has to be able to say "this build does not carry the suite" when someone
// sets BLOCKYARD_ADMIN=1, and that sentence lives in the gate.
ADMIN_PATHS.splice(ADMIN_PATHS.indexOf('server/admin-gate.js'), 1);

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/** Copy `from` to `to`, skipping anything under an excluded path. */
function copyTree(from, to, { exclude = [], rel = '' } = {}) {
  const copied = [];
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (exclude.some((e) => childRel === e || childRel.startsWith(`${e}/`))) continue;
      copied.push(...copyTree(path.join(from, name), path.join(to, name), { exclude, rel: childRel }));
    }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(rel);
  }
  return copied;
}

/**
 * Build an edition into `outDir`. Returns what landed, so a caller can assert on it.
 *
 * The package is renamed for the administrative edition, because two artifacts that
 * install to the same name would be one artifact with a surprise in it.
 */
export function buildEdition({ edition = EDITIONS.READONLY, outDir, root = ROOT, unreleased = false } = {}) {
  if (edition !== EDITIONS.READONLY && edition !== EDITIONS.ADMIN) {
    throw new Error(`edition must be "${EDITIONS.READONLY}" or "${EDITIONS.ADMIN}", not ${edition}`);
  }
  // THE ADMINISTRATIVE EDITION IS NOT RELEASABLE, and saying so at the point of building it
  // is worth more than saying so in a document (operator, 2026-09-18: "Nobody should ever
  // use the wallet build for now... It will need a lot of work before it's ready to ship
  // publicly"). Building one for a development machine is deliberate and takes a flag; the
  // artifact it produces is marked `private` so `npm publish` refuses it outright, rather
  // than relying on whoever runs the release to remember.
  if (edition === EDITIONS.ADMIN && !unreleased) {
    throw new Error('the administrative edition is not fit to ship: it can spend money and has not had its '
      + 'security review (docs/PLAN-ADMIN-SUITE.md M8). Pass --unreleased to build one for a development '
      + 'machine, which marks the package private so it cannot be published.');
  }
  if (!outDir) throw new Error('an --out directory is required');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const exclude = [...ALWAYS_EXCLUDE, ...(edition === EDITIONS.READONLY ? ADMIN_PATHS : [])];
  const files = [];
  for (const entry of INCLUDE) {
    const from = path.join(root, entry);
    if (!fs.existsSync(from)) continue;
    // The exclusion list is relative to the repository root, and so is the walk.
    files.push(...copyTree(from, path.join(outDir, entry), { exclude, rel: entry }));
  }

  // docs/*.md, minus the two prefixes that are never published.
  const docs = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md') && !f.startsWith('STATE-') && !f.startsWith('PRIVATE-'));
  for (const d of docs) {
    fs.mkdirSync(path.join(outDir, 'docs'), { recursive: true });
    fs.copyFileSync(path.join(root, 'docs', d), path.join(outDir, 'docs', d));
    files.push(`docs/${d}`);
  }

  // The marker the running process reads (server/edition.js). Written here, into the
  // artifact, so it travels with it through npm, a tarball or an image without anything
  // having to remember to set an environment variable.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.blockyardEdition = edition;
  if (edition === EDITIONS.ADMIN) {
    pkg.name = 'blockyard-admin';
    pkg.description = `${pkg.description} — administrative edition: UNRELEASED, development only`;
    // npm refuses to publish a package marked private. That is the backstop: the exclusion
    // lists, the flag above and this each fail independently, and a release has to defeat
    // all three to put a wallet on a registry.
    pkg.private = true;
    pkg.blockyardUnreleased = true;
  }
  fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  files.push('package.json');

  return { edition, outDir, files, adminFiles: files.filter((f) => ADMIN_PATHS.some((a) => f === a || f.startsWith(`${a}/`))) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  const edition = arg('edition', EDITIONS.READONLY);
  const outDir = arg('out', path.join(ROOT, 'build', `blockyard-${edition}`));
  const out = buildEdition({ edition, outDir, unreleased: args.includes('--unreleased') });
  process.stdout.write(`${out.edition} edition: ${out.files.length} files -> ${out.outDir}\n`);
  process.stdout.write(out.edition === EDITIONS.READONLY
    ? `  the administrative suite is NOT in it (${ADMIN_PATHS.join(', ')} were not copied)\n`
    : `  including ${out.adminFiles.length} file(s) of the administrative suite\n`
      + '  UNRELEASED: marked private, not publishable, not for a machine holding real funds\n');
}
