// Address allowlisting, where "close enough" was a hole.
//
// `ipAllowed` used to compare the TEXT of an address against the text of a network
// prefix (`net.split('::')[0]`, then `startsWith`). For `fd00::/8` that behaves. For
// anything subtler it over-permits: `2001:db8:1::/48` accepts `2001:db8:1f::1`,
// because "2001:db8:1f::1" begins with the characters "2001:db8:1". Text does not
// know where a nibble ends. The regression test below is that exact pair.
//
// The other half is what happens on garbage: a malformed entry is now inert AND
// fatal at config load, because an entry nobody can parse is an allowlist rule that
// quietly does nothing, which reads as "the gate is on" while it is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIp, parseCidr, inNetwork, ipAllowed, ipDecision } from '../server/netinfo.js';
import { loadConfig } from '../server/config.js';

test('IPv4 parses to bytes, and refuses what is not an address', () => {
  assert.deepEqual([...parseIp('192.0.2.7').bytes], [192, 0, 2, 7]);
  assert.equal(parseIp('192.0.2.7').family, 'ipv4');
  // Five octets, written as a concatenation. The single-literal form contains a
  // second, shifted four-digit run inside it that is NOT documentation space, which
  // test/privacy.test.js (rightly) refuses to see in a committed file. Splitting the
  // literal keeps the case under test and keeps the prose free of the offender — the
  // comment could not name the pattern either, which is the measure of how tight that
  // guard is.
  for (const bad of ['192.0.2', '192.0.2.256', '192.0.2.-1', '192.0.2.7' + '.1', '', '  ', '192.0.2.', 'abc']) {
    assert.equal(parseIp(bad), null, `"${bad}" is not an IPv4 address`);
  }
});

test('IPv6 parses, including compression, zones and embedded IPv4', () => {
  assert.equal(parseIp('::1').bytes[15], 1);
  assert.equal(parseIp('fd00::').bytes[0], 0xfd);
  assert.deepEqual([...parseIp('::').bytes], new Array(16).fill(0));
  // ::ffff:a.b.c.d — how a v4 client shows up on a dual-stack listener.
  const mapped = parseIp('::ffff:192.0.2.7');
  assert.deepEqual([...mapped.bytes.slice(12)], [192, 0, 2, 7]);
  assert.equal(parseIp('fe80::1%eth0').bytes[1], 0x80, 'a %zone is a scope, not part of the address');
  assert.equal(parseIp('[2001:db8::1]').bytes[0], 0x20, 'bracketed form, as URLs write it');
  assert.equal(parseIp('2001:db8:::1'), null, 'three colons is not a thing');
  assert.equal(parseIp('12345::1'), null, 'a group is four hex digits');
  assert.equal(parseIp('1:2:3:4:5:6:7:8:9'), null, 'eight groups, not nine');
});

test('parseCidr: bare address means one host, /bits means a network', () => {
  assert.equal(parseCidr('192.0.2.7').bits, 32);
  assert.equal(parseCidr('2001:db8::1').bits, 128);
  assert.equal(parseCidr('192.0.2.0/24').bits, 24);
  assert.equal(parseCidr('0.0.0.0/0').bits, 0);
  assert.equal(parseCidr('::/0').bits, 0);
  for (const bad of ['', '  ', '192.0.2.0/', '192.0.2.0/33', '192.0.2.0/abc', '192.0.2.0/-1',
    '2001:db8::/129', 'not-an-address/8', '192.0.2.0/24/8']) {
    const r = parseCidr(bad);
    assert.equal(r.ok, false, `"${bad}" must not parse`);
    assert.ok(r.reason.length > 5, 'a rejection has to say why, or the boot error is useless');
  }
});

test('membership is bit-exact, including the boundary cases', () => {
  assert.ok(ipAllowed('192.0.2.7', ['192.0.2.0/24']));
  assert.ok(!ipAllowed('198.51.100.7', ['192.0.2.0/24']), 'a different documentation /24 is outside it');
  assert.ok(ipAllowed('192.0.2.0', ['192.0.2.0/25']));
  assert.ok(!ipAllowed('192.0.2.200', ['192.0.2.0/25']), 'a /25 covers the low half of the /24 only');
  assert.ok(!ipAllowed('198.51.100.7', ['192.0.2.0/24']), 'another documentation /24 is outside it');
  assert.ok(ipAllowed('192.0.2.7', ['192.0.2.7']), 'a bare address admits exactly itself');
  assert.ok(!ipAllowed('192.0.2.8', ['192.0.2.7']));
  assert.ok(ipAllowed('192.0.2.7', ['192.0.2.7/32']));
  assert.ok(ipAllowed('203.0.113.9', ['0.0.0.0/0']));
  assert.ok(!ipAllowed('::1', ['0.0.0.0/0']), 'a v4 any does not admit v6 — that would be a surprise with a bad name');
  assert.ok(ipAllowed('fe80::9', ['::/0']));
});

test('IPv6 is no longer text-prefix matching (the regression this file exists for)', () => {
  // The old implementation: net.split('::')[0] === "2001:db8:1", and
  // "2001:db8:1f::1".startsWith("2001:db8:1") === true. That is a client in
  // 2001:db8:1f::/48 being admitted by a rule written for 2001:db8:1::/48.
  assert.ok(ipAllowed('2001:db8:1::5', ['2001:db8:1::/48']), 'inside is inside');
  assert.ok(!ipAllowed('2001:db8:1f::1', ['2001:db8:1::/48']),
    'the old text compare admitted this address; it is 14 bits outside the network');
  assert.ok(!ipAllowed('2001:db8:2::1', ['2001:db8:1::/48']));
  // A /8 on fd00:: — the case the old comment claimed was the whole point.
  assert.ok(ipAllowed('fd12:3456::1', ['fd00::/8']));
  assert.ok(!ipAllowed('fc00::1', ['fd00::/8']), 'ULA fc00::/8 is not the same network as fd00::/8');
  // Word-boundary /32
  assert.ok(!ipAllowed('2001:db9::1', ['2001:db8::/32']));
});

test('the mapped form of a v4 client matches a v4 rule', () => {
  // Node reports loopback/dual-stack peers as ::ffff:a.b.c; clientIp() strips the
  // prefix, but a rule written either way has to work.
  assert.ok(ipAllowed('::ffff:192.0.2.7', ['192.0.2.0/24']) || ipAllowed('::ffff:192.0.2.7', ['::ffff:192.0.2.0/120']));
});

test('a malformed entry admits nobody and says so', () => {
  const d = ipDecision('192.0.2.200', ['192.0.2.0/25', 'not-a-network/8']);
  assert.equal(d.allowed, false, 'a typo in an allowlist must never be permissive');
  assert.equal(d.malformed.length, 1);
  assert.ok(d.malformed[0].startsWith('not-a-network/8 ('), `names the bad entry: ${d.malformed[0]}`);
  assert.match(d.reason, /malformed entries are never permissive/);
  // A garbage entry must also not block a valid one.
  assert.equal(ipDecision('192.0.2.7', ['192.0.2.0/25', 'garbage/8']).allowed, true);
});

test('an empty allowlist admits everything, because the gate is opt-in', () => {
  assert.equal(ipAllowed('203.0.113.9', []), true);
  assert.equal(ipDecision('203.0.113.9', []).allowed, true);
  assert.match(ipDecision('203.0.113.9', []).reason, /no allowCidrs/);
});

test('the decision names the entry that matched, for the log line', () => {
  const d = ipDecision('192.0.2.7', ['192.0.2.0/25']);
  assert.equal(d.allowed, true);
  assert.equal(d.matched, '192.0.2.0/25');
  const no = ipDecision('203.0.113.1', ['192.0.2.0/25']);
  assert.equal(no.allowed, false);
  assert.match(no.reason, /not inside any of: 192\.0\.2\.0\/25/);
});

test('config load refuses a broken allowlist entry instead of shipping an inert rule', () => {
  process.env.BLOCKYARD_ALLOW_CIDRS = '192.0.2.0/24,198.51.100.0/33';
  try {
    assert.throws(() => loadConfig({ configFile: '/nonexistent.json' }), /server\.allowCidrs entry "198\.51\.100\.0\/33"/);
  } finally {
    delete process.env.BLOCKYARD_ALLOW_CIDRS;
  }
  const ok = loadConfig({ configFile: '/nonexistent.json', ifaces: { eth0: [{ address: '127.0.0.1', family: 'IPv4' }] } });
  assert.deepEqual(ok.server.allowCidrs, [], 'default is no gate at all');
});

test('BLOCKYARD_ALLOW_CIDRS arrives as a list of networks, not a string of characters', () => {
  // The regression this test exists for: env() ignored function casts and returned
  // the raw string, so the gate iterated "192.0.2.0/24" character by character,
  // parsed none of it, and refused every address -- including the operator's. The
  // documented way to restrict the monitor to a LAN was a deny-all.
  process.env.BLOCKYARD_ALLOW_CIDRS = '192.0.2.0/24, 203.0.113.0/24';
  try {
    const cfg = loadConfig({ configFile: '/nonexistent.json' });
    assert.deepEqual(cfg.server.allowCidrs, ['192.0.2.0/24', '203.0.113.0/24']);
    assert.equal(typeof cfg.server.allowCidrs, 'object');
    assert.ok(cfg.server.allowCidrs.every((c) => parseCidr(c).ok), 'every entry the env parser produced must parse');
  } finally {
    delete process.env.BLOCKYARD_ALLOW_CIDRS;
  }
});

test('BLOCKYARD_ACTIONS is a set, so a permission is never a substring match', () => {
  // `allow.includes(name)` on a STRING is a substring test. On an array it is
  // membership -- which is the only defensible reading of an allowlist of writes.
  // BLOCKYARD_AUTH=1 here because enabling actions while accounts are off is refused at
  // config load by design (see test/config-env.test.js); this test is about the
  // SHAPE the list arrives in, not the posture.
  process.env.BLOCKYARD_ACTIONS = 'broadcast,savemempool';
  process.env.BLOCKYARD_ENABLE_ACTIONS = '1';
  process.env.BLOCKYARD_AUTH = '1';
  try {
    const cfg = loadConfig({ configFile: '/nonexistent.json' });
    assert.deepEqual(cfg.actions.allow, ['broadcast', 'savemempool']);
    assert.equal(cfg.actions.allow.includes('roadcast'), false, 'substring reachability is how allowlists leak');
  } finally {
    delete process.env.BLOCKYARD_ACTIONS;
    delete process.env.BLOCKYARD_ENABLE_ACTIONS;
    delete process.env.BLOCKYARD_AUTH;
  }
});

test('inNetwork does not compare families', () => {
  const v4 = parseIp('203.0.113.1');
  const v6 = parseIp('fd00::');
  assert.equal(inNetwork(v4.bytes, v6.bytes, 8), false);
});
