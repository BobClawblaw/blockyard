// A SHUTDOWN THAT CANNOT BE HELD OPEN (2026-09-30; operator, of a Kiosk showing "the live link kept failing" for 44 s
// after a deploy). The listeners used to close last, after the monitors stopped and the history was saved; a page
// whose stream had just been closed reconnected inside that window, the server took it, and server.close() waited on
// it for ever -- systemd killed the process at its 45 s stop timeout. Reproduced on the old code: a stream reconnected
// during the shutdown, and the process was still alive 15 s after SIGTERM. Now the listeners stop first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.js';

test('a shutdown stops taking connections at once, and a reconnecting stream cannot hold it open', async () => {
  await withApp({ auth: false }, async ({ app, base }) => {
    const ctl = new AbortController();
    const first = await fetch(`${base}/api/stream`, { signal: ctl.signal });
    assert.equal(first.status, 200, 'a live stream is open');
    const t0 = Date.now();
    const done = app.shutdown({ saveHistory: false });
    // the page reconnects at once, as an EventSource does when its stream ends
    let refused = false;
    try { await fetch(`${base}/api/stream`, { signal: AbortSignal.timeout(2000) }); } catch { refused = true; }
    await done;
    const ms = Date.now() - t0;
    ctl.abort();
    assert.ok(refused, 'the reconnect was refused: the server had stopped listening');
    assert.ok(ms < 3000, `the shutdown finished in ${ms} ms`);
  });
});
