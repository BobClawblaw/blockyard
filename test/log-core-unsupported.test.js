// LOG PARSING DOES NOT SUPPORT BITCOIN CORE, and this file is the standing proof.
//
// (operator, 2026-09-13: "We never ran log tests against core. We should explicitly say log file
// parsing is presently unavailable, and was tested against an experimental implementation.")
//
// Every rule in logparse.js keys on tags an experimental node emits -- [dlc], [dl], [dial],
// [utxo_live], [config] -- and TS_RE wants `YYYY-MM-DD HH:MM:SS.mmm `, which is not the
// `2026-09-13T01:30:00Z` Core writes. Both fixtures in test/fixtures/ are experimental-format.
//
// The failure mode is NOT a clean refusal, which is why this is worth pinning: Core lines are
// accepted and come back as unstructured `raw` events, with a timestamp that fell back to the time
// of reading. A feature that silently produces empty rows at the wrong time is easier to mistake
// for "working" than one that throws -- so the assertions below state exactly what happens, and
// will fail the day somebody adds Core rules, which is the moment the docs must change too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLine } from '../server/collect/logparse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Real Bitcoin Core debug.log shapes (v25+ default format: ISO-8601 UTC, no milliseconds).
const CORE_LINES = [
  "2026-09-13T01:30:00Z UpdateTip: new best=00000000000000000001a2b3 height=966750 version=0x20078000 log2_work=95.1 tx=1183928371 progress=1.000000 cache=12.3MiB(89123txo)",
  '2026-09-13T01:30:01Z [net] received: inv (37 bytes) peer=12',
  '2026-09-13T01:30:02Z New outbound peer connected: version: 70016, blocks=966750, peer=14 (block-relay-only)',
  '2026-09-13T01:30:03Z [mempool] Removed 3 transactions from the memory pool',
  '2026-09-13T01:30:04Z Pre-allocating up to position 0x1000000 in blk00412.dat',
  '2026-09-13T01:30:05Z socket recv error Connection reset by peer (104)',
];

// `tsFallback` is here because it is not a figure read out of the line -- it is the
// parser saying it had to date the line itself, which is the misdating this whole file
// is about. It arrived on 2026-09-18 with the index-builder rules, whose child
// processes write untimestamped lines for the same reason Core lines end up here:
// TS_RE does not match what they wrote.
const BORING = new Set(['kind', 'ts', 'tsFallback', 'severity', 'text', 'tag', 'tagBase', 'raw', 'rule']);

test('Core debug.log lines yield no structured figures -- only raw rows', () => {
  for (const line of CORE_LINES) {
    const ev = parseLine(line);
    assert.ok(ev, `the parser should still produce an event for: ${line.slice(0, 60)}`);
    assert.equal(ev.kind, 'raw',
      `a Core line was classified as "${ev.kind}" -- if Core rules were added, update the docs that `
      + 'say Core is unsupported (AGENTS.md, CONFIGURATION.md, INSTALL.md, API.md, ARCHITECTURE.md)');
    const structured = Object.keys(ev).filter((k) => !BORING.has(k));
    assert.deepEqual(structured, [],
      `a Core line produced fields ${structured.join(', ')}; the docs claim none are extracted`);
  }
});

test('and their timestamps are NOT read from the line, which is why the feed would misdate them', () => {
  // The honest statement in the docs rests on this: ts falls back to "now". If someone teaches
  // TS_RE the ISO-8601 shape, this flips, and the docs sentence about misdating must go with it.
  const before = Date.now();
  const ev = parseLine(CORE_LINES[0]);
  const after = Date.now();
  assert.ok(ev.ts >= before && ev.ts <= after,
    `ts ${ev.ts} looks parsed from the line rather than defaulted; if Core timestamps are now `
    + 'understood, the "misdates the event feed" warning in the docs is stale');
  // The line says 2026-09-13T01:30:00Z. If it were parsed, ts would be that instant.
  assert.notEqual(ev.ts, Date.parse('2026-09-13T01:30:00Z'));
  // And the event now SAYS the time is ours, rather than leaving a reader of the feed
  // to discover it from the docs. A Core rule set that taught TS_RE the ISO shape would
  // drop this flag, which is the signal the docs have to change.
  assert.equal(ev.tsFallback, true);
});

test('the same parser DOES extract figures from the format it was built for', () => {
  // The contrast is the point: this is not a broken parser, it is a parser for another grammar.
  const ev = parseLine('2026-09-07 09:24:39.281 [dlc] -- network recv this tick: 6.6KB (674.1B/s) | total recv: 1.8MB || disk write this tick: 0.0B (0.0B/s) | total written: 1.7MB --');
  assert.equal(ev.kind, 'bandwidth');
  assert.equal(ev.netThisTick, 6600);
  assert.equal(ev.netRate, 674.1);
  assert.ok(ev.ts < Date.parse('2026-09-08'), 'and its timestamp comes from the line, not the clock');
});

test('every shipped fixture is experimental-format, so no test implies Core coverage', () => {
  for (const name of ['log-samples.txt', 'log-samples-bench.txt', 'bench-log-sample.txt']) {
    const f = path.join(HERE, 'fixtures', name);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const iso = lines.filter((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(l));
    assert.equal(iso.length, 0,
      `${name} contains ${iso.length} Core-shaped (ISO-8601) lines; if Core fixtures were added, `
      + 'the "no Core log has been tested" claim in the docs is no longer true');
    assert.ok(lines.some((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[/.test(l)),
      `${name} should be experimental-format (space-separated timestamp with milliseconds and a [tag])`);
  }
});
