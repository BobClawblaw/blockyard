// A SELF-SIGNED CERTIFICATE, MADE HERE (operator, 2026-09-15: "Can we make the signing process
// part of the installer to generate per-user certs for their nodes?" -- then "make https the
// forced default"). Node can make a key pair and sign bytes but cannot write an X.509
// certificate, and this repository has no dependencies by decision, so the certificate is
// assembled by hand: a v3 TBSCertificate in DER, signed with ECDSA P-256 over SHA-256, wrapped
// in PEM. Every install gets its own key and its own certificate, valid for a little over two
// years, naming the addresses the monitor is reached on (subjectAltName), and the server makes
// one on first start when no certificate of the operator's own is configured.
//
// The shape is the one `openssl req -x509` produces: issuer == subject (CN=blockyard),
// basicConstraints CA:TRUE, keyUsage digitalSignature+keyCertSign, extKeyUsage serverAuth. A
// browser warns once per address, as with any self-signed certificate, and then remembers it.
// Node's own X509Certificate parses the result, which is what the tests hold it to.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// ---------------------------------------------------------------- DER, the little that is needed
const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const int = (v) => {
  let b = Buffer.isBuffer(v) ? Buffer.from(v) : Buffer.from([v]);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const oid = (dotted) => {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const s = [];
    let x = v;
    do { s.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x > 0);
    for (let i = 0; i < s.length - 1; i++) s[i] |= 0x80;
    out.push(...s);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octet = (b) => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utc = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
};
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);

// an IP address as the bytes subjectAltName wants: four for v4, sixteen for v6
export function ipBytes(addr) {
  const kind = net.isIP(addr);
  if (kind === 4) return Buffer.from(addr.split('.').map(Number));
  if (kind !== 6) return null;
  let a = addr;
  // an embedded v4 tail (::ffff:192.0.2.1) becomes its two hextets
  const m = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const b = m[2].split('.').map(Number); a = `${m[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`; }
  const [head, tail = ''] = a.split('::');
  const hs = head ? head.split(':') : [], ts = tail ? tail.split(':') : [];
  const fill = a.includes('::') ? 8 - hs.length - ts.length : 0;
  const hex = [...hs, ...Array(Math.max(0, fill)).fill('0'), ...ts];
  if (hex.length !== 8) return null;
  const out = Buffer.alloc(16);
  hex.forEach((h, i) => out.writeUInt16BE(parseInt(h, 16), i * 2));
  return out;
}

const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`;

/**
 * Make a self-signed certificate and its private key.
 * @param {object} [o]
 * @param {string} [o.cn='blockyard']       the common name (issuer and subject alike)
 * @param {string[]} [o.sans=[]]            addresses and names the certificate is valid for
 * @param {number} [o.days=825]             validity, from `now`
 * @param {number} [o.now=Date.now()]
 * @returns {{ cert: string, key: string, fingerprint: string, notAfter: number, sans: string[] }}
 */
export function makeSelfSigned({ cn = 'blockyard', sans = [], days = 825, now = Date.now() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ECDSA_SHA256 = oid('1.2.840.10045.4.3.2');
  const name = seq(set(seq(oid('2.5.4.3'), utf8(cn))));
  const notBefore = new Date(now - 5 * 60 * 1000);                 // five minutes of clock skew
  const notAfter = new Date(now + days * 86_400_000);
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;        // positive, 128 bits
  // the names: unique, addresses as bytes, everything else as a DNS name
  const uniq = [...new Set(sans.map((s) => String(s).trim()).filter(Boolean))];
  // [2] dNSName and [7] iPAddress are IMPLICIT: the tag replaces the string's own, so the body is
  // the bare bytes (an IA5String TLV inside read back as '"\u0016\u0009localhost"')
  const names = uniq.map((s) => { const ip = ipBytes(s); return ip ? ctx(7, ip, false) : ctx(2, Buffer.from(s, 'ascii'), false); });
  const ext = (id, critical, body) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(body));
  const extensions = [
    ext('2.5.29.19', true, seq(bool(true))),                                  // basicConstraints CA:TRUE
    ext('2.5.29.15', true, bits(Buffer.from([0x84]), 2)),                     // keyUsage: digitalSignature, keyCertSign
    ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),                   // extKeyUsage: serverAuth
    ...(names.length ? [ext('2.5.29.17', false, seq(...names))] : []),        // subjectAltName
  ];
  const tbs = seq(
    ctx(0, int(2)),                       // version 3
    int(serial),
    seq(ECDSA_SHA256),
    name,                                 // issuer
    seq(utc(notBefore), utc(notAfter)),
    name,                                 // subject: the same, which is what "self-signed" means
    spki,
    ctx(3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const cert = pem('CERTIFICATE', seq(tbs, seq(ECDSA_SHA256), bits(signature)));
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const x = new crypto.X509Certificate(cert);
  return { cert, key, fingerprint: x.fingerprint256, notAfter: Date.parse(x.validTo), sans: uniq };
}

/** A name as it compares: an IP by its bytes (Node prints v6 expanded and upper-case), a DNS name lower-case. */
export const canonName = (s) => { const b = ipBytes(String(s).trim()); return b ? `ip:${b.toString('hex')}` : String(s).trim().toLowerCase(); };
/** The names a certificate carries, canonical (canonName), IPs and DNS names alike. */
export function certNames(certPem) {
  const x = new crypto.X509Certificate(certPem);
  return (x.subjectAltName ?? '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean).map(canonName);
}

/**
 * The monitor's own certificate under `dir`: made on first use, kept after that, remade when it
 * is within a fortnight of expiry or no longer names one of `mustName`. Returns the files and
 * whether anything was written.
 */
export function ensureSelfSigned(dir, { sans = [], mustName = [], days = 825, now = Date.now(), force = false } = {}) {
  const certFile = path.join(dir, 'cert.pem'), keyFile = path.join(dir, 'key.pem');
  let why = null;
  if (force) why = 'asked to';
  else if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) why = 'none yet';
  else {
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(certFile, 'utf8'));
      const have = certNames(fs.readFileSync(certFile, 'utf8'));
      const missing = mustName.filter((n) => !have.includes(canonName(n)));
      if (Date.parse(x.validTo) - now < 14 * 86_400_000) why = `it expires ${x.validTo}`;
      else if (missing.length) why = `it does not name ${missing.join(', ')}`;
      else if (!x.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8')))) why = 'the key does not match it';
    } catch (err) { why = `it cannot be read (${err.message})`; }
  }
  if (!why) return { certFile, keyFile, made: false, why: null };
  const made = makeSelfSigned({ sans: [...new Set([...sans, ...mustName])], days, now });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (file, text) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); };
  write(keyFile, made.key);
  write(certFile, made.cert);
  return { certFile, keyFile, made: true, why, fingerprint: made.fingerprint, notAfter: made.notAfter, sans: made.sans };
}
