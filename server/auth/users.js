// Users: scrypt-hashed passwords in a JSON store, atomic writes.
//
// Threat model note: this is a multi-user webserver on a LAN that can read the
// secrets of a bitcoin node (the RPC cookie is readable by this process). So the
// credential store must not be the soft spot. scrypt at the default parameters costs
// 20 ms and 16.0 MB per guess, measured on this box on 2026-09-09 (128·r·N; the
// "~50 ms" this comment previously claimed was an estimate and is corrected here).
// That is what makes an offline crack of a leaked users.json expensive rather than
// trivial -- and also why an unthrottled login endpoint is a CPU denial of service
// (see app.loginLimiter in server/main.js and MEASUREMENTS §22). Never logged, never
// returned by any API, never sent to the browser.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
export const ROLES = ['viewer', 'operator', 'admin'];

export class UserStore {
  constructor(file, cfg) {
    this.file = file;
    this.cfg = cfg;
    this.users = [];
    this.loaded = false;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      this.users = Array.isArray(data.users) ? data.users : [];
      this.loaded = true;
      return { loaded: true, count: this.users.length };
    } catch (err) {
      if (err.code === 'ENOENT') return { loaded: false, count: 0 };
      // A corrupt user file must not silently mean "no users", because the
      // bootstrap path would then create a second admin and a later save would
      // erase whoever was there. Refuse loudly instead.
      throw new Error(`users store at ${this.file} is unreadable (${err.message}); refusing to start rather than overwrite it`);
    }
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fh = await fsp.open(tmp, 'w', 0o600);
    await fh.writeFile(JSON.stringify({ version: 1, updatedAt: Date.now(), users: this.users }, null, 2));
    await fh.sync();
    await fh.close();
    await fsp.rename(tmp, this.file);
    try { await fsp.chmod(this.file, 0o600); } catch { /* filesystem may not support it */ }
  }

  get count() { return this.users.length; }
  list() {
    return this.users.map((u) => ({
      id: u.id, username: u.username, role: u.role, createdAt: u.createdAt,
      updatedAt: u.updatedAt, lastLoginAt: u.lastLoginAt ?? null, disabled: !!u.disabled,
      scheme: u.params?.scheme ?? 'scrypt',
      // Visible so raising auth.scrypt is a change with an observable effect: the
      // admin page can say "2 of 5 accounts still use N=16384" instead of the
      // operator wondering whether the new number took.
      kdf: u.params ? { N: u.params.N, r: u.params.r, p: u.params.p, keylen: u.params.keylen } : null,
      kdfNeedsUpgrade: !!u.params && needsRehash(u, this.cfg?.scrypt),
    }));
  }

  find(username) {
    const want = String(username ?? '').toLowerCase();
    return this.users.find((u) => u.username === want) ?? null;
  }

  byId(id) { return this.users.find((u) => u.id === id) ?? null; }

  async createUser(username, password, { role = 'viewer' } = {}) {
    const uname = String(username ?? '').toLowerCase().trim();
    if (!USERNAME_RE.test(uname)) throw new Error('username must be 2-31 chars: lowercase letters, digits, dot, dash, underscore');
    if (this.find(uname)) throw new Error(`user "${uname}" already exists`);
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
    this.checkPasswordStrength(password, uname);
    const { hash, params } = await hashPassword(password, this.cfg.scrypt);
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      username: uname,
      salt: params.salt.toString('hex'),
      hash: hash.toString('hex'),
      params: { N: params.N, r: params.r, p: params.p, keylen: params.keylen, scheme: 'scrypt' },
      role,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastLoginAt: null,
      disabled: false,
    };
    this.users.push(user);
    await this.save();
    return { id: user.id, username: user.username, role: user.role };
  }

  checkPasswordStrength(password, uname) {
    const pw = String(password ?? '');
    const min = this.cfg.minPasswordChars;
    if (pw.length < min) throw new Error(`password must be at least ${min} characters`);
    const lower = pw.toLowerCase();
    if (uname && lower.includes(uname)) throw new Error('password must not contain the username');
    // No composition rules (they push people to "Password123!"), but a few
    // shapes that appear in every breach corpus are simply refused.
    const weak = /^(password|letmein|admin|welcome|qwerty|123456|changeme|bitcoin|btc)/i.test(pw);
    if (weak) throw new Error('password starts from a shape that appears in every breach corpus; pick something else');
    if (/^(.)\1+$/.test(pw)) throw new Error('password is a single repeated character');
  }

  /**
   * Verify a password, and quietly bring the stored hash up to date.
   *
   * The upgrade path is the reason the parameters are stored per user rather than
   * globally: a KDF cost is not a constant, it is a guess about next year's
   * hardware, and an installation that never rehashes keeps verifying against
   * 2026's choice forever. Doing it here — at the one moment the plaintext is in
   * hand — means raising `auth.scrypt` in the config actually raises it for every
   * account, one login at a time, with no forced password resets.
   *
   * An unknown `scheme` is refused rather than assumed to be scrypt: if this store
   * ever gains a second scheme, silently interpreting it wrong would mean every
   * password under it stops working (worse: starts working under weaker rules).
   */
  async verify(username, password) {
    const user = this.find(username);
    // Always do the KDF work, even for an unknown username, so response time
    // does not tell an attacker whether the account exists.
    const target = user ?? { salt: crypto.randomBytes(16).toString('hex'), hash: Buffer.alloc(32), params: { N: this.cfg.scrypt.N, r: this.cfg.scrypt.r, p: this.cfg.scrypt.p, keylen: this.cfg.scrypt.keylen } };
    const params = { N: target.params?.N ?? 16384, r: target.params?.r ?? 8, p: target.params?.p ?? 1, keylen: target.params?.keylen ?? 32 };
    const scheme = target.params?.scheme ?? 'scrypt';
    if (scheme !== 'scrypt') {
      if (!user) return { ok: false, user: null, reason: 'no such user' };
      return { ok: false, user, reason: `unsupported hash scheme "${scheme}"; reset this password` };
    }
    const derived = await scrypt(String(password ?? ''), Buffer.from(target.salt, 'hex'), params);
    const known = Buffer.from(target.hash, 'hex');
    const ok = known.length === derived.length && crypto.timingSafeEqual(known, derived);
    if (!user) return { ok: false, user: null, reason: 'no such user' };
    if (user.disabled) return { ok: false, user, reason: 'account disabled' };
    if (!ok) return { ok: false, user, reason: 'bad password' };
    user.lastLoginAt = Date.now();
    let upgraded = null;
    if (needsRehash(user, this.cfg.scrypt)) {
      // Only on a verified password: rehashing a wrong password would store a hash
      // of the wrong secret. Re-derived with the CURRENT configured cost, new salt.
      const { hash, params: np } = await hashPassword(String(password ?? ''), this.cfg.scrypt);
      upgraded = { from: { ...params }, to: { N: np.N, r: np.r, p: np.p, keylen: np.keylen } };
      user.salt = np.salt.toString('hex');
      user.hash = hash.toString('hex');
      user.params = { N: np.N, r: np.r, p: np.p, keylen: np.keylen, scheme: 'scrypt' };
      user.updatedAt = Date.now();
    }
    await this.save().catch(() => {});
    return { ok: true, user, upgraded };
  }

  async setPassword(username, password) {
    const user = this.find(username);
    if (!user) throw new Error('no such user');
    this.checkPasswordStrength(password, user.username);
    const { hash, params } = await hashPassword(password, this.cfg.scrypt);
    user.salt = params.salt.toString('hex');
    user.hash = hash.toString('hex');
    user.params = { N: params.N, r: params.r, p: params.p, keylen: params.keylen, scheme: 'scrypt' };
    user.updatedAt = Date.now();
    await this.save();
    return { id: user.id, username: user.username };
  }

  async setRole(username, role) {
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
    const user = this.find(username);
    if (!user) throw new Error('no such user');
    const admins = this.users.filter((u) => u.role === 'admin' && !u.disabled);
    if (user.role === 'admin' && role !== 'admin' && admins.length <= 1) {
      // Losing the last admin leaves nobody able to administer; refuse rather
      // than talk the operator out of their own tool.
      throw new Error('refusing to demote the last enabled admin');
    }
    user.role = role;
    user.updatedAt = Date.now();
    await this.save();
    return { id: user.id, username: user.username, role };
  }

  async setDisabled(username, disabled) {
    const user = this.find(username);
    if (!user) throw new Error('no such user');
    const admins = this.users.filter((u) => u.role === 'admin' && !u.disabled);
    if (user.role === 'admin' && disabled && admins.length <= 1) throw new Error('refusing to disable the last enabled admin');
    user.disabled = !!disabled;
    user.updatedAt = Date.now();
    await this.save();
    return { id: user.id, username: user.username, disabled: user.disabled };
  }

  async deleteUser(username) {
    const user = this.find(username);
    if (!user) throw new Error('no such user');
    const admins = this.users.filter((u) => u.role === 'admin' && !u.disabled);
    if (user.role === 'admin' && admins.length <= 1) throw new Error('refusing to delete the last enabled admin');
    this.users = this.users.filter((u) => u.id !== user.id);
    await this.save();
    return { deleted: user.username };
  }
}

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 128 * r * N + 1024 * 1024) }, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

/** Would this hash be derived differently under the currently configured cost? */
export function needsRehash(user, cfgScrypt) {
  if (!user?.params || !cfgScrypt) return false;
  const p = user.params;
  return p.N !== cfgScrypt.N || p.r !== cfgScrypt.r || p.p !== cfgScrypt.p || p.keylen !== cfgScrypt.keylen;
}

async function hashPassword(password, base) {
  const salt = crypto.randomBytes(16);
  const params = { ...base, salt };
  const hash = await scrypt(password, salt, base);
  return { hash, params };
}

// One-time bootstrap credential. Printed once to stdout and never stored in
// plaintext anywhere, so there is nothing to go looking for afterwards.
export function randomPassword(len = 20) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%*-+=';
  // crypto.randomInt, NOT randomBytes()%n. The alphabet is 66 long and 256 % 66 = 58, so the
  // modulo form drew the first 58 characters slightly more often than the rest -- a small bias,
  // in the one function whose entire job is to be an unguessable bootstrap credential. randomInt
  // rejection-samples internally, so the distribution is flat. (Audit, 2026-09-13.)
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export function usersFileExists(file) {
  return fs.existsSync(file);
}
