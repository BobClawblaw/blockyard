// WHETHER THE ADMINISTRATIVE SUITE LOADS AT ALL (docs/PLAN-ADMIN-SUITE.md §2).
//
// This file is core and always loaded; it holds the DECISION and none of the capability.
// It exists as its own module for one reason: the decision has to be made before the
// suite's code is imported, because the operator's requirement is that a shut gate means
// the wallet modules "never ever get loaded into blockyard" -- absent from the process,
// not present and refusing (2026-09-18).
//
// That distinction is worth the file. A route that returns 403 is one bug away from not
// returning 403. Code that was never imported cannot be reached by any bug in this
// server, including one in the gate itself.
//
// Six conditions, checked in this order, each refusing with the name of the setting that
// would change it. `reasons` is every failure, not the first: an operator turning this on
// deserves the whole list at once rather than one per restart.

import { edition, EDITIONS } from './edition.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Is every bound host on this machine only? A public bind is a different proposition. */
export function boundPublicly(cfg) {
  const hosts = cfg.server?.hosts ?? [cfg.server?.host].filter(Boolean);
  return hosts.some((h) => !LOOPBACK.has(h));
}

/**
 * Decide whether the suite may load.
 *
 * `tls` is passed in rather than read from config because the server decides it at boot
 * (a certificate it made itself still counts), and `trustProxy` means someone else's TLS
 * terminator counts too -- the question is whether the passphrase crosses the wire in the
 * clear, not whether this process owns the certificate.
 */
export function adminGate(cfg, { tls = false, trustProxy = false, root = undefined } = {}) {
  const a = cfg.admin ?? {};
  const reasons = [];
  // CONDITION ZERO: is the suite even in this build (server/edition.js)? Checked before
  // `enabled`, because on the read-only edition the answer is not "you have it switched
  // off", it is "you do not have it" -- and an operator who set BLOCKYARD_ADMIN=1 and got
  // told it was disabled would go looking for the wrong thing.
  const ed = edition(root);
  if (!ed.canLoad) {
    return {
      ok: false,
      off: !a.enabled,
      edition: ed.declared,
      reasons: [ed.note ?? `this build does not carry the administrative suite (edition: ${ed.declared})`],
    };
  }
  if (!a.enabled) {
    return { ok: false, off: true, edition: ed.declared, reasons: ['the administrative suite is off (admin.enabled / BLOCKYARD_ADMIN=1)'] };
  }
  if (!tls && !trustProxy && !a.allowInsecure) {
    reasons.push('it serves plain HTTP: a wallet passphrase and an elevation password would cross the wire in the clear '
      + '(name server.tls.cert/key, or put a TLS terminator in front and set server.trustProxy, or admin.allowInsecure=true to accept it)');
  }
  if (!cfg.auth?.enabled && !a.allowWithoutAuth) {
    reasons.push('accounts are off, so there is no role to check and nobody to ask for a password '
      + '(BLOCKYARD_AUTH=1, or admin.allowWithoutAuth=true to accept that anyone who can reach the port is an administrator)');
  }
  if (boundPublicly(cfg) && !a.allowPublicBind) {
    reasons.push('it is bound to an address other than this machine, which puts a wallet interface on the network '
      + '(bind 127.0.0.1 and use an SSH tunnel, or admin.allowPublicBind=true)');
  }
  return { ok: reasons.length === 0, off: false, edition: ed.declared, reasons };
}

/** One line for the boot banner and the /api/config provenance table. */
export function adminGateLine(gate, cfg) {
  if (gate.edition === EDITIONS.READONLY) return 'administrative suite: NOT IN THIS BUILD (read-only edition) -- its code is not on this disk';
  if (gate.off) return 'administrative suite: OFF (the default) -- its modules are not loaded into this process';
  if (!gate.ok) return `administrative suite: REFUSED to load -- ${gate.reasons.join('; ')}`;
  // Entries are `{ node, wallet }` since 2026-09-19 (a bare name still reads on one node);
  // joined raw, an object prints as "[object Object]" in the banner.
  const wallets = (cfg.admin?.wallets ?? []).map((w) => (typeof w === 'string' ? w : `${w?.wallet} on ${w?.node}`));
  // N1 (audit 2026-09-19 round 2): when this switch is what lets the suite load with
  // accounts off, say so by name -- and say what is true, which is less than the switch's
  // name suggests. The switch satisfies the gate, so the suite LOADS; it does not make the
  // routes reachable, because every /api/admin/* route asks for role admin, and in open mode
  // the only identity is the frozen viewer (measured against the pre-fix server: accounts
  // off + admin.allowWithoutAuth: true, /api/admin/status answered 403).
  const viaSwitch = cfg.admin?.allowWithoutAuth === true && !cfg.auth?.enabled;
  return 'administrative suite: ON -- '
    + (viaSwitch ? 'accounts off, loaded via admin.allowWithoutAuth; its routes still refuse -- with no accounts there is no admin role to grant, so the suite is in this process but not reachable over HTTP (BLOCKYARD_AUTH=1 for reachability) -- ' : '')
    + (wallets.length ? `wallets ${wallets.join(', ')}` : 'no wallet named (admin.wallets is empty, so no wallet is reachable)')
    + `, elevation ${Math.round((cfg.admin?.elevationMs ?? 0) / 1000)}s`
    + `, spend cap ${cfg.admin?.spend?.capSat == null ? 'NOT SET (sends are refused until admin.spend.capSat is)' : `${cfg.admin.spend.capSat} sat`}`;
}
