// The browser's structural check, run in the test suite.
//
// A missing import name parses cleanly, so `node --check` says nothing, and static
// "every id exists" tests say nothing. In the browser it is a ReferenceError *during
// module evaluation*: app.js builds a `helpers` object at module scope, so an
// identifier named there but never imported kills the file before login, before the
// SSE stream, before the first pixel -- and because no request is ever made, the
// server log is silent too. That is exactly what shipped, and what "I can't get the
// page to come up with stats" turned out to be:
//
//   app.js:3   import { lineChart, sparkline, paint, resetCanvas, COL } ...
//   app.js:379 charts: { lineChart, histogram, scatter, meter, stackedBars, ... }
//              -> Uncaught ReferenceError: histogram is not defined
//
// Node evaluates the same ESM graph, so importing the module here reproduces the
// browser's failure exactly -- with no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom-stub.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('app.js evaluates under the DOM stub -- the browser check without a browser', async () => {
  installDom({ withNetwork: true });
  let mod = null;
  let err = null;
  try {
    mod = await import('../public/js/app.js');
  } catch (e) {
    err = e;
  }
  assert.equal(err, null, `app.js failed to evaluate: ${err?.message}`);
  assert.ok(mod, 'module should resolve');
});

test('every chart helper named in app.js is actually imported', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const chartsSrc = fs.readFileSync(path.join(ROOT, 'public/js/charts.js'), 'utf8');
  const exported = new Set([
    ...[...chartsSrc.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]),
    ...[...chartsSrc.matchAll(/^export \{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean)),
  ]);

  const imported = new Set(
    (src.match(/import \{([^}]*)\} from '\.\/charts\.js';/s)?.[1] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );

  // The helpers.charts object literal is the load-bearing one: shorthand properties
  // there resolve identifiers at module scope. Scan EVERY `charts: { ... }` -- state
  // also has an empty `charts: {}`, and matching only the first occurrence made this
  // assertion silently check nothing (it passed while the real bug was live).
  const named = new Set();
  for (const m of src.matchAll(/charts: \{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const id = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(id)) named.add(id);
    }
  }
  assert.ok(named.size > 0, 'found no charts: { ... } object literal to check -- the test would be vacuous');

  const missing = [...named].filter((n) => exported.has(n) && !imported.has(n));
  assert.deepEqual(missing, [],
    `helpers.charts names chart helpers app.js never imported (module-scope ReferenceError): ${missing.join(', ')}`);

  // And every name it does import must exist, or the import itself is a link error.
  const bogus = [...imported].filter((n) => !exported.has(n));
  assert.deepEqual(bogus, [], `app.js imports names charts.js does not export: ${bogus.join(', ')}`);
});

test('panels.js is held to the same rule', () => {
  // panels.js is imported by app.js, so the same class of mistake blanks every page.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/panels.js'), 'utf8');
  const chartsSrc = fs.readFileSync(path.join(ROOT, 'public/js/charts.js'), 'utf8');
  const exported = new Set([
    ...[...chartsSrc.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]),
    ...[...chartsSrc.matchAll(/^export \{([^}]*)\}/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean)),
  ]);
  const imported = new Set(
    (src.match(/import \{([^}]*)\} from '\.\/charts\.js';/s)?.[1] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  );
  const bogus = [...imported].filter((n) => !exported.has(n));
  assert.deepEqual(bogus, [], `panels.js imports names charts.js does not export: ${bogus.join(', ')}`);

  // Called-but-never-imported identifiers, the same class, found by call site.
  const called = new Set([...src.matchAll(/(^|[^.\w])([a-z][A-Za-z0-9_]*)\(/g)].map((m) => m[2]));
  const definedLocally = new Set([
    ...[...src.matchAll(/^(?:export )?(?:function|const|let) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]),
  ]);
  const unexplained = [...called].filter((n) => exported.has(n) && !imported.has(n) && !definedLocally.has(n));
  assert.deepEqual(unexplained, [], `panels.js calls chart helpers it does not import: ${unexplained.join(', ')}`);
});

// The logs/peers/overview event feed: three columns (time, kind, text) per row.
// Reported as "fields carry over from one column to the next", and the cause was two
// bad tracks in one CSS rule -- `1fr` (auto min-width, blown out by a long hash) and a
// fixed 66px tag column narrower than the kind names it must hold.
const app = await import('../public/js/app.js');

function feedRows(html) {
  return [...html.matchAll(/<div class="row[^"]*">([\s\S]*?)<\/div>/g)].map((m) => (m[1].match(/<span/g) || []).length);
}

test('THE HEADER UPTIME SURVIVES A FRAME THAT DOES NOT CARRY IT', () => {
  // (operator, 2026-09-13: "Uptime keeps blanking out and does not stay drawn. It should stay
  // there until updated".)
  //
  // NOT A DROPPED STREAM -- `app` IS NOT IN AN SSE FRAME AT ALL. wireMonitor pushes
  // `m.snapshot({})`, the bare node snapshot, about once a second; the `app` block that carries
  // uptimeSec is added by fullState, which only runs on the HTTP pull every 20 s. So the figure was
  // written once per pull and wiped by the very next stream frame. This drives that exact sequence:
  // a pull frame, then a stream frame shaped the way the server really sends one.
  const { els } = installDom();
  els.get('appUp'); els.get('rpcLat'); els.get('offline');
  const pull = { online: true, label: 'n', health: { rpc: { lastLatencyMs: 6 } }, app: { uptimeSec: 3600 * 9 + 60 * 42 } };
  const streamFrame = { online: true, label: 'n', health: { rpc: { lastLatencyMs: 7 } } };  // no `app`, as sent
  const upText = () => globalThis.document.getElementById('appUp').textContent;

  app.state.snap = pull;
  app.render();
  const shown = upText();
  assert.match(shown, /\d/, `the pull frame draws a figure (${shown})`);

  app.state.snap = streamFrame;
  app.render();
  assert.equal(upText(), shown, 'and the stream frame that lacks `app` must not blank it');
  app.render();
  assert.equal(upText(), shown, 'nor the next one, nor any number of them');
  // the per-node figure beside it is deliberately NOT held, and this is where that shows: it
  // follows the CURRENT frame. Holding it would show one node's round trip under another node's
  // name after a switch. It never blanks anyway -- health.rpc is in every frame.
  assert.equal(globalThis.document.getElementById('rpcLat').textContent, '7ms', 'rpc latency tracks the frame in hand');

  // HELD IS NOT FROZEN: a new reading still replaces it. Persistence that cannot update is just a
  // different way of being wrong.
  app.state.snap = { ...pull, app: { uptimeSec: 3600 * 10 } };
  app.render();
  assert.notEqual(upText(), shown, `a fresh reading still updates it (${upText()})`);
  assert.equal(globalThis.document.getElementById('rpcLat').textContent, '6ms', 'and rpc latency moved with this frame too');
});

test('renderFeed always emits exactly three cells per row', () => {
  const { els } = installDom();
  const events = [
    { ts: Date.now(), tagBase: 'dlc', kind: 'bandwidth', severity: 'info', text: 'recv 11.2MB/s (avg 11.0MB/s) | run 150/438/7/73/0' },
    { ts: Date.now(), tagBase: 'dl', kind: 'peer_live_probe', severity: 'info', text: '121 confirmed-live peer(s)' },
    { ts: Date.now(), tagBase: 'block', kind: 'block_stored', severity: 'info', text: 'stored height=966090 hash=000000000000000000007d6b2f0a3c1d5e7f9a1b2c3d4e5f60718293a4b5c6d7e bytes=1464177 tx=6866 (via 193.223.81.8:8333)' },
    { ts: Date.now(), kind: 'raw', severity: 'warn', text: null },              // missing tagBase AND text
    { ts: null, tagBase: null, kind: null, severity: null, text: '' },          // everything missing
  ];
  els.get('lgFeed');                              // ensure the element exists via the stub
  app.renderFeed('lgFeed', events);
  const html = globalThis.document.getElementById('lgFeed').innerHTML;
  const counts = feedRows(html);
  assert.ok(counts.length >= 4, `expected several rows, got ${counts.length}`);
  assert.deepEqual([...new Set(counts)], [3],
    `every feed row must occupy exactly three cells; a row with fewer shifts its later cells into the next column: ${counts.join(',')}`);
});

test('the feed grid cannot be blown out by long content, or clipped by narrow tracks', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
  const row = css.match(/\.feed \.row \{[^}]*\}/)?.[0] ?? '';
  assert.ok(row, 'no .feed .row rule found -- the test would be vacuous');

  // The text track must be capped: `1fr` alone means min-width:auto, and one
  // unbreakable token then widens the row past its container.
  assert.match(row, /minmax\(0,\s*1fr\)/,
    'the text column must be minmax(0, 1fr); a bare 1fr lets a long hash stretch the row over the next column');

  // The kind column must be wide enough for the longest kind names that exist.
  const tracks = [...row.matchAll(/grid-template-columns:([^;]+)/g)][0][1].trim().split(/\s+/);
  const tagTrack = tracks[1] ?? '';
  const px = Number((tagTrack.match(/(\d+)px/) || [])[1] ?? 0);
  assert.ok(px >= 90, `kind column track is ${tagTrack || 'missing'}; kinds like peer_live_probe overflow a narrow fixed track into the text column`);

  // And long content must be able to break: overflow-wrap:anywhere reduces the
  // min-content contribution, which is what actually caps the track.
  const txt = css.match(/\.feed \.row \.txt \{[^}]*\}/)?.[0] ?? '';
  assert.match(txt, /overflow-wrap:\s*(anywhere|break-word)/, 'text must be able to break inside its track');
});
