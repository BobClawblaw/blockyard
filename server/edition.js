// WHICH BUILD IS THIS (docs/PLAN-ADMIN-SUITE.md §2a).
//
// Operator, 2026-09-18: "we really need to think about security for this. Im thinking we
// have two different builds entirely that get loaded. You can either run the read only
// build like it is now, or you can run a full administrative build. It should default to
// the read only build by default."
//
// So there are two artifacts, not one artifact with a switch:
//
//   blockyard            READ-ONLY. server/admin/ and public/js/admin/ are NOT IN IT.
//                        The default, and what `npm pack` produces (package.json `files`
//                        excludes those paths, so shipping the suite by accident takes
//                        a deliberate edit rather than a forgotten flag).
//   blockyard-admin      the administrative edition: the same monitor, plus the suite.
//
// WHY AN ARTIFACT AND NOT A FLAG. A runtime gate is code deciding not to run other code
// that is sitting right there; it is one bug, one typo'd condition, one confused-deputy
// request away from running it. Code that was never copied onto the disk has no such
// distance to travel. The gate in admin-gate.js stays as well, because a git checkout has
// every file present -- but on an installed read-only monitor the suite is not gated, it
// is ABSENT, and this file is how the process knows which of those two worlds it is in.
//
// The marker is in package.json rather than a file of its own so that it travels with the
// artifact through npm, a tarball, a container image and a git archive without anything
// having to remember to copy it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EDITIONS = Object.freeze({
  READONLY: 'readonly',
  ADMIN: 'admin',
  // A working copy: every file is present because it is the repository. The suite may
  // load here if its gates open, which is what lets it be developed and tested at all.
  SOURCE: 'source',
});

let cached = null;

/**
 * The declared edition, from package.json's `blockyardEdition`.
 *
 * Absent means SOURCE: an unbuilt checkout. `scripts/build-edition.js` writes it into
 * every artifact it makes, so anything installed has an explicit answer.
 */
export function declaredEdition(root = ROOT) {
  const declared = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).blockyardEdition ?? null; } catch { return null; }
  })();
  if (declared === EDITIONS.READONLY || declared === EDITIONS.ADMIN) return declared;
  return EDITIONS.SOURCE;
}

/** Is the suite's code actually on this disk? The question the declaration cannot fake. */
export function adminFilesPresent(root = ROOT) {
  return fs.existsSync(path.join(root, 'server', 'admin', 'index.js'));
}

/**
 * What this process can do about the administrative suite, decided once.
 *
 * `canLoad` is the conjunction that matters: the build says it carries the suite AND the
 * suite is there. A declaration without files is a broken install and says so; files
 * without a declaration is a source tree, which is allowed and named as such.
 */
export function edition(root = ROOT) {
  if (cached && cached.root === root) return cached;
  const declared = declaredEdition(root);
  const present = adminFilesPresent(root);
  const canLoad = declared !== EDITIONS.READONLY && present;
  let note = null;
  if (declared === EDITIONS.READONLY) {
    note = 'this is the read-only build of BlockYard; the administrative suite is not part of it. '
      + 'Install the blockyard-admin edition to use wallet, config and daemon control.';
  } else if (declared === EDITIONS.ADMIN && !present) {
    note = 'this build declares the administrative edition but server/admin/ is missing from it -- '
      + 'the install is incomplete; reinstall rather than working around it.';
  }
  cached = { root, declared, present, canLoad, note };
  return cached;
}

/** Tests build artifacts in temp directories; they need the cache not to follow them. */
export function __resetEditionCache() { cached = null; }
