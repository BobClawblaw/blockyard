// Sessions, CSRF and rate limiting.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseIp } from '../netinfo.js';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// AN IPv6 /64, NOT THE FULL ADDRESS (audit 2026-09-22, L6). A routed /64 is trivially available
// to anyone (many providers hand out a /64 or wider per customer by default), and LoginGuard's
// finer-grained buckets (`p:` per username+address, `i:` per address) used the full address --
// so rotating the low 64 bits got a fresh bucket on every attempt, degrading those two tiers to
// nothing while leaving only the per-username-across-every-address tier (`u:`) to catch a
// sustained attack. Collapsing to the /64 the way an ISP actually allocates one closes that
// without touching IPv4 (no equivalent trivial-rotation story there) or anything outside this
// module: the CIDR gate and the audit trail still see and record the real address.
export function loginThrottleKey(ip) {
  const parsed = parseIp(ip);
  if (!parsed || parsed.family !== 'ipv6') return String(ip ?? '');
  const net = Buffer.from(parsed.bytes.slice(0, 8)).toString('hex');
  return `v6:${net}`;
}

export class SessionStore {
  constructor(file, cfg) {
    this.file = file;
    this.cfg = cfg;
    this.sessions = new Map(); // tokenHash -> session
    this.loaded = false;
    this.dirty = false;
  }

  async load() {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      for (const s of data.sessions ?? []) this.sessions.set(s.tokenHash, s);
      this.loaded = true;
      this.sweep();
      return { loaded: true, count: this.sessions.size };
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`sessions file ${this.file} unreadable (${err.message})`);
      return { loaded: false, count: 0 };
    }
  }

  async save() {
    if (!this.dirty) return;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fh = await fsp.open(tmp, 'w', 0o600);
    await fh.writeFile(JSON.stringify({ version: 1, savedAt: Date.now(), sessions: [...this.sessions.values()] }, null, 2));
    await fh.sync();
    await fh.close();
    await fsp.rename(tmp, this.file);
    this.dirty = false;
  }

  create(user, { ip = null, userAgent = null } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const session = {
      tokenHash: hashToken(token),
      userId: user.id,
      username: user.username,
      role: user.role,
      csrf,
      createdAt: now,
      lastSeenAt: now,
      ip,
      // Stored truncated and never echoed back: useful for "sign out everywhere
      // else", and it must not turn into a place the app leaks device detail.
      userAgent: userAgent ? String(userAgent).slice(0, 120) : null,
    };
    this.sessions.set(session.tokenHash, session);
    this.dirty = true;
    return { token, session };
  }

  get(token) {
    if (!token) return null;
    const s = this.sessions.get(hashToken(token));
    if (!s) return null;
    const now = Date.now();
    if (now - s.createdAt > this.cfg.sessionTtlMs) { this.sessions.delete(s.tokenHash); this.dirty = true; return null; }
    if (now - s.lastSeenAt > this.cfg.idleTtlMs) { this.sessions.delete(s.tokenHash); this.dirty = true; return null; }
    // Touch at most every 30s: writing a timestamp on every request would make
    // every SSE heartbeat a state mutation.
    if (now - s.lastSeenAt > 30_000) { s.lastSeenAt = now; this.dirty = true; }
    return s;
  }

  destroy(token) {
    const hit = this.sessions.delete(hashToken(token));
    if (hit) this.dirty = true;
    return hit;
  }

  destroyForUser(userId) {
    let n = 0;
    for (const [k, s] of this.sessions) if (s.userId === userId) { this.sessions.delete(k); n += 1; }
    if (n) this.dirty = true;
    return n;
  }

  sweep() {
    const now = Date.now();
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (now - s.createdAt > this.cfg.sessionTtlMs || now - s.lastSeenAt > this.cfg.idleTtlMs) { this.sessions.delete(k); n += 1; }
    }
    if (n) this.dirty = true;
    return n;
  }

  active() {
    const byUser = new Map();
    for (const s of this.sessions.values()) byUser.set(s.userId, (byUser.get(s.userId) ?? 0) + 1);
    return { sessions: this.sessions.size, users: byUser.size };
  }

  listFor(userId) {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId)
      .map((s) => ({ createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent, current: false }));
  }
}

// Token bucket: a burst is fine, a sustained flood is not.
export class RateLimiter {
  constructor({ capacity = 30, perSec = 10 } = {}) {
    this.capacity = capacity;
    this.perSec = perSec;
    this.buckets = new Map();
  }

  check(key, cost = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSec);
    b.at = now;
    if (b.tokens < cost) {
      const need = cost - b.tokens;
      return { ok: false, retryAfterMs: Math.ceil((need / this.perSec) * 1000), remaining: 0 };
    }
    b.tokens -= cost;
    // Keep the map from growing without bound on a chatty LAN.
    if (this.buckets.size > 5000) {
      const cutoff = now - 600_000;
      for (const [k, v] of this.buckets) if (v.at < cutoff) this.buckets.delete(k);
    }
    return { ok: true, remaining: Math.floor(b.tokens) };
  }
}

// Failed-login tracking. Two attacks need to be visible: a grind on one account, and a spray across
// many accounts from one host.
//
// THE LOCK IS PER (USERNAME, ADDRESS) PAIR, NOT PER USERNAME (audit 2026-09-16, L14). The first cut
// locked the username itself after 8 failures from anywhere, and the address after 8 failures for
// any account: so one person behind a shared NAT or proxy could lock every account for everyone
// behind it, and anyone who knew a username could lock its owner out from any address. Now:
//   * 8 failures for one username from one address lock that pair;
//   * 5x that from one address, across every username, lock the address (a spray);
//   * 10x that for one username, across every address, lock the username (a distributed grind) --
//     a threshold only a real attack reaches, where locking the account is the right trade.
// The per-address throttle in front of the KDF (main.js loginLimiter) still paces all of it.
export class LoginGuard {
  constructor({ maxAttempts = 8, windowMs = 300000, lockoutMs = 600000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.attempts = new Map();
  }

  _entry(key) {
    // KEEP THE MAP BOUNDED (audit 2026-09-19, L2). A username spray across random names
    // grows `attempts` by three keys per try and nothing removed them: the RateLimiter
    // sweeps at 5,000 buckets, this map never did. Entries whose window has emptied and
    // whose lockout has expired carry no state a correct decision needs -- a failed try
    // outside the window neither locks nor counts -- so they are dropped here, before
    // the map is read rather than on a timer nobody wants to maintain.
    if (this.attempts.size > 5000) {
      const now = Date.now();
      const stale = now - this.windowMs;
      for (const [k, e] of this.attempts) {
        if (e.lockedUntil <= now && !(e.hits.length && e.hits[e.hits.length - 1] > stale)) this.attempts.delete(k);
      }
    }
    let e = this.attempts.get(key);
    if (!e) { e = { hits: [], lockedUntil: 0 }; this.attempts.set(key, e); }
    const cutoff = Date.now() - this.windowMs;
    e.hits = e.hits.filter((t) => t > cutoff);
    return e;
  }

  _keys(username, ip) {
    const bucket = loginThrottleKey(ip);
    return [
      [`p:${username}\u0000${bucket}`, this.maxAttempts],
      [`i:${bucket}`, this.maxAttempts * 5],
      [`u:${username}`, this.maxAttempts * 10],
    ];
  }

  status(username, ip) {
    let locked = 0, remaining = Infinity, worst = 0;
    for (const [key, max] of this._keys(username, ip)) {
      const e = this._entry(key);
      locked = Math.max(locked, e.lockedUntil);
      worst = Math.max(worst, e.hits.length);
      remaining = Math.min(remaining, Math.max(0, max - e.hits.length));
    }
    if (locked > Date.now()) return { blocked: true, retryAfterMs: locked - Date.now() };
    return { blocked: false, attempts: worst, remaining };
  }

  noteFailure(username, ip) {
    const out = [];
    for (const [key, max] of this._keys(username, ip)) {
      const e = this._entry(key);
      e.hits.push(Date.now());
      if (e.hits.length >= max) {
        e.lockedUntil = Date.now() + this.lockoutMs;
        e.hits = [];
        out.push(key.startsWith('p:') ? `u:${username}@i:${ip}` : key);
      }
      this.attempts.set(key, e);
    }
    return { locked: out };
  }

  noteSuccess(username, ip) {
    // success clears this pair only: it proves nothing about other addresses guessing this account
    this.attempts.delete(`p:${username}\u0000${ip}`);
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeMs, httpOnly = true, secure = false, sameSite = 'Strict', path: p = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAgeMs != null) bits.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return bits.join('; ');
}

// CSRF: the session cookie is HttpOnly + SameSite=Strict already; this adds the
// double-submit check on top so a cross-origin POST cannot slip past a browser
// that relaxed SameSite for some reason.
export function csrfOk(session, headerValue) {
  if (!session?.csrf) return false;
  if (!headerValue) return false;
  const a = Buffer.from(String(session.csrf));
  const b = Buffer.from(String(headerValue));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
