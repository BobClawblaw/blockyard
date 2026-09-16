// The sign-in page's redirect target, checked. Its own module so the tests can hold it without a DOM.
/**
 * Where to go after signing in: a path on THIS site, or the dashboard (audit 2026-09-16, L1).
 * `startsWith('/')` let `//evil.example/` and `/\\evil.example/` through, and browsers treat both as
 * another host -- a genuine sign-in page that hands you to a lookalike. Resolve it against our own
 * origin and keep it only if the origin did not change.
 */
export function safeNext(next, origin) {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/';
  try {
    const u = new URL(next, origin);
    return u.origin === new URL(origin).origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch { return '/'; }
}
