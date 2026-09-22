// Per-account Display settings: the same blob /api/settings holds for the whole deployment, but
// one copy per signed-in user rather than one shared by everyone.
//
// Why this exists (operator, 2026-09-22: "We really need to add per-user options for storing
// configs on either the browser, or server" -- then, on being told the server side would be
// admin-only at first: "I take that back. Allow per-user settings also on server side"). The
// shared blob (server/http/api.js's /api/settings, server/main.js's app.settingsFile) is exactly
// right for a Kiosk on a wall -- one config, everyone who looks at it sees the same thing, and
// writing it is rightly admin-only (configWriteAllowed) once accounts exist. But it is the WRONG
// store for "I, a signed-in viewer or operator, want my own look" -- writing it needs admin, and
// even for an admin, changing it changes what EVERYONE ELSE sees too. This is the other half:
// a record a non-admin can write that touches nobody's view but their own, and that follows them
// across their own devices the way the shared blob follows a Kiosk.
//
// THE SERVER KEEPS THE BLOB AND NOTHING ELSE, same rule as the shared store (api.js's own comment
// on /api/settings): public/js/settings.js's normalise() owns the schema and clamps every value
// on the way in, so a hand-edited file cannot put the UI into a state the panel could not, and a
// size cap here is the only thing this file itself enforces.
import fsp from 'node:fs/promises';
import path from 'node:path';

export class UserSettingsStore {
  constructor(file) {
    this.file = file;
    this.byUser = new Map();   // userId -> { settings, updatedAt }
    this.loaded = false;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      this.byUser = new Map(Object.entries(data.users ?? {}));
      this.loaded = true;
      return { loaded: true, count: this.byUser.size };
    } catch (err) {
      if (err.code === 'ENOENT') return { loaded: false, count: 0 };
      // Same stance as UserStore: a corrupt file must not read as "nobody has saved anything",
      // because the next save would then silently discard everyone else's. Refuse to start.
      throw new Error(`per-user settings store at ${this.file} is unreadable (${err.message}); refusing to start rather than overwrite it`);
    }
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fh = await fsp.open(tmp, 'w', 0o600);
    await fh.writeFile(JSON.stringify({ version: 1, updatedAt: Date.now(), users: Object.fromEntries(this.byUser) }, null, 2));
    await fh.sync();
    await fh.close();
    await fsp.rename(tmp, this.file);
    try { await fsp.chmod(this.file, 0o600); } catch { /* filesystem may not support it */ }
  }

  /** This user's own settings blob, or null if they have never saved one. */
  get(userId) {
    return this.byUser.get(userId)?.settings ?? null;
  }

  /** Replace this user's own settings blob (whole-object, same as the shared store: no merge). */
  async set(userId, settings) {
    this.byUser.set(userId, { settings, updatedAt: Date.now() });
    await this.save();
  }

  /** Dropped when the account itself is deleted, so a stale record cannot outlive its user. */
  async remove(userId) {
    if (this.byUser.delete(userId)) await this.save();
  }

  get count() { return this.byUser.size; }
}
