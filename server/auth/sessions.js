// Sessions, CSRF and rate limiting.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
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

// Failed-login tracking, keyed on BOTH username and address: a spray across many
// usernames from one host and a grind on one username from many hosts are
// different attacks and both need to be visible.
export class LoginGuard {
  constructor({ maxAttempts = 8, windowMs = 300000, lockoutMs = 600000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.attempts = new Map();
  }

  _entry(key) {
    let e = this.attempts.get(key);
    if (!e) { e = { hits: [], lockedUntil: 0 }; this.attempts.set(key, e); }
    const cutoff = Date.now() - this.windowMs;
    e.hits = e.hits.filter((t) => t > cutoff);
    return e;
  }

  status(username, ip) {
    const a = this._entry(`u:${username}`);
    const b = this._entry(`i:${ip}`);
    const locked = Math.max(a.lockedUntil, b.lockedUntil);
    if (locked > Date.now()) return { blocked: true, retryAfterMs: locked - Date.now() };
    const worst = Math.max(a.hits.length, b.hits.length);
    return { blocked: false, attempts: worst, remaining: Math.max(0, this.maxAttempts - worst) };
  }

  noteFailure(username, ip) {
    const out = [];
    for (const key of [`u:${username}`, `i:${ip}`]) {
      const e = this._entry(key);
      e.hits.push(Date.now());
      if (e.hits.length >= this.maxAttempts) {
        e.lockedUntil = Date.now() + this.lockoutMs;
        e.hits = [];
        out.push(key);
      }
      this.attempts.set(key, e);
    }
    return { locked: out };
  }

  noteSuccess(username, ip) {
    this.attempts.delete(`u:${username}`);
    this.attempts.delete(`i:${ip}`);
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
