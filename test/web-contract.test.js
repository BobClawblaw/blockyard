import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A browser-console error is invisible from here, and a wrong element id simply
// blanks a panel with no signal at all. These checks catch the cheap-to-detect,
// expensive-to-notice class of front-end breakage without needing a browser.

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const html = read('index.html');
const loginHtml = read('login.html');
// Each document is checked against the scripts it actually loads: login.js' ids
// live in login.html, and looking for them in index.html is how this test was
// itself wrong the first time.
const shell = { doc: html, js: ['js/app.js', 'js/panels.js', 'js/charts.js', 'js/fmt.js'].map(read).join('\n') };
const login = { doc: loginHtml, js: read('js/login.js') };
const all = [shell, login].map((d) => d.js).join('\n');

test('every element id the JS looks up exists in the page (or is created by the JS)', () => {
  for (const page of [shell, login]) {
    const ids = new Set([...page.doc.matchAll(/id="([^"$]+)"/g)].map((m) => m[1]));
    // ids the JS itself emits into innerHTML are legitimately absent from the skeleton
    const created = new Set([...page.js.matchAll(/id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
    const refs = [...page.js.matchAll(/getElementById\(['"]([A-Za-z0-9_]+)['"]\)/g)].map((m) => m[1]);
    const missing = [...new Set(refs)].filter((r) => !ids.has(r) && !created.has(r));
    assert.deepEqual(missing, [], `getElementById targets with no element: ${missing.join(', ')}`);
  }
});

test('every #id querySelector target exists in the page', () => {
  const ids = new Set([...[shell, login].map((d) => d.doc).join('').matchAll(/id="([^"$]+)"/g)].map((m) => m[1]));
  const refs = [...all.matchAll(/querySelector\(['"]#([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((r) => !ids.has(r));
  assert.deepEqual(missing, [], `querySelector targets with no element: ${missing.join(', ')}`);
});

test('the pages navigable from the nav all exist as sections', () => {
  // ATTRIBUTE ORDER IS NOT PART OF THE CONTRACT. This matched `<button data-page=` only, so a
  // button that led with any other attribute was invisible to it -- which is how the brand
  // (`<button type="button" data-page="about" class="brand">`, the About link) slipped past while
  // its section was seen, reporting a drift that did not exist. Matching data-page anywhere in the
  // tag makes this catch MORE buttons, not fewer.
  const navPages = [...html.matchAll(/<button[^>]*\sdata-page="([a-z]+)"/g)].map((m) => m[1]);
  const sections = [...html.matchAll(/<section class="page[^"]*" data-page="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(navPages.sort(), sections.sort(), 'nav and page sections drifted apart');
});

test('app.js renders a case for every page, and panels.js exports it', () => {
  const app = read('js/app.js');
  const panels = read('js/panels.js');
  const cases = [...app.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);
  const sections = [...html.matchAll(/data-page="([a-z]+)"/g)].map((m) => m[1]);
  for (const s of new Set(sections)) assert.ok(cases.includes(s), `no render case for page "${s}"`);
  for (const fn of ['renderChain', 'renderMempool', 'renderPeers', 'renderNetwork', 'renderLogs', 'renderNode', 'renderAdmin', 'ensureLogsLoaded']) {
    assert.match(panels, new RegExp(`export (async )?function ${fn}\\b`), `panels.js does not export ${fn}`);
  }
});

test('no inline script or external URL in the page (CSP is self-only)', () => {
  assert.equal(/<script(?![^>]*src=)/i.test(html), false, 'inline <script> would be blocked by script-src \'self\'');

  // A LOAD IS NOT A LINK. The rule here was "no http(s):// anywhere", and its stated reason was
  // that an external URL would not load on a LAN box -- which is a fact about RESOURCES: a script,
  // a stylesheet, an image. An <a href> is a navigation target. It fetches nothing, costs nothing
  // offline, and the About page is required to carry one (operator, 2026-09-12: "link to our
  // github page for the project").
  //
  // So the protection is kept and made specific: every external URL in the page must be an anchor
  // destination. One appearing in src=, or as a stylesheet href, still fails -- which is the case
  // the original rule existed to catch.
  const external = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)]
    .map((m) => m[0])
    .filter((u) => !u.startsWith('http://www.w3.org'));
  const anchored = new Set([...html.matchAll(/<a\b[^>]*\shref="(https?:\/\/[^"]+)"/g)].map((m) => m[1]));
  const loaded = external.filter((u) => !anchored.has(u));
  assert.deepEqual(loaded, [],
    'an external URL that is not an <a href> is a resource load, which script-src/img-src \'self\' would block');
});

test('the login page uses an external script, matching script-src self', () => {
  assert.equal(/<script(?![^>]*src=)/i.test(loginHtml), false, 'inline script on login.html would be blocked by CSP');
});

test('the login page exists and posts to the login endpoint', () => {
  assert.ok(fs.existsSync(path.join(HERE, 'login.html')), 'login.html missing: /api/login has no page to call it');
  assert.match(login.js, /\/api\/login/, 'login page never calls the login endpoint');
  assert.match(login.js, /blockyard_csrf/, 'login page must handle the CSRF cookie that later mutations echo');
  assert.match(login.js, /429/, 'login page must handle the lockout response, not just bad credentials');
});

test('the 404 page the static server falls back to exists', () => {
  assert.ok(fs.existsSync(path.join(HERE, '404.html')), 'server.js serves /404.html for unknown paths');
});

test('the chart kit guards against a zero-size canvas', () => {
  // A hidden page has clientWidth 0; dividing by it yields NaN coordinates that
  // silently kill the render loop for that canvas.
  const charts = read('js/charts.js');
  assert.match(charts, /clientWidth \|\| .*clientWidth \|\| 320/, 'prep() must fall back to a real width');
  assert.match(charts, /Math\.max\(1, w - L\.left - L\.right\)|Math\.max\(10, w - L\.left - L\.right\)/, 'plot width must not go to zero or negative');
});

test('the sync header is one dense strip, names its node, and never expands by default', () => {
  const app = read('js/app.js');
  // The complaint: the sync section had to lose at least half its height and put
  // every blockchain stat on one or two properly formatted lines.
  assert.match(app, /class="strip"/, 'a single dense row drives every state');
  assert.match(app, /sync\.strip \?\? \[\]/, 'the ordered facts come from the server, not the browser');
  assert.doesNotMatch(app, /sync\.heroMode/, 'no second, taller layout is chosen from the state');
  assert.doesNotMatch(app, /class="sync-head|sync-pct|sync-facts/, 'the ~10-row hero is gone, not merely hidden');
  assert.match(app, /data-toggle-hero/, 'the long-form derivation is opt-in');
  assert.match(app, /class="expanded"/, 'and renders below the strip when asked for');
  // The complaint before that: "synced" while a different node was syncing.
  assert.match(app, /sync\.nodeLabel/, 'the strip names which node it describes');
  assert.match(app, /sync\.endpoint/, 'and its endpoint, since both nodes here are mainnet');
  assert.match(app, /data-jump-node/, 'a synced strip links straight to a node that IS syncing');
  // Unknown must explain itself rather than render dashes.
  assert.match(app, /Why this is unknown/, 'an unknown state carries the node reason');
  assert.match(app, /note-count/, 'caveats collapse to one count, expandable');
});

test('the header CSS keeps the strip hairline and leaves no dead hero rules', () => {
  const css = read('css/app.css');
  const bar = /\.bar \{[^}]*height: (\d+)px/.exec(css);
  assert.ok(bar, 'the bar needs an explicit small height');
  assert.ok(Number(bar[1]) <= 8, `bar must be a hairline, found ${bar[1]}px`);
  const sync = /\.sync \{[^}]*padding: (\d+)px (\d+)px (\d+)px/.exec(css);
  assert.ok(sync, 'sync padding must be explicit');
  assert.ok(Number(sync[1]) + Number(sync[3]) <= 20, `vertical padding too generous: ${sync[1]}/${sync[3]}`);
  // Dead rules are how a "shrink this" request quietly reverses itself.
  for (const gone of ['.sync-pct', '.sync-head', '.sync-facts', '.bar-legend', '.compact-row', '.sync-who']) {
    assert.ok(!css.includes(gone), `${gone} belongs to the removed layout`);
  }
  // Height budget, computed from the CSS rather than asserted in prose, so a
  // later "just add one more stat" cannot quietly rebuild the old header.
  const font = Number(/\.strip \{[^}]*font-size: (\d+)px/.exec(css)[1]);
  const barH = Number(bar[1]);
  const barMargin = Number(/\.bar \{[^}]*margin-top: (\d+)px/.exec(css)[1]);
  const budget = Number(sync[1]) + Number(sync[3]) + Math.ceil(font * 1.5) + barMargin + barH + 2;
  assert.ok(budget <= 60, `one-line header budget exceeded: ${budget}px (was ~212px in the removed hero)`);

  // Classes the markup still uses must still exist.
  for (const needed of ['.badge', '.strip', '.sf', '.expanded', '.caveat', '.pulse']) {
    assert.ok(css.includes(needed), `${needed} is referenced but undefined`);
  }
});

test('every state fetch names the selected node', () => {
  const app = read('js/app.js');
  // Picking the attention node then fetching /api/state without ?node= silently
  // returned the primary node: the picker looked correct, the data was elsewhere.
  // Now there is one fetch path and it names the node.
  const fetches = [...app.matchAll(/api\(`\/api\/state([^`]*)`\)/g)];
  assert.ok(fetches.length >= 1, 'expected at least one /api/state fetch');
  for (const m of fetches) {
    assert.match(m[1], /\?node=\$\{encodeURIComponent\(state\.node\)\}/,
      'every /api/state fetch must carry ?node=');
  }
  assert.match(app, /await backgroundRefresh\(\);/, 'boot loads through the same path');
  assert.match(app, /if \(!rec\.snap\) await backgroundRefresh\(\);/, 'a node with no cache is pulled on switch');
});

test('per-method RPC refusals are surfaced rather than collapsed to null', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'server', 'collect', 'monitor.js'), 'utf8');
  // Live case: getblockchaininfo answers -28 "Loading block index..." while
  // getmempoolinfo works. A swallowed error becomes an unexplained "unknown".
  assert.match(src, /errors\[k\] = `code \$\{v\.code \?\? '\?'\}: \$\{v\.message\}`/, 'capture the node message per method');
  assert.match(src, /chaininfo-unavailable/, 'raise it as a named quality flag');
  assert.match(src, /reason: s\.methodErrors\?\.getblockchaininfo/, 'and carry it into the sync read model');
});

/* The health-semantics contract is asserted behaviourally in
   test/health-semantics.test.js. A pattern-match version of this test passed
   while the feature was broken, so it is gone -- see rule 14. */

// A tab that cannot get data has to say so. Two ways this used to fail silently,
// both observed today: a snapshot-less page showed an open red bar with no text in
// it, and a tab left pointing at a node that had been removed from the config
// retried a 404 forever behind a catch that swallows every error alike.
const appJs = read('js/app.js');

test('a page with no snapshot yet explains itself instead of showing silent dashes', () => {
  assert.match(appJs, /} else if \(!s\) \{/, 'no branch for "no snapshot has ever arrived"');
  assert.match(appJs, /No data from /, 'the null-snapshot banner must carry words');
  // The specific old failure: the bar was toggled visible for a null snapshot but its
  // text was only written when a snapshot existed.
  const bannerWrites = [...appJs.matchAll(/getElementById\('offline'\)\.innerHTML = `([^`]{20,})/g)];
  assert.ok(bannerWrites.length >= 2, 'both the offline and no-snapshot cases must write banner text');
});

test('a node that has left the configuration is recovered, not retried forever', () => {
  assert.match(appJs, /err\.status === 404/, '404 must be distinguished from ordinary flakiness');
  assert.match(appJs, /async function recoverMissingNode/, 'and handled by an explicit recovery');
  const calls = [...appJs.matchAll(/await recoverMissingNode\(\)/g)];
  assert.ok(calls.length >= 1, 'the recovery has to be called from the refresh path');
  // Recovering means re-resolving from the server, not reloading the same request.
  assert.match(appJs, /function recoverMissingNode[\s\S]{0,900}api\('\/api\/nodes'\)/);
  assert.match(appJs, /no longer configured; watching/, 'say which node replaced it');

  // The recovery must not grow its own copy of the node-switch mechanics. The canvas
  // wipe and the cache swap belong to switchNode alone -- that single-ownership is
  // what test/never-blank.test.js defends, and a second copy would drift.
  const start = appJs.indexOf('async function recoverMissingNode');
  const fn = appJs.slice(start, appJs.indexOf('\n}\n', start) + 3);
  assert.ok(fn.length > 200, 'recovery body should be readable');
  assert.doesNotMatch(fn, /resetAllCharts/, 'recovery must not wipe canvases itself');
  assert.doesNotMatch(fn, /state\.snap = null|state\.series = null/, 'or null the cache -- never-blank owns that');
  assert.match(fn, /await switchNode\(/, 'it must delegate the switch to the one audited path');
});

test('having no nodes at all is stated as a configuration fact, not as a quiet monitor', () => {
  assert.match(appJs, /no nodes configured/i);
  assert.match(appJs, /config\/local\.json/, 'and says where to fix it');
});

// "Nothing refreshes" with a badge that says "reconnecting" and a server log that
// shows nothing: the client used to retry the SAME url forever, so a tab whose node
// had left the configuration never recovered and never explained itself.
test('a dead stream is noticed, explained, and re-resolved rather than retried forever', () => {
  const app = read('js/app.js');
  assert.match(app, /state\.lastFrameAt = Date\.now\(\)/, 'frames are timestamped, so silence is measurable');
  assert.match(app, /function attemptStreamRecovery/, 'and there is an explicit response to silence');
  assert.match(app, /attemptStreamRecovery\(/, 'called from more than one place (stream errors and the watchdog)');
  assert.ok((app.match(/attemptStreamRecovery\(/g) || []).length >= 3, 'stream error + watchdog + definition use sites');
  // Re-resolving means asking the server which nodes exist, then switching or saying
  // the data is stale -- not reloading the same dead node id.
  assert.match(app, /function attemptStreamRecovery[\s\S]{0,1200}recoverMissingNode\(\)/);
  assert.match(app, /figures below are the last ones received/, 'staleness must be claimed in words');
  // Stale badge: "live" is a claim, and it must not survive silence.
  assert.match(app, /badge\.textContent = 'stale'/);
});

test('the server refuses an unknown node on the stream rather than streaming silence', () => {
  const srv = fs.readFileSync(path.join(HERE, '..', 'server', 'http', 'server.js'), 'utf8');
  assert.match(srv, /unknown_node/, 'a typed, greppable reason');
  assert.match(srv, /app\.monitors\.has\(wantNode\)/, 'validated before the stream is accepted');
  assert.match(srv, /only ever be printed for/, 'and the log line is only printed for a stream that will deliver');
});

// This file used to hold a guard that the documented test count was "one number,
// not two" -- it compared README with AGENTS.md and so could only ever prove the
// two documents were wrong together. It passed while the docs said 180 and the
// suite printed 183. The replacement derives the number from the suite and
// validates its own scanner against a real `node --test` run: test/doc-counts.test.js.

test('the cards rewritten from the render path are reachable by id, not by traversal', () => {
  // The Fees card used to be found with `getElementById('ovFees').closest('.card')`.
  // The DOM stub answers closest() with null, so under test the rewrite was silently
  // skipped and the card kept its placeholder forever: the suite stayed green while the
  // browser showed a card that rendered nothing. Anything the render path must reach is
  // addressed by id, and that id must exist in the page.
  const ids = [...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  assert.match(shell.js, /getElementById\('ovFeesCard'\)/, 'the Fees card is addressed by id');
  assert.ok(ids.includes('ovFeesCard'), 'and the page carries that id');
  assert.doesNotMatch(shell.js, /\.closest\('\.card'\)/, 'no walking up from a child in the render path');
});
