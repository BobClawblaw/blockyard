// THE WALLET, READ-ONLY (docs/PLAN-ADMIN-SUITE.md, M2).
//
// Balances, UTXOs, history, labels. Nothing here changes anything: every call goes through
// the `wallet.read` capability of server/rpc/admin-allowlist.js, which contains no method
// that writes, derives or unlocks. M3 adds receive and M4 adds send, each in its own file
// and its own capability, so "what can this screen do" stays answerable by reading one
// import line.
//
// PER-WALLET OPT-IN is enforced here rather than trusted to the node (plan §2.5). The node
// will happily list and load every wallet it has; `admin.wallets` is the operator's list
// of the ones this web interface may touch, and a name not on it is refused before any RPC
// is made -- not filtered out of the answer afterwards, which would still have asked.
import { adminCallAllowed } from '../rpc/admin-allowlist.js';

/** The suite's refusal shape; the route layer turns it into a 403. */
function deny(message, code = 'admin-refused') {
  const err = new Error(message);
  err.status = 403;
  err.code = code;
  throw err;
}

/** The wallets this monitor may touch, in the operator's own order. */
export function namedWallets(app) {
  return [...(app.cfg.admin?.wallets ?? [])];
}

/**
 * Check a wallet name against the opt-in list and return it, or refuse.
 *
 * The comparison is exact. No prefix matching, no normalisation, no "close enough": a
 * wallet name is a path component on the node, and a suite that guesses which wallet you
 * meant is a suite that eventually guesses wrong about which wallet it is spending from.
 */
export function requireNamedWallet(app, name) {
  const wallets = namedWallets(app);
  if (!wallets.length) {
    deny('no wallet is named in admin.wallets, so no wallet is reachable from the web interface', 'no-wallets');
  }
  if (typeof name !== 'string' || !name.length) deny('name the wallet', 'wallet-required');
  if (!wallets.includes(name)) {
    deny(`"${name}" is not in admin.wallets (${wallets.join(', ')}), so this interface will not touch it`, 'wallet-not-named');
  }
  return name;
}

/** The person must hold the grant, whatever their role (plan §2.4). */
export function requireWalletAccess(app, user) {
  const rec = user?.username ? app.users?.find?.(user.username) : null;
  if (!rec?.walletAccess) {
    deny('your account does not have wallet access; an administrator grants it per account, and being an administrator is not enough on its own', 'wallet-access-required');
  }
  return true;
}

/**
 * One RPC call, checked against the capability list, addressed to one wallet.
 *
 * Bitcoin Core addresses a wallet by URL path (`/wallet/<name>`), which is why this takes
 * the name rather than letting a caller pass it in the arguments -- there is exactly one
 * place that decides which wallet a call lands on, and it is this function.
 */
export async function walletCall(app, { node, wallet, capability, method, args = [] }) {
  const verdict = adminCallAllowed(capability, method, args);
  if (!verdict.ok) deny(verdict.why, 'method-not-allowed');
  const m = app.monitors.get(node);
  if (!m) deny(`no such node: ${node}`, 'no-such-node');
  // The wallet is addressed by URL path, per call, through the shared client -- see the
  // `walletPath` note in server/rpc/client.js. Encoded, because a wallet name is a path
  // component and Core allows names this monitor must not paste raw into a URL.
  const walletPath = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '';
  return m.rpc.call(method, args, { walletPath });
}

/** Sats from a BTC figure, without float drift: Core speaks BTC, this suite counts sats. */
export function toSats(btc) {
  if (btc == null) return null;
  // The string form is exact where the number is not: 0.1 + 0.2 is the reason this is not
  // Math.round(btc * 1e8) on a value that has already been through a float.
  const [whole, frac = ''] = String(btc).replace(/^\+/, '').split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  const w = BigInt(whole.replace('-', '') || '0');
  const f = BigInt((frac + '00000000').slice(0, 8));
  return Number(sign * (w * 100_000_000n + f));
}

/**
 * The wallet overview: what it is, what it holds, and what it can answer.
 *
 * Deliberately one call per figure rather than one screen-shaped RPC: each is in the
 * capability list by name, and a future screen that wants more has to add its method
 * there rather than widening an existing call.
 */
export async function walletOverview(app, { node, wallet }) {
  const info = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getwalletinfo' });
  const balances = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getbalances' });
  const mine = balances?.mine ?? {};
  return {
    wallet,
    node,
    // `private_keys_enabled: false` is a watch-only wallet: it can never spend whatever
    // the rest of this suite allows, and the UI says so rather than offering a Send
    // button that would fail at the last step.
    canSpend: info?.private_keys_enabled !== false,
    // An encrypted wallet has an unlock step; an unencrypted one does not, and that is a
    // fact worth showing rather than discovering at the confirm screen.
    encrypted: info?.unlocked_until !== undefined,
    unlockedUntil: info?.unlocked_until ?? null,
    descriptors: info?.descriptors ?? null,
    blocks: info?.lastprocessedblock?.height ?? null,
    balances: {
      trustedSat: toSats(mine.trusted ?? 0),
      untrustedPendingSat: toSats(mine.untrusted_pending ?? 0),
      immatureSat: toSats(mine.immature ?? 0),
      totalSat: toSats(mine.trusted ?? 0) + toSats(mine.untrusted_pending ?? 0) + toSats(mine.immature ?? 0),
    },
    // Scanning means every number above is provisional, and a page that does not say so
    // invites someone to conclude their coins are gone.
    scanning: info?.scanning && info.scanning !== false ? info.scanning : null,
  };
}

/** Spendable outputs, newest first, with what a coin-control screen needs. */
export async function walletUtxos(app, { node, wallet, minconf = 0 }) {
  const rows = await walletCall(app, {
    node, wallet, capability: 'wallet.read', method: 'listunspent', args: [Number(minconf) || 0],
  });
  return (rows ?? []).map((u) => ({
    txid: u.txid,
    vout: u.vout,
    address: u.address ?? null,
    label: u.label ?? null,
    amountSat: toSats(u.amount),
    confirmations: u.confirmations ?? 0,
    spendable: Boolean(u.spendable),
    solvable: Boolean(u.solvable),
    // Core marks what it cannot sign for; a UTXO that is not `safe` must not be silently
    // included in a coin-control default selection.
    safe: u.safe !== false,
  })).sort((a, b) => a.confirmations - b.confirmations);
}

/** Recent history, mapped to the fields a list needs and nothing more. */
export async function walletHistory(app, { node, wallet, count = 50, skip = 0 }) {
  const rows = await walletCall(app, {
    node, wallet, capability: 'wallet.read', method: 'listtransactions',
    args: ['*', Math.min(Number(count) || 50, 200), Number(skip) || 0],
  });
  return (rows ?? []).map((t) => ({
    txid: t.txid,
    category: t.category,
    address: t.address ?? null,
    label: t.label ?? null,
    amountSat: toSats(t.amount),
    feeSat: t.fee == null ? null : toSats(t.fee),
    confirmations: t.confirmations ?? 0,
    time: (t.time ?? 0) * 1000,
    // A replaceable transaction that is still unconfirmed is the one a fee-bump screen
    // acts on, so the flag travels with the row rather than being fetched again.
    bip125Replaceable: t['bip125-replaceable'] ?? 'unknown',
    abandoned: Boolean(t.abandoned),
  })).reverse();
}

/**
 * Descriptors, PUBLIC ONLY.
 *
 * `listdescriptors true` returns xprvs. The argument is not passed here and the allowlist
 * refuses it if it ever were, so there is no path through this suite that reaches a
 * private descriptor -- see server/rpc/admin-allowlist.js.
 */
export async function walletDescriptors(app, { node, wallet }) {
  const out = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'listdescriptors' });
  return {
    wallet: out?.wallet_name ?? wallet,
    descriptors: (out?.descriptors ?? []).map((d) => ({
      desc: d.desc, active: Boolean(d.active), internal: Boolean(d.internal),
      range: d.range ?? null, next: d.next ?? null, timestamp: d.timestamp ?? null,
    })),
  };
}

/** Labels, and the addresses under each. */
export async function walletLabels(app, { node, wallet }) {
  const labels = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'listlabels' });
  const out = [];
  for (const label of labels ?? []) {
    const addresses = await walletCall(app, {
      node, wallet, capability: 'wallet.read', method: 'getaddressesbylabel', args: [label],
    });
    out.push({ label, addresses: Object.keys(addresses ?? {}) });
  }
  return out;
}
