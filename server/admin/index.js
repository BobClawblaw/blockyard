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
import { capabilitySummary } from '../rpc/admin-allowlist.js';
import { namedWallets, requireNamedWallet, defaultNode, requireWalletAccess, walletOverview, walletUtxos, walletHistory, walletDescriptors, walletLabels, walletTransaction } from './wallet.js';
import { newAddress, labelAddress } from './receive.js';
import { buildSpend, confirmSpend, cancelBuild, pendingFor, addressBook } from './send.js';
import { daemonActions, daemonStop } from './daemon.js';
import { readNodeConf, writeNodeConf, readOwnConfig, writeOwnConfig, LOCKED_BLOCKS } from './config-edit.js';
import { decodeAny, broadcastRaw, previewBump, confirmBump } from './txtools.js';

/** The suite's own refusal: an HttpError the server turns into a JSON envelope. */
function refuseWith(err) {
  throw new HttpError(err.status ?? 403, err.message, { code: err.code ?? 'admin-refused' });
}

/**
 * Wrap a read handler so the wallet gates run first, in one place.
 *
 * Order matters and is the order of the plan's gate chain: hold the grant, then name a
 * wallet the operator opted in. A caller that skipped either would be one `await` away
 * from reading someone's balances without the grant.
 *
 * The request names the NODE as well as the wallet, and the pair is what is checked
 * (operator, 2026-09-19): a wallet name means nothing without the node it is on. With one
 * node configured the node may be left out; with several it may not, and nothing here
 * defaults to "the first one" -- neither the first node nor the first wallet.
 */
function walletRead(handler) {
  return async (ctx, app) => {
    try {
      requireWalletAccess(app, ctx.user);
      const { node, wallet } = requireNamedWallet(app, ctx.query?.node ?? defaultNode(app), ctx.query?.wallet);
      return await handler(ctx, app, { wallet, node });
    } catch (err) { refuseWith(err); }
  };
}

/**
 * The same gates as walletRead, for a handler that changes something.
 *
 * The wallet name comes from the body rather than the query string: a state change should
 * not be expressible as a URL somebody can be talked into clicking, even with CSRF in the
 * way. (CSRF is in the way -- this is belt and braces, and cheap.)
 */
function walletWrite(handler) {
  return async (ctx, app) => {
    try {
      requireWalletAccess(app, ctx.user);
      const { node, wallet } = requireNamedWallet(app, ctx.body?.node ?? defaultNode(app), ctx.body?.wallet);
      return await handler(ctx, app, { wallet, node });
    } catch (err) { refuseWith(err); }
  };
}

/**
 * Wrap a handler so an elevation refusal becomes a proper 403 with a code the UI can
 * act on (it opens the password prompt on `elevation-required` rather than showing a
 * red box). Everything that changes state goes through this.
 */
function elevated(handler, { consume = false, what = 'this action' } = {}) {
  return async (ctx, app) => {
    try { requireElevation(ctx, { consume: false, what }); } catch (err) { refuseWith(err); }
    // CONSUMED AT THE POINT OF NO RETURN, NOT ON ARRIVAL (fixed 2026-09-18, found by
    // test/admin-daemon.test.js). Consuming here, before the handler validates anything,
    // means a mistyped confirmation costs the operator their elevation: they type a
    // password, get told the confirmation was wrong, and have to type the password again
    // to try. Worse, it trains exactly the reflex this whole mechanism depends on them not
    // having. The handler calls ctx.consumeElevation() itself, immediately before the
    // irreversible step.
    //
    // AND RE-CHECKED AS IT IS CONSUMED (review, 2026-09-19). This was a bare drop, called
    // after the handler's awaits -- so two requests that both passed the check above on
    // arrival both proceeded, the second "consuming" an elevation that was already gone.
    // One password, one action has to hold for requests that are in flight together, not
    // only for ones that arrive one after another: the second caller throws here.
    if (consume) ctx.consumeElevation = () => requireElevation(ctx, { consume: true, what });
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
            // Read the way the send path reads it (server/admin/send.js, phraseFor): only an
            // explicit false turns the mainnet sentence off.
            mainnetPhrase: app.cfg.admin?.spend?.mainnetPhrase !== false,
            addressBook: (app.cfg.admin?.addressBook ?? []).length,
          },
          // What this build can actually do, read by the UI rather than guessed from a
          // version number. Each milestone adds its own name here as it lands.
          capabilities: ['elevation', 'wallet.read', 'wallet.receive', 'wallet.spend', 'node.control', 'config.edit', 'tx.tools'],
          lockedConfigBlocks: LOCKED_BLOCKS,
          rpc: capabilitySummary(),
          // `{ node, wallet }` pairs (operator, 2026-09-19). `node` is null for a bare name
          // in a config with several nodes -- a wallet the routes will refuse until the
          // entry names its node, shown so the screen can say which entry to fix.
          wallets: namedWallets(app).map(({ node, wallet }) => ({ node, wallet })),
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

    // ------------------------------------------------------------- the wallet, read-only
    // Every one of these is a read. The capability they go through
    // (server/rpc/admin-allowlist.js, `wallet.read`) contains no method that writes,
    // derives a key or unlocks anything, so this whole block cannot change the wallet
    // even if a handler below is wrong.
    //
    // They need the grant but NOT an elevation: re-asking for a password to look at a
    // balance would train the operator to type it without reading the prompt, which is
    // the habit the spend screen depends on them not having.
    {
      method: 'GET', path: '/api/admin/wallet', auth: 'admin',
      handler: walletRead(async (ctx, app, { wallet, node }) => ({ ok: true, ...(await walletOverview(app, { node, wallet })) })),
    },
    {
      method: 'GET', path: '/api/admin/wallet/utxos', auth: 'admin',
      handler: walletRead(async (ctx, app, { wallet, node }) => ({
        ok: true, wallet, utxos: await walletUtxos(app, { node, wallet, minconf: ctx.query?.minconf }),
      })),
    },
    {
      method: 'GET', path: '/api/admin/wallet/history', auth: 'admin',
      handler: walletRead(async (ctx, app, { wallet, node }) => ({
        ok: true, wallet, transactions: await walletHistory(app, { node, wallet, count: ctx.query?.count, skip: ctx.query?.skip }),
      })),
    },
    {
      method: 'GET', path: '/api/admin/wallet/tx', auth: 'admin',
      handler: walletRead(async (ctx, app, { wallet, node }) => ({
        ok: true, ...(await walletTransaction(app, { node, wallet, txid: ctx.query?.txid })),
      })),
    },
    {
      method: 'GET', path: '/api/admin/wallet/descriptors', auth: 'admin',
      // PUBLIC descriptors. `listdescriptors true` returns xprvs and is refused by the
      // allowlist's argument rule, so there is no path from this route to a private key.
      handler: walletRead(async (ctx, app, { wallet, node }) => ({ ok: true, ...(await walletDescriptors(app, { node, wallet })) })),
    },
    {
      method: 'GET', path: '/api/admin/wallet/labels', auth: 'admin',
      handler: walletRead(async (ctx, app, { wallet, node }) => ({ ok: true, wallet, labels: await walletLabels(app, { node, wallet }) })),
    },

    // ------------------------------------------------------------------------ receive
    // The first write in this suite. Elevated, because it changes the wallet; NOT
    // consuming, because a receive screen derives several addresses in a sitting and one
    // password per address would be a password typed without reading it.
    {
      method: 'POST', path: '/api/admin/wallet/address', auth: 'admin', csrf: true, body: true,
      handler: elevated(walletWrite(async (ctx, app, { wallet, node }) => {
        const out = await newAddress(app, { node, wallet, label: ctx.body?.label, type: ctx.body?.type ?? null });
        await app.audit({ type: 'admin-wallet-address', username: ctx.user?.username ?? null, wallet, address: out.address, label: out.label });
        return { ok: true, wallet, ...out };
      }), { what: 'deriving a new address' }),
    },
    {
      method: 'POST', path: '/api/admin/wallet/label', auth: 'admin', csrf: true, body: true,
      handler: elevated(walletWrite(async (ctx, app, { wallet, node }) => {
        const out = await labelAddress(app, { node, wallet, address: ctx.body?.address, label: ctx.body?.label });
        await app.audit({ type: 'admin-wallet-label', username: ctx.user?.username ?? null, wallet, address: out.address, label: out.label });
        return { ok: true, wallet, ...out };
      }), { what: 'labelling an address' }),
    },
    // --------------------------------------------------------------------------- send
    // Two steps, and the second acts on what the first built. See server/admin/send.js
    // for why that is not one step with a confirmation flag.
    //
    // BUILD is elevated but not consuming: it signs nothing, unlocks nothing and can move
    // nothing -- it asks the node what a transaction would look like. Gating it at all is
    // so that an attacker with a session cannot enumerate the wallet's coin selection.
    {
      method: 'POST', path: '/api/admin/wallet/send/build', auth: 'admin', csrf: true, body: true,
      handler: elevated(walletWrite(async (ctx, app, { wallet, node }) => {
        const summary = await buildSpend(app, ctx, {
          node, wallet,
          address: ctx.body?.address,
          amountSat: ctx.body?.amountSat,
          feeRate: ctx.body?.feeRate ?? null,
          subtractFee: ctx.body?.subtractFee === true,
          // Coin control (M5): the coins the operator picked, or none for the node's choice.
          inputs: ctx.body?.inputs ?? null,
        });
        await app.audit({
          type: 'admin-spend-built', username: ctx.user?.username ?? null,
          wallet, node, to: summary.to, sendingSat: summary.sendingSat, feeSat: summary.feeSat,
        });
        return { ok: true, build: summary };
      }), { what: 'building a transaction' }),
    },
    // CONFIRM consumes the elevation: one password, one spend.
    //
    // The build carries its own (node, wallet), checked again in confirmSpend; `node` and
    // `wallet` in the body are optional here and, when sent, must be the build's pair.
    {
      method: 'POST', path: '/api/admin/wallet/send/confirm', auth: 'admin', csrf: true, body: true,
      handler: async (ctx, app) => {
        try {
          requireWalletAccess(app, ctx.user);
          return await confirmSpend(app, ctx, {
            id: ctx.body?.id, phrase: ctx.body?.phrase, passphrase: ctx.body?.passphrase,
            node: ctx.body?.node ?? null, wallet: ctx.body?.wallet ?? null,
          });
        } catch (err) { refuseWith(err); }
      },
    },
    // CANCEL gives a build's coins back (a build locks them). Not elevated: it can only
    // un-spend, and asking for a password to change your mind is a tax on caution.
    {
      method: 'POST', path: '/api/admin/wallet/send/cancel', auth: 'admin', csrf: true, body: true,
      handler: async (ctx, app) => {
        try {
          requireWalletAccess(app, ctx.user);
          return await cancelBuild(app, ctx, { id: ctx.body?.id });
        } catch (err) { refuseWith(err); }
      },
    },
    {
      // The grant, like every other wallet read (review, 2026-09-19): the book is a list of
      // where this wallet's money goes, which is wallet information.
      method: 'GET', path: '/api/admin/addressbook', auth: 'admin',
      handler: async (ctx, app) => {
        try { requireWalletAccess(app, ctx.user); } catch (err) { refuseWith(err); }
        return { ok: true, ...addressBook(app) };
      },
    },
    {
      method: 'GET', path: '/api/admin/wallet/send/pending', auth: 'admin',
      handler: async (ctx, app) => {
        try { requireWalletAccess(app, ctx.user); } catch (err) { refuseWith(err); }
        return { ok: true, builds: pendingFor(ctx) };
      },
    },
    // ------------------------------------------------------------------ the daemon
    // No wallet grant here: stopping a node is an administrator's business, not a
    // spender's, and the two are separate questions throughout this suite.
    {
      method: 'GET', path: '/api/admin/node/actions', auth: 'admin',
      handler: async (ctx, app) => {
        try { return { ok: true, ...daemonActions(app, ctx.query?.node ?? [...app.monitors.keys()][0]) }; }
        catch (err) { refuseWith(err); }
      },
    },
    {
      method: 'POST', path: '/api/admin/node/stop', auth: 'admin', csrf: true, body: true,
      // Consuming: one password, one stop. Stopping a node twice by accident is a
      // different kind of expensive from spending twice, but it is still expensive.
      handler: elevated(async (ctx, app) => {
        try {
          return await daemonStop(app, ctx, {
            node: ctx.body?.node ?? [...app.monitors.keys()][0],
            restart: ctx.body?.restart === true,
            confirm: ctx.body?.confirm,
          });
        } catch (err) { refuseWith(err); }
      }, { consume: true, what: 'stopping the node' }),
    },
    // ---------------------------------------------------------------- the configs
    // Two files, two dangers: bitcoin.conf can lock the operator out of their node, and
    // BlockYard's own config holds the block that restrains this suite -- which is why
    // that block is not writable from here at all (server/admin/config-edit.js). Since
    // 2026-09-19 both editors are refusal-first: RPC credentials, binding and file paths
    // in bitcoin.conf, and everything but display and polling in BlockYard's own file,
    // are refused by name. Reading the node conf is not elevated: every credential value
    // is masked before it leaves the server, and what remains is what the admin role
    // already sees on the Node tab.
    {
      method: 'GET', path: '/api/admin/config/node', auth: 'admin',
      handler: async (ctx, app) => {
        try { return { ok: true, ...(await readNodeConf(app, ctx.query?.node ?? [...app.monitors.keys()][0])) }; }
        catch (err) { refuseWith(err); }
      },
    },
    {
      method: 'POST', path: '/api/admin/config/node', auth: 'admin', csrf: true, body: true,
      handler: elevated(async (ctx, app) => {
        try {
          return await writeNodeConf(app, ctx, ctx.body?.node ?? [...app.monitors.keys()][0], {
            changes: ctx.body?.changes ?? [],
            acknowledge: ctx.body?.acknowledge ?? [],
          });
        } catch (err) { refuseWith(err); }
      }, { what: 'editing the node configuration' }),
    },
    {
      method: 'GET', path: '/api/admin/config/self', auth: 'admin',
      handler: async (ctx, app) => {
        try { return { ok: true, ...readOwnConfig(app) }; } catch (err) { refuseWith(err); }
      },
    },
    {
      method: 'POST', path: '/api/admin/config/self', auth: 'admin', csrf: true, body: true,
      handler: elevated(async (ctx, app) => {
        try { return await writeOwnConfig(app, ctx, { patch: ctx.body?.patch }); }
        catch (err) { refuseWith(err); }
      }, { what: 'editing this monitor\'s configuration' }),
    },
    // -------------------------------------------------------- transaction tools (M5)
    // Decoding changes nothing and reaches no key, so it needs the grant and no
    // elevation: it is the tool for finding out what you are holding.
    {
      method: 'POST', path: '/api/admin/tx/decode', auth: 'admin', csrf: true, body: true,
      handler: walletWrite(async (ctx, app, { wallet, node }) => ({
        ok: true, ...(await decodeAny(app, { node, wallet, raw: ctx.body?.raw })),
      })),
    },
    // Broadcast IS elevated, and consumes: see server/admin/txtools.js for the case where
    // a pasted transaction turns out to be a send of this wallet's own coins.
    {
      method: 'POST', path: '/api/admin/tx/broadcast', auth: 'admin', csrf: true, body: true,
      handler: elevated(walletWrite(async (ctx, app, { wallet, node }) => broadcastRaw(app, ctx, {
        node, wallet, raw: ctx.body?.raw, acceptSpendingOurs: ctx.body?.acceptSpendingOurs === true,
        phrase: ctx.body?.phrase ?? null, passphrase: ctx.body?.passphrase ?? null,
        passphrases: ctx.body?.passphrases ?? null,
      })), { consume: true, what: 'broadcasting a transaction' }),
    },
    {
      method: 'POST', path: '/api/admin/tx/bump', auth: 'admin', csrf: true, body: true,
      handler: elevated(walletWrite(async (ctx, app, { wallet, node }) => previewBump(app, ctx, {
        node, wallet, txid: ctx.body?.txid, feeRate: ctx.body?.feeRate ?? null,
      })), { what: 'pricing a fee bump' }),
    },
    {
      method: 'POST', path: '/api/admin/tx/bump/confirm', auth: 'admin', csrf: true, body: true,
      handler: elevated(walletWrite(async (ctx, app, { wallet, node }) => confirmBump(app, ctx, {
        node, wallet, txid: ctx.body?.txid, feeRate: ctx.body?.feeRate ?? null, passphrase: ctx.body?.passphrase,
      })), { consume: true, what: 'sending a fee bump' }),
    },
  ];
}