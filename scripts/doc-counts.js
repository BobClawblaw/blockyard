#!/usr/bin/env node
// One source of truth for the test count the docs quote.
//
// Why this exists as a script rather than as a grep in a test: the documented
// count drifted out of sync three times on 2026-09-08, and each time the fix was
// a sed against a string a previous sed had already rewritten, so the replacement
// matched nothing and the docs went on asserting a stale number. The previous
// guard compared README against AGENTS.md, which only proves two documents are
// wrong *together* — it never looked at the suite. 183 vs 180 is exactly that
// failure, found by hand on 2026-09-09.
//
// So: count what the suite declares, and make the docs match it.
//
// How the count is derived, and why it is the same number `node --test` prints:
// every test in this repo is declared at module top level with `test('name', …)`.
// A nested declaration (`t.test(…)`, or an indented `test(`) would make the two
// numbers disagree, so the scanner reports nested declarations separately and
// test/doc-counts.test.js fails loudly if any appear — a scanner that silently
// undercounts is the same class of bug as the sed that matched nothing.
//
//   node scripts/doc-counts.js          # print the number
//   node scripts/doc-counts.js --check  # exit 1 if the docs disagree
//   node scripts/doc-counts.js --fix    # rewrite the docs' number
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DECL = /^(?:test|test\.skip|test\.todo|test\.only)\s*\(/;

/** Test declarations per file: top-level (counted) and nested (a scanner gap). */
export function scanTests({ root = ROOT, dir = 'test' } = {}) {
  const base = path.join(root, dir);
  const files = fs.readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
  const out = { total: 0, nested: [], perFile: {}, files: files.length };
  for (const f of files) {
    let top = 0;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const trimmed = line.trimStart();
      if (!DECL.test(trimmed)) continue;
      // Indented means it sits inside another test's body or a helper: a subtest.
      if (/^\s/.test(line)) out.nested.push(`${path.relative(root, f)}: ${trimmed.slice(0, 60)}`);
      else top += 1;
    }
    out.perFile[path.relative(root, f)] = top;
    out.total += top;
  }
  return out;
}

// Every place the docs quote a test count. Deliberately narrow ("N tests" /
// "N unit tests") so a measurement like "1 test failed" in prose is not edited.
export const DOC_FILES = ['README.md', 'AGENTS.md'];

export function docCounts({ root = ROOT } = {}) {
  const found = [];
  for (const rel of DOC_FILES) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(/(\d+)\s+(unit tests|tests)\b/g)) {
      found.push({ file: rel, count: Number(m[1]), match: m[0], index: m.index });
    }
  }
  return found;
}

export function rewriteDocs(count, { root = ROOT, dry = false } = {}) {
  const changes = [];
  for (const rel of DOC_FILES) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    const next = text.replace(/(\d+)(\s+(?:unit tests|tests)\b)/g, `${count}$2`);
    if (next !== text) {
      changes.push(rel);
      if (!dry) fs.writeFileSync(file, next);
    }
  }
  return changes;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  const scan = scanTests();
  const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--fix') ? 'fix' : 'print';
  if (mode === 'print') {
    process.stdout.write(`${scan.total}\n`);
    if (scan.nested.length) process.stderr.write(`warning: ${scan.nested.length} nested test declaration(s) the count cannot see:\n  ${scan.nested.join('\n  ')}\n`);
  } else {
    const docs = docCounts();
    const wrong = docs.filter((d) => d.count !== scan.total);
    if (mode === 'fix') {
      const touched = rewriteDocs(scan.total);
      process.stdout.write(`${scan.total} declared tests; ${touched.length ? `rewrote ${touched.join(', ')}` : 'docs already correct'}\n`);
    } else if (wrong.length) {
      process.stderr.write(
        `documented test count is wrong. The suite declares ${scan.total} tests; the docs say `
        + `${wrong.map((w) => `${w.file}: "${w.match}"`).join(', ')}.\n`
        + 'Fix it with: node scripts/doc-counts.js --fix\n',
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`docs agree with the suite at ${scan.total}\n`);
    }
  }
}
