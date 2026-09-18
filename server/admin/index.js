// THE ADMINISTRATIVE SUITE'S ENTRY POINT (docs/PLAN-ADMIN-SUITE.md).
//
// Nothing imports this file statically. `server/main.js` imports it dynamically, and only
// after `adminGate()` has said yes -- so on a default install this module, and everything
// it pulls in, is never evaluated. The sentinel below is how that is proved rather than
// asserted: `test/admin-disabled.test.js` boots a default monitor and fails if anything
// set it.
//
// Keep that property in mind when adding to this directory: a static import of anything
// under server/admin/ from a core file would quietly undo it.
globalThis.__blockyardAdminLoaded = true;

import { HttpError } from '../http/api.js';
import { adminGate, adminGateLine } from '../admin-gate.js';
import { elevate, dropElevation, elevationState, elevationLabel, requireElevation } from './elevation.js';

/** The suite's own refusal: an HttpError the server turns into a JSON envelope. */
function refuseWith(err) {
  throw new HttpError(err.status ?? 403, err.message, { code: err.code ?? 'admin-refused' });
}

/**
 * Wrap a handler so an elevation refusal becomes a proper 403 with a code the UI can
 * act on (it opens the password prompt on `elevation-required` rather than showing a
 * red box). Everything that changes state goes through this.
 */
function elevated(handler, { consume = false, what = 'this action' } = {}) {
  return async (ctx, app) => {
    try { requireElevation(ctx, { consume, what }); } catch (err) { refuseWith(err); }
    return handler(ctx, app);
  };
}

/**
 * The routes the suite adds, given the app it is loading into.
 *
 * Returns a table in the same shape as `server/http/api.js` exports, appended to the
 * core table by createAppServer. M0 adds exactly one route, and it is reflective: it
 * says what is open and what is not. No capability ships in M0 on purpose -- the gates
 * and their proofs come first (plan §8).
 */
export function adminRoutes(app) {
  return [
    {
      method: 'GET',
      path: '/api/admin/status',
      // `admin` role, like every other route in this suite will be. With accounts off
      // and admin.allowWithoutAuth set, the server serves everyone as `viewer`, so this
      // route is unreachable there -- which is correct: a monitor that cannot tell who
      // is asking has nobody to grant this to.
      auth: 'admin',
      handler: async (ctx) => {
        const gate = adminGate(app.cfg, { tls: app.tls, trustProxy: app.cfg.server?.trustProxy });
        return {
          enabled: true,
          summary: adminGateLine(gate, app.cfg),
          // What the suite can and cannot do right now, in the words the UI shows. Every
          // one of these is a gate from plan §2, reported rather than inferred.
          gates: {
            https: Boolean(app.tls) || Boolean(app.cfg.server?.trustProxy) || Boolean(app.cfg.admin?.allowInsecure),
            accounts: Boolean(app.cfg.auth?.enabled),
            walletsNamed: (app.cfg.admin?.wallets ?? []).length,
            elevationMs: app.cfg.admin?.elevationMs ?? 0,
            spendCapSat: app.cfg.admin?.spend?.capSat ?? null,
            spendCapSat24h: app.cfg.admin?.spend?.capSat24h ?? null,
            mainnetPhrase: Boolean(app.cfg.admin?.spend?.mainnetPhrase),
            addressBook: (app.cfg.admin?.addressBook ?? []).length,
          },
          // What this build can actually do, read by the UI rather than guessed from a
          // version number. Each milestone adds its own name here as it lands.
          capabilities: ['elevation'],
          // This session's elevation, never the grant itself.
          elevation: elevationState(ctx.session?.tokenHash ?? null),
          you: {
            username: ctx.user?.username ?? null,
            role: ctx.user?.role ?? null,
            // The wallet grant is reported even when it is false, because "you are an
            // administrator and still cannot send" is exactly the thing a person needs
            // told before they go looking for a broken button.
            walletAccess: Boolean(app.users?.find?.(ctx.user?.username)?.walletAccess),
          },
        };
      },
    },

    // ------------------------------------------------------------------- elevation
    // The password is POSTed, verified, and forgotten. It is not stored, not logged, not
    // audited and not echoed; what the audit trail records is that an elevation happened.
    {
      method: 'POST',
      path: '/api/admin/elevate',
      auth: 'admin',
      csrf: true,
      body: true,
      handler: async (ctx, app) => {
        const out = await elevate(app, {
          sessionId: ctx.session?.tokenHash ?? null,
          username: ctx.user?.username ?? null,
          password: ctx.body?.password,
        });
        if (!out.ok) throw new HttpError(403, out.error, { code: 'elevation-failed' });
        return { ok: true, leftMs: out.leftMs, label: elevationLabel(out.leftMs) };
      },
    },
    {
      method: 'POST',
      path: '/api/admin/elevate/drop',
      auth: 'admin',
      csrf: true,
      handler: async (ctx) => {
        dropElevation(ctx.session?.tokenHash ?? null);
        return { ok: true, elevation: elevationState(ctx.session?.tokenHash ?? null) };
      },
    },

    // ------------------------------------------------------------- the wallet grant
    // An administrator granting the wallet to an account is itself an elevated action:
    // it is the one change that turns "can administer the monitor" into "can spend".
    {
      method: 'POST',
      path: '/api/admin/users/:username/wallet-access',
      auth: 'admin',
      csrf: true,
      body: true,
      handler: elevated(async (ctx, app) => {
        const grant = ctx.body?.walletAccess === true;
        const out = await app.users.setWalletAccess(ctx.params.username, grant);
        await app.audit({
          type: grant ? 'admin-wallet-access-granted' : 'admin-wallet-access-revoked',
          username: ctx.user?.username ?? null, subject: ctx.params.username,
        });
        return { ok: true, user: out };
      }, { what: 'granting or revoking wallet access' }),
    },
  ];
}

/** Thrown by later milestones when a gate that is checked per request refuses. */
export function refuse(message) {
  throw new HttpError(403, message, { code: 'admin-refused' });
}
