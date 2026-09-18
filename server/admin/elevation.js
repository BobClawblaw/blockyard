// ELEVATION: the session gets you the UI, it does not get you the money.
//
// (docs/PLAN-ADMIN-SUITE.md §2.6. Operator chose password re-entry over TOTP at scoping,
// 2026-09-18, with TOTP left open as an addition at M8 rather than a replacement.)
//
// Every state change in this suite -- a spend, a config write, a daemon restart -- needs a
// password typed again within the last `admin.elevationMs`. What that buys, precisely:
//
//   - a stolen session cookie is not enough. It is the difference between "someone got
//     your cookie" and "someone got your cookie AND your password".
//   - a borrowed laptop with a live tab cannot spend.
//   - an XSS that can read the DOM and make requests still cannot elevate, because the
//     password is not in the DOM, not in a cookie and not in any response.
//
// What it does not buy, said plainly so nobody assumes otherwise: an attacker who can
// keylog or phish the password defeats it, and an XSS that can wait for the user to
// elevate and then act inside the window defeats it for that window. The window is short
// for that reason, and every use of it is audited.
//
// The grant is keyed by SESSION, not by user: elevating in one browser must not elevate
// the same account in another, which is what makes "elevate, walk away, someone else's
// tab is now armed" impossible.
import crypto from 'node:crypto';

// Elevations live here, in memory, keyed by the session's tokenHash -- which is the
// server's own identifier for a session, never leaves this process, and is not the token
// the browser holds. They are deliberately NOT written to the session file: an elevation
// must not survive a restart, and a grant on disk is a grant somebody can read.
//
// A session that is destroyed or revoked leaves its grant behind, unreachable (no request
// can present a session that no longer resolves) and swept within the window. That is why
// the window is minutes rather than hours.
const grants = new Map(); // tokenHash -> { at, expiresAt, username }

// A wrong password here is a password-guessing attempt against a live admin session, so it
// is throttled harder than a login and it is audited every time.
const attempts = new Map(); // tokenHash -> { n, first }
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60_000;

function sweep(now = Date.now()) {
  for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id);
  for (const [id, a] of attempts) if (now - a.first > ATTEMPT_WINDOW_MS) attempts.delete(id);
}

/** How long this session's elevation has left, in ms; 0 when it has none. */
export function elevationLeft(sessionId, now = Date.now()) {
  if (!sessionId) return 0;
  const g = grants.get(sessionId);
  if (!g || g.expiresAt <= now) return 0;
  return g.expiresAt - now;
}

/**
 * Verify the password and grant this session an elevation window.
 *
 * Returns `{ ok, leftMs, error }`. The password is never stored, never logged, never put
 * in the audit record, and never echoed back in an error -- the caller gets a boolean and
 * a reason, and the reason never contains what was typed.
 */
export async function elevate(app, { sessionId, username, password }, now = Date.now()) {
  sweep(now);
  if (!sessionId || !username) return { ok: false, error: 'not signed in' };

  const a = attempts.get(sessionId) ?? { n: 0, first: now };
  if (a.n >= MAX_ATTEMPTS) {
    await app.audit({ type: 'admin-elevate-throttled', username, ip: 'session' });
    return { ok: false, error: `too many wrong passwords; wait ${Math.ceil((ATTEMPT_WINDOW_MS - (now - a.first)) / 60000)} minute(s)` };
  }

  // users.verify() returns { ok, user, reason } -- NOT a boolean. Destructured, because
  // `if (!await verify(...))` reads correctly, compiles, and elevates on every password
  // ever typed: an object is truthy. Found while writing this file (2026-09-18), which is
  // the argument for reading the function you are calling rather than the name of it.
  // `reason` also covers a disabled account, which verify() refuses even with the right
  // password -- an account switched off must not be able to elevate.
  const v = await app.users.verify(username, String(password ?? ''));
  if (!v.ok) {
    attempts.set(sessionId, { n: a.n + 1, first: a.first });
    await app.audit({ type: 'admin-elevate-failed', username, attempt: a.n + 1, reason: v.reason ?? 'bad password' });
    return { ok: false, error: v.reason === 'account disabled' ? 'this account is disabled' : 'that password is not right' };
  }

  attempts.delete(sessionId);
  const ms = app.cfg.admin?.elevationMs ?? 300_000;
  grants.set(sessionId, { at: now, expiresAt: now + ms, username });
  await app.audit({ type: 'admin-elevated', username, forMs: ms });
  return { ok: true, leftMs: ms };
}

/** Give up the window early -- the "lock" button, and what logout calls. */
export function dropElevation(sessionId) { if (sessionId) grants.delete(sessionId); }

/**
 * Require an elevation for this request, or throw the refusal the route should return.
 *
 * `consume: true` ends the window as well: used for the actions where one password should
 * authorise exactly one thing (a spend), rather than everything done in the next five
 * minutes. Which actions consume is the caller's decision and is stated at each call site.
 */
export function requireElevation(ctx, { consume = false, what = 'this action' } = {}) {
  const sessionId = ctx.session?.tokenHash ?? null;
  const left = elevationLeft(sessionId);
  if (left <= 0) {
    const err = new Error(`${what} needs your password again (the session alone does not authorise it)`);
    err.status = 403;
    err.code = 'elevation-required';
    throw err;
  }
  if (consume) dropElevation(sessionId);
  return left;
}

/** Test seam: elevations are process-local, and a test that boots twice needs a clean slate. */
export function __resetElevations() { grants.clear(); attempts.clear(); }

/** For the status route: never the grant itself, only whether and how long. */
export function elevationState(sessionId) {
  const left = elevationLeft(sessionId);
  return { elevated: left > 0, leftMs: left };
}

/** A token the UI can show in a header ("armed for 4:12") without exposing anything. */
export function elevationLabel(leftMs) {
  if (leftMs <= 0) return 'not elevated';
  const s = Math.ceil(leftMs / 1000);
  return `elevated for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Unused today; kept because M4 wants a nonce per confirmed spend. */
export function confirmationNonce() { return crypto.randomBytes(16).toString('base64url'); }
