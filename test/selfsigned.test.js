// THE MONITOR'S OWN CERTIFICATE (2026-09-15: "make https the forced default"): made with no
// dependencies, parsed by Node's own X509Certificate, trusted by a client that is given it, and
// made by the server itself on a start with no certificate named.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { makeSelfSigned, ensureSelfSigned, certNames, ipBytes, canonName } from '../server/tls/selfsigned.js';
import { loadConfig } from '../server/config.js';
import { withApp } from './helpers/http.js';

const ifaces = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };

test('makeSelfSigned writes a certificate Node parses, self-signed, naming what it was told', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const r = makeSelfSigned({ sans: ['localhost', '127.0.0.1', '::1', '192.0.2.10', 'monitor.lan', '2001:db8::10'], days: 825, now });
  const x = new crypto.X509Certificate(r.cert);
  assert.equal(x.subject, x.issuer, 'self-signed: issuer is subject');
  assert.match(x.subject, /CN=blockyard/);
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(r.key)), 'the key is the certificate\'s');
  assert.equal(x.ca, true, 'CA:TRUE, as openssl req -x509 writes it');
  assert.deepEqual(certNames(r.cert).sort(), ['127.0.0.1', '192.0.2.10', '2001:db8::10', '::1', 'localhost', 'monitor.lan'].map(canonName).sort());
  assert.ok(Math.abs(Date.parse(x.validTo) - (now + 825 * 86_400_000)) < 2000, 'valid for the days asked');
  assert.ok(Date.parse(x.validFrom) < now, 'valid from a little before now, for clock skew');
  assert.equal(x.fingerprint256, r.fingerprint);
  assert.equal(x.checkIP('192.0.2.10'), '192.0.2.10', 'the IP names are IP names, not DNS strings');
  assert.equal(x.checkHost('monitor.lan'), 'monitor.lan');
  assert.ok(x.verify(crypto.createPublicKey(r.key)), 'the signature verifies with its own key');
});

test('ipBytes: four bytes for v4, sixteen for v6, with :: expansion and an embedded v4 tail', () => {
  assert.deepEqual([...ipBytes('192.0.2.3')], [192, 0, 2, 3]);
  assert.equal(ipBytes('::1').toString('hex'), '00000000000000000000000000000001');
  assert.equal(ipBytes('2001:db8::10').toString('hex'), '20010db8000000000000000000000010');
  assert.equal(ipBytes('::ffff:192.0.2.1').toString('hex'), '00000000000000000000ffffc0000201');
  assert.equal(ipBytes('not.an.ip'), null);
});

test('a client that is given the certificate connects; one that is not, refuses', async () => {
  const r = makeSelfSigned({ sans: ['127.0.0.1', 'localhost'] });
  const srv = https.createServer({ cert: r.cert, key: r.key }, (req, res) => res.end('ok'));
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const get = (opts) => new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: '/', ...opts }, (res) => { let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve(t)); }).on('error', reject);
  });
  try {
    assert.equal(await get({ ca: r.cert }), 'ok', 'trusted once the certificate is in the client\'s store');
    await assert.rejects(get({}), /self[- ]signed|unable to verify|certificate/i, 'and refused by a client that has not been given it');
  } finally { srv.close(); }
});

test('ensureSelfSigned makes once, keeps, and remakes for expiry, a missing name or --force', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'by-tls-')), 'tls');
  const a = ensureSelfSigned(dir, { sans: ['127.0.0.1'], mustName: [] });
  assert.equal(a.made, true); assert.equal(a.why, 'none yet');
  assert.ok(fs.existsSync(a.certFile) && fs.existsSync(a.keyFile));
  assert.equal(fs.statSync(a.keyFile).mode & 0o777, 0o600, 'the key is private');
  const b = ensureSelfSigned(dir, { sans: ['127.0.0.1'], mustName: ['127.0.0.1'] });
  assert.equal(b.made, false, 'current: kept');
  const c = ensureSelfSigned(dir, { sans: ['127.0.0.1'], mustName: ['192.0.2.10'] });
  assert.equal(c.made, true); assert.match(c.why, /does not name 192\.0\.2\.10/);
  assert.ok(certNames(fs.readFileSync(c.certFile, 'utf8')).includes(canonName('192.0.2.10')));
  const d = ensureSelfSigned(dir, { sans: ['127.0.0.1'], now: Date.now() + 820 * 86_400_000 });
  assert.equal(d.made, true); assert.match(d.why, /expires/);
  const e = ensureSelfSigned(dir, { sans: ['127.0.0.1'], force: true });
  assert.equal(e.made, true); assert.equal(e.why, 'asked to');
});

test('HTTPS is the default: no certificate named means one is made, BLOCKYARD_TLS=0 means plain HTTP', async () => {
  const cfg = loadConfig({ configFile: '/nonexistent.json', ifaces });
  assert.equal(cfg.tls, true, 'on by default');
  assert.equal(cfg.__tlsAuto, true, 'with the monitor\'s own certificate, made at boot');
  const had = process.env.BLOCKYARD_TLS;
  process.env.BLOCKYARD_TLS = '0';
  try {
    const off = loadConfig({ configFile: '/nonexistent.json', ifaces });
    assert.equal(off.tls, false, 'plain HTTP when told');
    assert.equal(off.__tlsAuto, false);
  } finally { if (had === undefined) delete process.env.BLOCKYARD_TLS; else process.env.BLOCKYARD_TLS = had; }
  // ...and a boot with the default makes the files and serves HTTPS with them
  const hadReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await withApp({ config: { server: { tls: { enabled: true } } } }, async ({ app, client, dir }) => {
      assert.equal(app.tls, true);
      assert.equal(app.scheme, 'https');
      assert.ok(fs.existsSync(path.join(dir, 'store', 'tls', 'cert.pem')), 'the certificate lives under the data dir');
      assert.equal(app.cfg.server.tls.selfSigned, true);
      assert.ok(certNames(fs.readFileSync(app.cfg.server.tls.cert, 'utf8')).includes(canonName('127.0.0.1')), 'and names the bound address');
      const h = await client.get('/api/health');
      assert.equal(h.status, 200);
      assert.equal(h.body.tls, true, 'health says so');
    });
  } finally { if (hadReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = hadReject; }
});
