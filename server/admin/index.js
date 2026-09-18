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
      handler: async () => {
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
          // M0 ships no capability. The UI reads this rather than guessing from a
          // version number which milestones are present.
          capabilities: [],
        };
      },
    },
  ];
}

/** Thrown by later milestones when a gate that is checked per request refuses. */
export function refuse(message) {
  throw new HttpError(403, message, { code: 'admin-refused' });
}
