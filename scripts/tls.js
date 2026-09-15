#!/usr/bin/env node
// blockyard tls -- make (or remake) this monitor's own self-signed certificate.
//
//   node scripts/tls.js [--out DIR] [--san a,b,c] [--days N] [--force] [--print]
//
// The server does this by itself on first start (HTTPS is the default), under <data>/tls,
// naming the addresses it is reached on. This command is for doing it by hand: after the
// machine's address changed, to add a name (--san), or to start over (--force). --print writes
// the certificate to stdout, for pasting into a browser's or another machine's trust store.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { ROOT } from '../server/config.js';
import { localAddresses } from '../server/netinfo.js';
import { ensureSelfSigned } from '../server/tls/selfsigned.js';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
if (flag('help') || flag('h')) {
  process.stdout.write('usage: blockyard tls [--out DIR] [--san a,b,c] [--days N] [--force] [--print]\n');
  process.exit(0);
}
const dir = arg('out', path.join(process.env.BLOCKYARD_DATA || path.join(ROOT, 'data'), 'tls'));
const extra = (arg('san', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const sans = ['localhost', os.hostname(), '127.0.0.1', '::1', ...localAddresses().map((a) => a.address), ...extra];
const r = ensureSelfSigned(dir, { sans, mustName: extra, days: Number(arg('days', 825)) || 825, force: flag('force') });
if (flag('print')) { process.stdout.write(fs.readFileSync(r.certFile, 'utf8')); process.exit(0); }
const names = (new crypto.X509Certificate(fs.readFileSync(r.certFile, 'utf8')).subjectAltName ?? '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, ''));
process.stdout.write(`${r.made ? `made a new certificate (${r.why})` : 'the certificate is current; nothing written (--force to remake it)'}\n  cert  ${r.certFile}\n  key   ${r.keyFile}\n  names ${names.join(', ')}\n${r.made ? '  restart BlockYard to serve it; browsers warn once per address\n' : ''}`);
