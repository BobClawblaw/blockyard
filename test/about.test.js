// THE ABOUT PAGE (operator, 2026-09-12: "We need to add an about menu ... show current version
// number. system info. os info version. bitcoin node version", and "Make clicking the BlockYard
// icon the About page then").
//
// Contract-style, like web-contract.test.js: these are facts about the shipped files, because the
// failure this guards against is the page existing and being unreachable, or the endpoint quietly
// growing a field that should never leave the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const html = read('../public/index.html');
const api = read('../server/http/api.js');
const app = read('../public/js/app.js');
const css = read('../public/css/app.css');
const about = read('../public/js/about.js');
const fmt = read('../public/js/fmt.js');
const readme = read('../README.md');

test('the monogram IS the About link, and it satisfies the same contract a nav tab does', () => {
  // It lives outside <nav>, so it cannot inherit the nav's delegated click handler.
  assert.match(html, /<button type="button" data-page="about" class="brand"/, 'the brand is a button that names its page');
  assert.equal((html.match(/<button[^>]*data-page="about"/g) ?? []).length, 1, 'exactly one button routes to About');
  assert.match(html, /<section class="page" data-page="about">/, 'and the section it names exists');
  assert.match(app, /case 'about': renderAbout\(/, 'with a render case, like every other page');
  assert.match(app, /getElementById\('brandAbout'\)\?\.addEventListener\('click'/,
    'the brand needs its OWN listener: the nav handler is bound to the nav element, which the brand sits outside');
  // the browser's button chrome must be removed, or the header grows a border and a background
  assert.match(css, /button\.brand \{[^}]*border: 0[^}]*\}/, 'the button chrome is neutralised');
});

test('About shows what the operator asked for, and nothing is a placeholder', () => {
  const section = html.slice(html.indexOf('data-page="about"'), html.indexOf('MEMPOOL -->'));
  assert.ok(section.includes('id="abSky"'), 'the galaxy canvas');
  assert.ok(section.includes('id="abApp"'), 'version and build');
  assert.ok(section.includes('id="abHost"'), 'system and OS');
  assert.ok(section.includes('id="abNode"'), 'the bitcoin node version');
  assert.match(section, /github\.com\/BobClawblaw\/blockyard/, 'a link to the project');
  assert.match(section, /<svg viewBox="0 0 16 16"[^>]*>[\s\S]*?<\/svg>/, 'the GitHub mark, drawn inline');
  assert.match(section, /Entirely made by machines\. Directed by human hands\./, 'the closing line, verbatim');
  // the donation address, and one click copies it (operator, 2026-09-14: "Add the bitcoin donation
  // address to the about screen ... Clicking on the address should copy to clipboard")
  const ADDR = 'bc1q249cv27lc2q7y0x53vkczgfvvgsjzhwxwv42gc';
  assert.match(section, new RegExp(`<button type="button" class="abdon" id="abDonate" data-copy="${ADDR}"`), 'the address is a button carrying itself to copy');
  assert.ok(section.includes(`<code>${ADDR}</code>`), 'and shown in full');
  assert.ok(readme.includes(ADDR), 'the same address the README gives');
  assert.match(about, /getElementById\('abDonate'\)/, 'about.js finds it');
  assert.match(about, /copyText\(btn\.dataset\.copy\)/, 'and copies what it carries');
  assert.match(about, /bindDonate\(h\)/, 'from the render');
  assert.match(fmt, /export function copyText/, 'the copy helper is shared from fmt.js');
  // the galaxy is forced on here rather than following the sky switch: this page has no data for
  // it to obscure, which is the whole reason it is the backdrop
  assert.match(about, /stars: true, galaxy: true/, 'the galaxy is on for About regardless of the board switches');
});

test('the about endpoint reports the machine\'s SHAPE and never its identity', () => {
  const route = api.slice(api.indexOf("path: '/api/about'"), api.indexOf("path: '/api/health'"));
  assert.ok(route, 'the route exists');
  for (const field of ['platform', 'release', 'arch', 'cpus', 'totalMemGb', 'node', 'version', 'build']) {
    assert.ok(route.includes(`${field}:`), `it reports ${field}`);
  }
  // THE POINT OF THIS TEST. The monitor is open-access by default, so this route is readable by
  // anyone who can reach the port. os.hostname()/userInfo()/networkInterfaces() are exactly what
  // test/privacy.test.js keeps out of committed files; they must not arrive over the wire either.
  for (const banned of ['hostname', 'userInfo', 'networkInterfaces', 'homedir', 'process.env']) {
    assert.ok(!route.includes(banned), `the about route must never expose ${banned}`);
  }
  assert.match(route, /auth: 'any'/,
    "'any', not 'none': with accounts on, the host's OS and processor should not be readable before sign-in");
});
