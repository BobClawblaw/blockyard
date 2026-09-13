// Which address this process is willing to be reached on, and what to say when it
// can't be. Kept separate from the HTTP layer because the answers are boot-time
// facts about the machine, not about requests -- and because a failed bind used to
// surface as a raw Node stack trace, which tells you nothing about the one question
// that matters: which address did you ask for, and which ones does this box have?
import os from 'node:os';

export function networkInterfaces(over = null) {
  return over ?? os.networkInterfaces();
}

// Every unicast address the kernel actually has, as { name, address, family }.
export function localAddresses(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    for (const a of list ?? []) {
      if (a.internal && a.family !== 'IPv4') continue;
      out.push({ name, address: a.address, family: a.family, internal: !!a.internal });
    }
  }
  return out;
}

export function hasAddress(addr, ifaces = networkInterfaces()) {
  if (addr === '0.0.0.0' || addr === '::' || addr === '*' || addr == null) return true;
  const target = String(addr).replace(/^\[|\]$/g, '');
  const addrs = localAddresses(ifaces).map((a) => a.address.replace(/^\[|\]$/g, ''));
  if (addrs.includes(target)) return true;
  // `localhost` and 127.0.0.1 / ::1 are always bindable, present or not in the list.
  if (target === 'localhost' || target === '127.0.0.1' || target === '::1') return true;
  return false;
}

// Is the configured bind an address literal (or localhost)? A hostname here fails at
// listen() with a message about names, and after a reboot with a changed DNS it can
// fail at the worst possible moment, so it is worth refusing at load instead.
export function isBindableHost(host) {
  if (host == null || host === '') return true;
  const h = String(host).replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '*') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return h.split('.').every((p) => Number(p) <= 255);
  }
  if (h.includes(':')) return /^[0-9a-fA-F:.%]+$/.test(h);
  return false;
}

// Which of the "not served" interfaces are actually on this box, so the startup note
// can name the ones that stop working instead of reciting a generic list.
export function unservedNames(ifaces = networkInterfaces()) {
  return Object.keys(ifaces ?? {});
}

/**
 * Split a bind configuration into addresses, and say which this machine can take.
 *
 * Multiple addresses are supported because one socket cannot express "LAN and the
 * tunnel, but not the container bridges and not loopback" -- and because the
 * single-address version of this locked the operator out: their browser arrives over
 * the tailnet, and a LAN-only bind is unreachable from the tailnet (the tailnet does
 * not advertise 192.0.2.0/24 here).
 *
 * Missing addresses are reported, not fatal: a tunnel interface that is not up yet at
 * boot (tailscaled starting after the network) must not keep the monitor from
 * serving the interfaces that ARE present. Only "none of them work" is fatal.
 */
export function planBinds(hosts, ifaces = networkInterfaces()) {
  const list = (Array.isArray(hosts) ? hosts : String(hosts ?? '0.0.0.0').split(','))
    .map((h) => String(h).trim())
    .filter(Boolean);
  const bindable = [];
  const missing = [];
  for (const h of list) (hasAddress(h, ifaces) ? bindable : missing).push(h);
  return { list, bindable, missing, noneUsable: bindable.length === 0 };
}

/**
 * A human-readable explanation of a failed or impossible bind.
 *
 * The point is not politeness. Binding to one address is a decision with casualties
 * (loopback healthchecks, other interfaces, a DHCP address that moved), and an
 * operator staring at `EADDRNOTAVAIL` should not have to reconstruct that.
 */
export function bindProblemMessage({ err, host, port, ifaces = networkInterfaces() }) {
  const code = err?.code ?? '';
  const have = localAddresses(ifaces).filter((a) => a.family === 'IPv4');
  const listed = have.map((a) => `${a.address} (${a.name})`).join(', ') || 'no unicast IPv4 at all';
  const where = 'config/local.json → server.host, or BLOCKYARD_BIND';

  if (code === 'EADDRNOTAVAIL') {
    return `cannot bind http://${host}:${port} — this machine has no address ${host}. `
      + `Addresses present: ${listed}. If the interface or its lease changed, update ${where} `
      + `(or set 0.0.0.0 to accept every interface, which serves whatever the box has, including tunnels).`;
  }
  if (code === 'EACCES') {
    return `cannot bind ${host}:${port} — permission denied. Ports below 1024 need privileges; `
      + `use a high port (21000) or a reverse proxy in front.`;
  }
  if (code === 'EADDRINUSE') {
    const same = have.some((a) => a.address === host);
    return `cannot bind ${host}:${port} — something is already listening there. `
      + (same
        ? `The address is one of ours, so this is likely a second instance of this monitor: stop the other one (or point this one at another port).`
        : `${host} is not this machine's own address, so a different process or a container owns it.`)
      + ` Address list: ${listed}.`;
  }
  return `cannot bind ${host}:${port}${code ? ` (${code})` : ''}${err?.message ? `: ${err.message}` : ''}. `
    + `Addresses present: ${listed}. Override with ${where}.`;
}

// ---------------------------------------------------------------- CIDR membership
//
// This replaces prefix-TEXT matching, which over-permitted. `ipAllowed` used to
// compare `net.split('::')[0]` against the start of the client's address string,
// so `2001:db8:1::/48` accepted `2001:db8:1f::1` -- an address 14 bits outside the
// network -- because "2001:db8:1f::1" starts with the characters "2001:db8:1".
// Text has no idea where a nibble ends. This version parses both families to
// bytes and compares bit by bit.
//
// Malformed input fails CLOSED here: an entry that cannot be parsed can never
// admit a client, and `server.allowCidrs` is validated at config load, so a typo
// stops the boot rather than quietly widening (or narrowing) the gate.

/** Parse an IPv4 or IPv6 literal to bytes. Returns {family, bytes} or null. */
export function parseIp(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone); // %eth0 is a scope, not part of the address
  if (!s) return null;
  if (s.includes(':')) return parseIpv6(s);
  return parseIpv4(s);
}

function parseIpv4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return { family: 'ipv4', bytes: new Uint8Array(bytes) };
}

function parseIpv6(s) {
  if (s.includes(':::')) return null; // ':::' is not compression, it is a typo
  // Trailing IPv4 form (`::ffff:192.0.2.7`) occupies the low 4 bytes.
  const tail4 = /:\d{1,3}(?:\.\d{1,3}){3}$/.test(s);
  let head = s;
  let tailBytes = null;
  if (tail4) {
    const i = s.lastIndexOf(':');
    const v4 = parseIpv4(s.slice(i + 1));
    if (!v4) return null;
    tailBytes = v4.bytes;
    head = s.slice(0, i + 1) + '0'; // placeholder group, overwritten below
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const expand = (chunk) => {
    if (chunk === '') return [];
    const groups = chunk.split(':').filter((g) => g !== '');
    const out = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  let groups;
  if (halves.length === 2) {
    const left = expand(halves[0]);
    const right = expand(halves[1]);
    if (!left || !right) return null;
    if (left.length + right.length > 7) return null; // '::' must stand for >=1 group
    groups = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  } else {
    const only = expand(halves[0]);
    if (!only) return null;
    if (only.length !== 8) return null; // no '::' means all eight groups are required
    groups = only;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { bytes[i * 2] = (g >> 8) & 0xff; bytes[i * 2 + 1] = g & 0xff; });
  if (tailBytes) bytes.set(tailBytes, 12);
  return { family: 'ipv6', bytes };
}

/**
 * Parse one allowlist entry: a bare address (implies /32 or /128) or `addr/bits`.
 * Returns {ok:true, family, bytes, bits, text} or {ok:false, reason}.
 */
export function parseCidr(entry) {
  const text = String(entry ?? '').trim();
  if (!text) return { ok: false, reason: 'empty entry' };
  const slash = text.indexOf('/');
  const addrText = slash < 0 ? text : text.slice(0, slash);
  const parsed = parseIp(addrText);
  if (!parsed) return { ok: false, reason: `"${addrText}" is not an IPv4 or IPv6 address` };
  const full = parsed.family === 'ipv4' ? 32 : 128;
  let bits = full;
  if (slash >= 0) {
    const raw = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return { ok: false, reason: `"${raw}" is not a prefix length` };
    bits = Number(raw);
    if (bits > full) return { ok: false, reason: `/${bits} is wider than an ${parsed.family} address (${full} bits)` };
  }
  return { ok: true, family: parsed.family, bytes: parsed.bytes, bits, text };
}

/** Bit-exact membership of one address in one network. */
export function inNetwork(ipBytes, netBytes, bits) {
  if (ipBytes.length !== netBytes.length) return false; // v4 never matches a v6 net, and vice versa
  for (let i = 0; i < bits; i += 8) {
    const take = Math.min(8, bits - i);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((ipBytes[i / 8] & mask) !== (netBytes[i / 8] & mask)) return false;
  }
  return true;
}

/**
 * Is `ip` admitted by `cidrs`? Empty/absent list admits everything (the gate is
 * opt-in). Returns a decision with the reason, because "403 from this address"
 * with no explanation costs an afternoon: the message names the entry that
 * matched, or that the list holds only families the client is not in.
 */
export function ipDecision(ip, cidrs = []) {
  if (!cidrs.length) return { allowed: true, reason: 'no allowCidrs configured' };
  const parsedIp = parseIp(ip);
  if (!parsedIp) return { allowed: false, reason: `client address "${ip}" could not be parsed, so nothing can be admitted` };
  const bad = [];
  let familyMismatch = true;
  for (const entry of cidrs) {
    const net = parseCidr(entry);
    if (!net.ok) { bad.push(`${entry} (${net.reason})`); continue; }
    if (net.family !== parsedIp.family) continue;
    familyMismatch = false;
    if (inNetwork(parsedIp.bytes, net.bytes, net.bits)) {
      return { allowed: true, matched: net.text, reason: `matched ${net.text}` };
    }
  }
  const why = bad.length
    ? `malformed entries are never permissive: ${bad.join('; ')}`
    : familyMismatch
      ? `the allowlist holds only ${[...new Set(cidrs.map((c) => parseCidr(c).family).filter(Boolean))].join('/') || 'nothing parseable'}; the client is ${parsedIp.family}`
      : `not inside any of: ${cidrs.join(', ')}`;
  return { allowed: false, reason: why, malformed: bad };
}

/** Boolean form, kept for call sites that only branch. */
export function ipAllowed(ip, cidrs = []) {
  return ipDecision(ip, cidrs).allowed;
}

