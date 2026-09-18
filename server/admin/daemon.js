// DAEMON CONTROL (docs/PLAN-ADMIN-SUITE.md §6).
//
// The node's own `stop` RPC, and then the supervisor's job to start it again. That is the
// whole mechanism, and the reason for it is what is NOT here: no sudo, no shell, no
// privileged helper, no systemd socket. A bug anywhere in this web application reaches the
// node's RPC, which it already could, rather than the machine.
//
// THE HONEST PART. BlockYard cannot promise the node comes back. It does not start it, it
// does not supervise it, and it cannot see the unit file. What it can do is know what the
// operator TOLD it (`supervisor` on the node's config), refuse to call something a restart
// when nothing is configured to restart it, and then watch and report what actually
// happened. A button labelled Restart that performs a shutdown would be the worst thing in
// this suite.
import { walletCall } from './wallet.js';

function deny(message, code = 'admin-refused', status = 400) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  throw err;
}

/** What the operator declared about who restarts this node. */
export function supervisorOf(app, nodeId) {
  const m = app.monitors.get(nodeId);
  if (!m) deny(`no such node: ${nodeId}`, 'no-such-node', 404);
  const raw = m.cfg?.supervisor ?? 'none';
  const [kind, unit = null] = String(raw).split(':');
  return { raw, kind: kind || 'none', unit, restarts: kind === 'systemd' || kind === 'docker' || kind === 'supervisor' };
}

/**
 * What the button may say, and why.
 *
 * Deliberately returns the LABEL as well as the permission: the caller does not get to
 * decide what to call this, because getting that wrong is the failure mode.
 */
export function daemonActions(app, nodeId) {
  const sup = supervisorOf(app, nodeId);
  return {
    node: nodeId,
    supervisor: sup.raw,
    stop: {
      allowed: true,
      label: 'Shut down',
      note: sup.restarts
        ? `the node stops; ${sup.raw} starts it again shortly afterwards`
        : 'the node stops and STAYS stopped: nothing is configured to start it again',
    },
    restart: {
      allowed: sup.restarts,
      label: 'Restart',
      note: sup.restarts
        ? `stop over RPC, then wait for ${sup.raw} to bring it back`
        : 'no supervisor is configured for this node (set `supervisor` on it, e.g. "systemd:bitcoind"), '
          + 'so this monitor cannot restart it -- stopping it would simply stop it',
    },
  };
}

/** Is the node answering? Used to watch it go and to watch it return. */
async function alive(app, nodeId) {
  try {
    await walletCall(app, { node: nodeId, wallet: null, capability: 'node.control', method: 'uptime', args: [] });
    return true;
  } catch { return false; }
}

async function heightOf(app, nodeId) {
  try {
    return await walletCall(app, { node: nodeId, wallet: null, capability: 'node.control', method: 'getblockcount', args: [] });
  } catch { return null; }
}

/** Wait for a condition, or give up. Returns the ms it took, or null. */
async function waitFor(fn, { timeoutMs, stepMs = 500 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return Date.now() - started;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return null;
}

/**
 * Stop the node, and — when a supervisor is configured and `restart` was asked for — wait
 * for it to come back.
 *
 * `confirm` must be the node's own id, typed. Not a checkbox: the point is to make the
 * operator name the thing they are stopping, on a screen that may show several nodes.
 */
export async function daemonStop(app, ctx, { node, restart = false, confirm = null, waitMs = 120_000 }) {
  const actions = daemonActions(app, node);
  if (String(confirm ?? '') !== node) {
    deny(`type the node's id (${node}) to confirm`, 'confirm-required');
  }
  if (restart && !actions.restart.allowed) {
    deny(actions.restart.note, 'no-supervisor', 409);
  }

  const before = await heightOf(app, node);
  // The point of no return. Everything above this line can be got wrong and retried
  // without a new password; nothing below it can be undone at all.
  ctx.consumeElevation?.();
  await walletCall(app, { node, wallet: null, capability: 'node.control', method: 'stop', args: [] });
  await app.audit({
    type: restart ? 'admin-node-restart' : 'admin-node-stop',
    username: ctx.user?.username ?? null, node, heightBefore: before,
  });

  // Watch it actually go. A `stop` that returned but left the node running would otherwise
  // be reported as a successful restart.
  const wentDownMs = await waitFor(async () => !(await alive(app, node)), { timeoutMs: 30_000 });
  if (wentDownMs == null) {
    return {
      ok: false, node, action: restart ? 'restart' : 'stop', heightBefore: before,
      state: 'still-answering',
      message: 'the node accepted the stop but is still answering RPC 30 s later; it may be finishing a flush',
    };
  }
  if (!restart) {
    return {
      ok: true, node, action: 'stop', heightBefore: before, downInMs: wentDownMs,
      state: 'stopped',
      message: actions.stop.note,
    };
  }

  const backMs = await waitFor(() => alive(app, node), { timeoutMs: waitMs, stepMs: 1000 });
  if (backMs == null) {
    // Said plainly, because this is the case an operator has to act on, and a suite that
    // says "restarted" here would have lied about the one thing that mattered.
    return {
      ok: false, node, action: 'restart', heightBefore: before, downInMs: wentDownMs,
      state: 'did-not-return',
      message: `the node stopped and has NOT come back within ${Math.round(waitMs / 1000)}s. `
        + `${actions.supervisor} was expected to start it; check that supervisor on the host.`,
    };
  }
  const after = await heightOf(app, node);
  return {
    ok: true, node, action: 'restart', heightBefore: before, heightAfter: after,
    downInMs: wentDownMs, backInMs: backMs,
    state: 'back',
    message: `back at height ${after ?? '?'} in ${(backMs / 1000).toFixed(1)}s`,
  };
}
