// CSP, and the two things that let it be tightened on 2026-09-09.
//
// (1) `style-src-attr 'unsafe-inline'` was carried because the markup drew bars and
//     progress widths with data-driven style attributes injected through innerHTML.
//     That allowance permits *any* injected markup to style itself, which on a page
//     that renders node-supplied strings is not a cosmetic exception. It is gone: the
//     widths now travel as data-w/data-left and are written through the CSSOM, which
//     CSP permits, and the static ones became classes.
//
// (2) There was no script nonce. `script-src 'self'` is fine *until* someone adds an
//     inline script, at which point it fails in the browser with nothing recorded on
//     the server side — the same silently-dead shape as the module-scope
//     ReferenceError that blanked this UI for a day. Pages are now rewritten per
//     response, so an inline script is possible and is reported when refused.
//
// Most of these assertions read shipped files rather than served bytes, because the
// failure being prevented is a future edit that reintroduces `style="…"`, works fine
// in the developer's browser, and quietly keeps the CSP hole open.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS, CSP_BASE, securityHeaders, renderHtml, newNonce, computeBuildId } from '../server/http/static.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const cspOf = (h) => (h['Content-Security-Policy'] ?? '').split(';').map((s) => s.trim());

test('the shipped CSP refuses inline styles in both directives', () => {
  const csp = cspOf(SECURITY_HEADERS);
  const style = csp.filter((d) => d.startsWith('style-src'));
  assert.ok(style.length >= 1, 'style-src must be present');
  for (const d of style) {
    assert.ok(!d.includes("'unsafe-inline'"),
      `${d} reopens the hole: data-driven widths go through data-* + CSSOM (app.js applyDataSizes), static ones through classes`);
  }
  assert.ok(!csp.some((d) => d.startsWith('style-src-attr')),
    'style-src-attr is the directive that carried the exception; it must not come back');
  assert.ok(csp.some((d) => d === "script-src 'self'" || d.startsWith("script-src 'self'")),
    'script-src stays ' + "'self'" + ' — the nonce is added per response, not baked in');
});

test('a nonce is offered per response, in script-src only', () => {
  const n1 = newNonce();
  const n2 = newNonce();
  assert.notEqual(n1, n2, 'a fixed nonce is a comment that says "inline scripts allowed"');
  assert.ok(Buffer.from(n1, 'base64').length >= 16, '16 bytes is the CSP example size; anything less is guessable');
  assert.match(n1, /^[A-Za-z0-9+/]+={0,2}$/, 'must be base64 of the bytes, not URL-safe: the browser compares the attribute literally');

  const h = securityHeaders({ nonce: n1 });
  const csp = cspOf(h);
  assert.ok(csp.some((d) => d === `script-src 'self' 'nonce-${n1}'`), 'the nonce belongs in script-src');
  assert.ok(!csp.some((d) => d.includes(`nonce-${n1}`) && !d.startsWith('script-src')),
    'a nonce in style-src would permit inline styles, which is the thing above');
  assert.equal(csp.filter((d) => d.startsWith('style-src')).length, 1, 'rewriting script-src must not duplicate other directives');
});

test('HSTS is only sent where it is honest', () => {
  assert.equal(securityHeaders({ tls: false, hstsMs: 60000 })['Strict-Transport-Security'], undefined,
    'over plain HTTP, HSTS pins an upgrade the server cannot serve');
  assert.equal(securityHeaders({ tls: true, hstsMs: 0 })['Strict-Transport-Security'], undefined,
    'max-age=0 is a teardown instruction, not a policy');
  const h = securityHeaders({ tls: true, hstsMs: 172_800_000 })['Strict-Transport-Security'];
  assert.equal(h, 'max-age=172800');
  assert.ok(!/preload|includeSubDomains/.test(h),
    'no preload on a LAN box whose address can be reissued, and no subdomain sweep from a monitor');
});

test('renderHtml versions assets and nothing else', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/css/app.css">
    <link rel="icon" href="data:image/svg+xml,%3Csvg%3E">
    </head><body>
    <a href="/">dashboard</a> <a href="/login">login</a>
    <script type="module" src="/js/app.js" nonce="%BLOCKYARD_NONCE%"></script>
    </body></html>`;
  const out = renderHtml(html, { nonce: 'NONCE123', build: '9.9.9-abc' });
  assert.ok(out.includes('href="/css/app.css?v=9.9.9-abc"'), 'css must be cache-busted by build');
  assert.ok(out.includes('src="/js/app.js?v=9.9.9-abc"'), 'the entry module must be cache-busted');
  assert.ok(out.includes('src="/js/app.js"') === false);
  assert.ok(out.includes('href="/"'), 'pages are no-cache already, and ?v= on "/" collides with the app\'s own ?node=/?range= space');
  assert.ok(out.includes('href="data:image'), 'a data: URL is not a path');
  assert.ok(out.includes('nonce="NONCE123"'), 'the nonce placeholder must be filled');
  // THE PATTERN MUST MATCH THE PLACEHOLDERS THAT EXIST. This guarded a placeholder prefix spelled with the project's old name, a naming
  // convention that has not existed since the rename to BlockYard -- static.js fills
  // %BLOCKYARD_NONCE% and %BLOCKYARD_BUILD% -- so it could never fire and had been passing
  // vacuously. The positive control below is what stops that happening again silently.
  const UNFILLED = /%BLOCKYARD_[A-Z_]+%/;
  assert.ok(!UNFILLED.test(out), `an unfilled placeholder ships to the browser as literal text: ${out.match(/%BLOCKYARD_[A-Z_]+%/g)}`);
  assert.ok(UNFILLED.test('<b>%BLOCKYARD_BUILD%</b>'),
    'the guard must actually match an unfilled placeholder, or it asserts nothing');
});

test('no shipped HTML file carries a style attribute', () => {
  const files = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
  assert.ok(files.length >= 3, `expected index/login/404, found ${files.join(',')}`);
  for (const f of files) {
    const src = read(`public/${f}`);
    const hits = src.match(/<[a-zA-Z][^>]*\sstyle\s*=\s*["'][^"']*["']/g) ?? [];
    assert.deepEqual(hits, [], `${f} has style attribute(s): ${hits.join(' | ')} — use a class from css/app.css`);
    assert.ok(!/%BLOCKYARD_NONCE%/.test(src) || /nonce="%BLOCKYARD_NONCE%"/.test(src), `${f}: the nonce placeholder must be on a tag`);
  }
});

test('no injected HTML in the front end carries a style attribute', () => {
  for (const f of ['js/app.js', 'js/panels.js', 'js/charts.js', 'js/fmt.js', 'js/login.js']) {
    const src = read(`public/${f}`);
    // `<tag ... style=` only. Prose in comments that says style="…" is not markup,
    // and matching it would punish the next person for explaining the rule.
    const hits = src.match(/<[a-zA-Z][^>`]*\sstyle\s*=\s*["']/g) ?? [];
    assert.deepEqual(hits, [], `${f} injects markup with a style attribute: ${hits.join(' | ')} — data-driven sizes go through data-w/data-left + applyDataSizes()`);
  }
});

test('the data-driven bar size really is written through the CSSOM', async () => {
  // The one assertion here that is about behaviour rather than text. Without it,
  // "no style attributes" would be a grep that broke the sync bar: a fill whose
  // width never lands renders as an empty bar on a node that is 96% synced.
  const { installDom } = await import('./dom-stub.js');
  installDom();
  const { applyDataSizes } = await import('../public/js/app.js');
  const box = document.createElement('div');
  box.innerHTML = '<div class="fill" data-w="96.5"></div><div class="vp-tick" data-left="42"></div>'
    + '<div class="bad" data-w="not-a-number"></div><div class="over" data-w="140"></div>';
  applyDataSizes(box);
  const [fill, tick, bad, over] = box.querySelectorAll('[data-w], [data-left]');
  assert.equal(fill.style.width, '96.5%');
  assert.equal(tick.style.left, '42%');
  assert.equal(bad.style.width ?? '', '', 'a non-numeric width must be skipped, not pasted into CSS');
  assert.equal(over.style.width, '100%', 'clamped: a stray figure cannot make the bar escape its track');
});

test('the build id changes when an asset changes, and is stable otherwise', async () => {
  const a = await computeBuildId(path.join(ROOT, 'public'), '0.1.0');
  const b = await computeBuildId(path.join(ROOT, 'public'), '0.1.0');
  assert.equal(a, b, 'a stable tree must produce a stable id, or every reload looks like a deploy');
  assert.match(a, /^0\.1\.0-[0-9a-f]{10}$/);
  const c = await computeBuildId(path.join(ROOT, 'public'), '0.2.0');
  assert.notEqual(a, c, 'the version is part of the id: bumping it is a deploy even if no file moved');
});

test('CSP_BASE is the single source, not a copy in two places', () => {
  assert.deepEqual(cspOf(SECURITY_HEADERS), CSP_BASE, 'SECURITY_HEADERS must be CSP_BASE joined, or the two drift apart');
  assert.ok(CSP_BASE.every((d) => d.length && !d.endsWith(';')), 'a stray ";" inside a directive silently truncates the policy');
});

test('injected markup carries data attributes, never style attributes', () => {
  // `style-src 'self'` refuses `style="..."` inside HTML the app builds itself, so
  // data-driven markup must ship data-* and land on el.style through the CSSOM.
  // This broke twice in a week: once when the allowance existed and code used it, once
  // when the policy was tightened and the code had not moved. The console filled with
  // several hundred blocked-inline-style reports and the block train lost every colour.
  // Numbers-only, from our own palette -- so a pool name from the node cannot become CSS.
  for (const f of ['mining.js', 'goggles.js', 'panels.js', 'charts.js', 'app.js']) {
    const src = read(`public/js/${f}`);
    const offenders = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && /style="/.test(line))
      .map(({ line, n }) => `${f}:${n}: ${line.trim().slice(0, 70)}`);
    assert.deepEqual(offenders, [], `${f} injects style attributes; use data-* + CSSOM (see applyMiningStyles / applyDataSizes)`);
  }
});
