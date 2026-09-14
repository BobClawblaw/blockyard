// Where this process is reachable, and what happens when it can't be.
// Binding to a single interface is a decision with casualties (tailscale clients,
// loopback healthchecks, a DHCP lease that moved), so the failure has to name the
// address that was asked for, the ones the machine actually has, and where to change it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  localAddresses, hasAddress, isBindableHost, bindProblemMessage, planBinds,
} from '../server/netinfo.js';
import { loadConfig, configProblems } from '../server/config.js';
import os from 'node:os';
import path from 'node:path';

// A stand-in for this box: loopback, a LAN card, a tunnel, and a bridge.
const IFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
  enp14s0: [{ address: '192.0.2.10', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '198.51.100.7', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
};

test('localAddresses lists what the kernel has, and labels loopback', () => {
  const list = localAddresses(IFACES);
  const v4 = list.filter((a) => a.family === 'IPv4').map((a) => a.address);
  assert.deepEqual(v4.sort(), ['127.0.0.1', '172.17.0.1', '192.0.2.10', '198.51.100.7'].sort(), 'every IPv4 the fixture has');
  assert.equal(new Set(v4).size, 4, 'no duplicates');
  assert.ok(v4.includes('198.51.100.7') && v4.includes('192.0.2.10'), 'the fixture addresses are all listed');
  assert.ok(list.find((a) => a.address === '127.0.0.1')?.internal, 'loopback must be identifiable');
});

test('hasAddress accepts what could actually be bound', () => {
  assert.ok(hasAddress('192.0.2.10', IFACES), 'our LAN address');
  assert.ok(hasAddress('198.51.100.7', IFACES), 'our tunnel address');
  assert.ok(hasAddress('0.0.0.0', IFACES), 'the wildcard is always bindable');
  assert.ok(hasAddress('127.0.0.1', IFACES), 'loopback is always bindable');
  assert.ok(hasAddress('localhost', IFACES), 'and so is localhost by name');
  assert.equal(hasAddress('192.0.2.99', IFACES), false, 'an address the box does not have is not bindable');
});

test('a hostname is refused at load, not at listen time', () => {
  assert.ok(isBindableHost('192.0.2.10'));
  assert.ok(isBindableHost('::'));
  assert.ok(isBindableHost('fe80::1'));
  assert.ok(isBindableHost('localhost'));
  assert.equal(isBindableHost('myserver.example'), false, 'DNS at boot time is a way to fail strangely');
  assert.equal(isBindableHost('192.0.2.256'), false, 'and an octet typo is caught too');
});

test('a bind failure names the address asked for, the ones present, and where to change it', () => {
  const msg = bindProblemMessage({ err: { code: 'EADDRNOTAVAIL' }, host: '192.0.2.99', port: 8088, ifaces: IFACES });
  assert.match(msg, /no address 192\.0\.2\.99/, 'says which address failed');
  assert.match(msg, /192\.0\.2\.10 \(enp14s0\)/, 'lists what the box actually has');
  assert.match(msg, /BLOCKYARD_BIND|local\.json/, 'and where to fix it');

  // The wildcard alternative is offered, with its cost stated rather than hidden.
  assert.match(msg, /0\.0\.0\.0[\s\S]{0,120}(every interface|whatever the box has)/);
});

test('an in-use port says whether it is us double-binding or someone else', () => {
  const ours = bindProblemMessage({ err: { code: 'EADDRINUSE' }, host: '192.0.2.10', port: 8088, ifaces: IFACES });
  assert.match(ours, /second instance/i, 'a second copy of this monitor is the common case');

  const notOurs = bindProblemMessage({ err: { code: 'EADDRINUSE' }, host: '192.0.2.99', port: 8088, ifaces: IFACES });
  assert.match(notOurs, /different process|container/);

  const perm = bindProblemMessage({ err: { code: 'EACCES' }, host: '192.0.2.10', port: 80, ifaces: IFACES });
  assert.match(perm, /1024|high port/);
});

test('the config accepts the LAN bind and rejects a non-address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-bind-'));
  const write = (obj) => {
    const f = `${dir}/local.json`;
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  loadConfig({ configFile: write({ server: { host: '192.0.2.10' } }), ifaces: IFACES });
  assert.deepEqual(configProblems(), [], 'a real LAN address must be accepted');

  assert.throws(
    () => loadConfig({ configFile: write({ server: { host: 'myserver.example' } }) }),
    /server\.host[\s\S]*not an address literal/,
  );
});

test('a bind plan separates what can be served from what is merely absent', () => {
  const plan = planBinds(['192.0.2.10', '198.51.100.7', '192.0.2.99'], IFACES);
  assert.deepEqual(plan.bindable, ['192.0.2.10', '198.51.100.7']);
  assert.deepEqual(plan.missing, ['192.0.2.99'], 'named, so the boot log can say what was skipped');
  assert.equal(plan.noneUsable, false);

  // RFC 5737 documentation addresses: absent from IFACES, which is what this
  // case is about. An invented 10.x would have been an RFC1918 address in a repo
  // that gets pushed, for no reason.
  const dead = planBinds(['192.0.2.20', '192.0.2.21'], IFACES);
  assert.equal(dead.noneUsable, true, 'nothing bindable is fatal -- starting blind serves nobody');

  // A tunnel that is not up yet is the common case, and must not be fatal: the
  // interfaces that ARE present still get served.
  const tunnelDown = planBinds(['192.0.2.10', '198.51.100.7'], { ...IFACES, tailscale0: [] });
  assert.deepEqual(tunnelDown.bindable, ['192.0.2.10']);
  assert.equal(tunnelDown.noneUsable, false);
});

test('a comma list and an array mean the same thing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-bind2-'));
  const f = `${dir}/local.json`;
  fs.writeFileSync(f, JSON.stringify({ server: { hosts: ['192.0.2.10', '198.51.100.7'] } }));
  const fromArray = loadConfig({ configFile: f, ifaces: IFACES });
  assert.deepEqual(fromArray.server.hosts, ['192.0.2.10', '198.51.100.7']);
  assert.equal(fromArray.server.host, '192.0.2.10', 'the legacy single-address field still points at the first');

  process.env.BLOCKYARD_BIND = '192.0.2.10,198.51.100.7';
  try {
    const fromEnv = loadConfig({ configFile: f, ifaces: IFACES });
    assert.deepEqual(fromEnv.server.hosts, ['192.0.2.10', '198.51.100.7']);
  } finally { delete process.env.BLOCKYARD_BIND; }

  // A hostname anywhere in the list is refused at load, not at listen().
  fs.writeFileSync(f, JSON.stringify({ server: { hosts: ['192.0.2.10', 'box.example'] } }));
  assert.throws(() => loadConfig({ configFile: f }), /address literal/);
});

test('one server per address, because a socket cannot serve two interfaces', () => {
  // Regression: the first multi-bind attempt called server.listen() twice on one
  // server and died with ERR_SERVER_ALREADY_LISTEN -- caught only because the bind
  // failure path prints what it tried and what the machine has.
  const main = fs.readFileSync(new URL('../server/main.js', import.meta.url), 'utf8');
  const loop = main.slice(main.indexOf('for (const host of plan.bindable)'), main.indexOf('const served ='));
  assert.match(loop, /createAppServer\(app\)/, 'a fresh server per address');
  assert.match(loop, /\.listen\(cfg\.server\.port, host, resolve\)/);
  assert.match(main, /app\.servers = \[\]/);
  assert.match(main, /for \(const s of open\) s\.close\(/, 'shutdown must close every address');
  assert.match(loop, /for \(const s of app\.servers\).*close\(\)/s, 'a partial bind is torn down, not left half-serving');
});
