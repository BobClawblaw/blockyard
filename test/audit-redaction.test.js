// WHAT THE AUDIT TRAIL MUST NOT KEEP.
//
// audit.jsonl is append-only and deliberately durable, so anything that reaches it is kept. The
// wrapper used to delete exactly two keys -- `password` and `rpcPassword` -- which covered the
// fields the routes of the day carried. But the trail also stores action ARGUMENTS and a preview
// of action RESULTS, so an action echoing a key-shaped argument would write a secret into the one
// file designed never to be rewritten. (Audit, 2026-09-13.)
//
// These tests drive the real app.audit -> app.readAudit round trip rather than grepping the
// source: a test that searched for the word "redact" would pass against an implementation that
// mentioned it and did nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.js';

test('secret-shaped fields never reach the trail, however deeply they are nested', async () => {
  await withApp({ auth: false }, async ({ app }) => {
    await app.audit({
      type: 'test-row',
      username: 'someone',
      password: 'top-secret-login',
      rpcPassword: 'top-secret-rpc',
      args: {
        method: 'importprivkey',
        privateKey: 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
        nested: [{ cookieFile: '/var/lib/bitcoind/.cookie', authorization: 'Basic abc' }],
      },
      result: { token: 'sess-abcdef', seed: 'correct horse battery staple' },
    });

    const rows = await app.readAudit(10);
    const row = rows.find((r) => r.type === 'test-row');
    assert.ok(row, 'the row should be written, just not with the secrets in it');

    const blob = JSON.stringify(row);
    for (const secret of [
      'top-secret-login', 'top-secret-rpc',
      'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ',
      'Basic abc', 'sess-abcdef', 'correct horse battery staple',
      '/var/lib/bitcoind/.cookie',
    ]) {
      assert.equal(blob.includes(secret), false, `the audit trail kept a secret: ${secret}`);
    }
  });
});

test('the useful fields survive, or the trail is redacted into uselessness', async () => {
  await withApp({ auth: false }, async ({ app }) => {
    await app.audit({
      type: 'action', username: 'admin', path: '/api/action', ip: '192.0.2.10',
      method: 'savemempool', poolKey: 'antpool', labelKey: 'foundry', ok: true, ms: 12,
    });
    const row = (await app.readAudit(10)).find((r) => r.type === 'action');
    assert.ok(row, 'the row exists');
    assert.equal(row.username, 'admin');
    assert.equal(row.method, 'savemempool');
    assert.equal(row.ok, true);
    assert.equal(row.ms, 12);
    // "key" is not in the secret pattern on purpose: these are labels, not credentials.
    assert.equal(row.poolKey, 'antpool', 'poolKey is not a secret and must not be redacted');
    assert.equal(row.labelKey, 'foundry', 'nor labelKey');
    assert.ok(row.at > 0, 'and the timestamp is still stamped');
  });
});
