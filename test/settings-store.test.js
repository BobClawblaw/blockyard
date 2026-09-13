// DISPLAY SETTINGS ON THE SERVER (operator, 2026-09-13: "This is a server app. Should store things
// on a server", and before that "The settings are not stored in the app?!???").
//
// Until this existed the settings lived in each browser's localStorage, which meant they could not
// be backed up, shared between a kiosk screen and a desk, or even read back by the server that was
// supposedly configured by them. GET/POST /api/settings keeps the blob in config/blockyard.json.
//
// The server deliberately knows NOTHING about the schema -- public/js/settings.js normalise()
// clamps every value on the way in, so a hand-edited file cannot reach a state the panel could not.
// What the server owes is durability, a size limit, and the same gate as every other config write.
// These tests pin exactly that, plus the one hazard the design nearly shipped with: a settings path
// pinned to the repository root, which would make a test run overwrite a real deployment's file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withApp } from './helpers/http.js';

test('the settings file follows the config file, so a test run cannot overwrite a real one', async () => {
  // THE REGRESSION THIS FILE EXISTS FOR. settingsFile was first written as
  // path.join(ROOT, 'config', 'blockyard.json') -- a constant pointing at the working copy. Every
  // assertion below POSTs settings, so with that path this suite would have rewritten the
  // operator's own display settings on each run, silently.
  await withApp({ auth: false }, async ({ app, dir }) => {
    assert.ok(app.settingsFile, 'the app must name the file it would read and write');
    assert.equal(path.dirname(app.settingsFile), path.dirname(app.configFile),
      'settings belong beside the config they accompany, not at a fixed repository path');
    assert.ok(app.settingsFile.startsWith(dir),
      `a hermetic boot must keep settings inside its temp dir, got ${app.settingsFile}`);
  });
});

test('nothing saved yet is a first-run answer, not a fault', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    assert.equal(fs.existsSync(app.settingsFile), false, 'a fresh boot writes no settings file');
    const r = await client.get('/api/settings');
    assert.equal(r.status, 200, 'the absence of settings is a 200 with an answer, not a 404');
    assert.equal(r.body.stored, false);
    assert.equal(r.body.settings, null, 'and no blob, so the client keeps its own defaults');
    assert.equal(r.body.file, app.settingsFile, 'it names the file it looked in');
  });
});

test('a saved blob round-trips, and the file is written for this user only', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    const settings = { version: 3, space: { dome: 9 }, blockanoid: { gridAlpha: 0.04 } };
    const w = await client.post('/api/settings', { settings });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    assert.equal(w.body.ok, true);
    assert.equal(w.body.file, app.settingsFile, 'it names the file it wrote');

    const r = await client.get('/api/settings');
    assert.equal(r.body.stored, true);
    assert.deepEqual(r.body.settings, settings, 'what went in is what comes back out');

    // 0600: this is a file the web server writes on behalf of whoever can reach the page.
    assert.equal(fs.statSync(app.settingsFile).mode & 0o777, 0o600,
      'the settings file must not be world-readable');
  });
});

test('a later save replaces the file rather than merging into it', async () => {
  // The client always sends the whole settled object, so a merge here would resurrect values the
  // operator just turned off -- a setting that will not stay off is worse than one that never saved.
  await withApp({ auth: false }, async ({ client }) => {
    await client.post('/api/settings', { settings: { version: 3, space: { dome: 9 }, gone: true } });
    await client.post('/api/settings', { settings: { version: 3, space: { dome: 2 } } });
    const r = await client.get('/api/settings');
    assert.deepEqual(r.body.settings, { version: 3, space: { dome: 2 } },
      'the second save is the whole truth; nothing survives from the first');
  });
});

test('a body that is not a settings object is refused, and writes nothing', async () => {
  await withApp({ auth: false }, async ({ client, app }) => {
    for (const bad of [undefined, null, 'nope', 42, ['a', 'b']]) {
      const r = await client.post('/api/settings', bad === undefined ? {} : { settings: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)} should be refused`);
      assert.equal(r.body.error?.code, 'bad_settings');
    }
    assert.equal(fs.existsSync(app.settingsFile), false, 'and no refusal left a file behind');
  });
});

test('an oversized blob is refused rather than written to disk', async () => {
  // This is a body from a browser that lands on disk, so it needs a ceiling. The real settled
  // object is a couple of kilobytes.
  await withApp({ auth: false }, async ({ client, app }) => {
    const good = { version: 3, space: { dome: 9 } };
    await client.post('/api/settings', { settings: good });

    const huge = { version: 3, filler: 'x'.repeat(300_000) };
    const r = await client.post('/api/settings', { settings: huge });
    assert.ok(r.status === 413 || r.status === 400,
      `an oversized blob must be refused, got ${r.status}`);

    const after = JSON.parse(fs.readFileSync(app.settingsFile, 'utf8'));
    assert.deepEqual(after, good, 'the refusal must leave the previous settings intact');
  });
});

test('with accounts ON the display settings are not writable by an anonymous caller', async () => {
  // Same gate as every other config write: configWriteAllowed() is admin-only once accounts exist.
  await withApp({ auth: true }, async ({ client, app }) => {
    const r = await client.post('/api/settings', { settings: { version: 3, space: { dome: 9 } } });
    assert.ok(r.status === 401 || r.status === 403,
      `expected a refusal, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(fs.existsSync(app.settingsFile), false, 'and nothing was written');
  });
});

test('with accounts ON, reading follows every other read route: a session is required', async () => {
  // Written first asserting an anonymous 200, on the theory that "the login page must know its
  // theme". It does not: server.js runs the session check for every route whose auth is not
  // 'none', so 'any' means any authenticated ROLE, and an anonymous GET here is refused exactly
  // as it is for /api/state, /api/mempool and /api/about. 'none' is reserved for /api/build and
  // /api/health, the two a login page genuinely needs. The route is consistent with the API; the
  // assertion was the thing that was wrong.
  await withApp({ auth: true }, async ({ client }) => {
    const anon = await client.get('/api/settings');
    assert.equal(anon.status, 401, 'no session, no read -- the same ceiling as every other view');

    const { csrf } = await client.login();
    assert.ok(csrf, 'the login must hand back a CSRF token');

    const mine = await client.get('/api/settings');
    assert.equal(mine.status, 200, 'signed in, the settings read like any other view');
    assert.equal(mine.body.stored, false, 'and nothing is stored on a fresh boot');

    // The signed-in write also exercises the csrf:true branch, which an open-access deployment
    // never reaches: server.js only demands a token when there IS a session.
    const w = await client.post('/api/settings', { settings: { version: 3, space: { dome: 4 } } }, { csrf });
    assert.equal(w.status, 200, `an admin may save: ${JSON.stringify(w.body)}`);

    const back = await client.get('/api/settings');
    assert.deepEqual(back.body.settings, { version: 3, space: { dome: 4 } });
  });
});

test('with accounts ON a write without the CSRF token is refused', async () => {
  await withApp({ auth: true }, async ({ client, app }) => {
    await client.login();
    const r = await client.post('/api/settings', { settings: { version: 3 } });   // no csrf
    assert.equal(r.status, 403, 'a session without a token is exactly the CSRF case');
    assert.equal(r.body.error?.kind, 'csrf');
    assert.equal(fs.existsSync(app.settingsFile), false, 'and nothing was written');
  });
});
