// RECEIVE (docs/PLAN-ADMIN-SUITE.md, M3): the first write, and the smallest one.
//
// `getnewaddress` derives and PERSISTS a key in the wallet -- which is why it sits in the
// deny list of the read-only console's allowlist despite starting with "get", and why it
// has its own capability here rather than living beside the reads.
//
// WHAT THIS CAN AND CANNOT COST YOU. It cannot move money: an address belongs to the
// wallet that derived it, so an attacker who could call this all night would get a pile of
// addresses that pay the operator. What it can do is churn the keypool and add noise to the
// wallet's label space. That is why it is gated but not consuming: an elevation covers a
// receive screen's session rather than one address at a time.
//
// One thing worth being honest about, since it shapes how much the gate is worth: the
// read capability already returns the wallet's PUBLIC descriptors, and an xpub reveals
// every address the wallet will ever derive. So the elevation here is about the write, not
// about keeping addresses secret -- anyone who can read this wallet can already enumerate
// it. If that is not what the operator wants, the fix is not to gate this route harder,
// it is to not grant wallet access.
import { walletCall } from './wallet.js';

/** Address types Core will derive, and the only ones this suite asks for. */
export const ADDRESS_TYPES = Object.freeze(['bech32m', 'bech32', 'p2sh-segwit', 'legacy']);

function deny(message, code = 'admin-refused') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  throw err;
}

/**
 * A label the node will take and a person can read back.
 *
 * Core accepts almost anything, including control characters and a very long string, and
 * the label comes back out into a browser and into the audit trail. Trimmed, capped, and
 * stripped of the characters that have no business in a label -- a rejection with a reason
 * rather than a silent transformation, so nobody wonders where their text went.
 */
export function checkLabel(raw) {
  const label = String(raw ?? '');
  if (label.length > 255) deny('a label may be at most 255 characters', 'label-too-long');
  // Checked by code point rather than by a character class: a literal control
  // character in this file would be invisible here and forbidden by
  // test/parse-all.test.js, which is how the first draft of this line was caught.
  for (const ch of label) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) deny('a label may not contain control characters', 'label-invalid');
  }
  return label.trim();
}

/** Derive a fresh address, optionally labelled. */
export async function newAddress(app, { node, wallet, label = '', type = null }) {
  const clean = checkLabel(label);
  if (type != null && !ADDRESS_TYPES.includes(type)) {
    deny(`address type must be one of ${ADDRESS_TYPES.join(', ')}`, 'address-type');
  }
  // Core's signature is (label, address_type). Passing the label here rather than calling
  // setlabel afterwards means there is no window in which a fresh address exists unlabelled
  // -- which matters when the label is the only record of what an address was for.
  const args = type ? [clean, type] : [clean];
  const address = await walletCall(app, { node, wallet, capability: 'wallet.receive', method: 'getnewaddress', args });
  return { address, label: clean, type: type ?? 'default' };
}

/** Label an address that already exists (rename a receive slot, tag an incoming payment). */
export async function labelAddress(app, { node, wallet, address, label }) {
  const clean = checkLabel(label);
  if (typeof address !== 'string' || !/^[a-zA-Z0-9]{8,120}$/.test(address)) {
    deny('that does not look like an address', 'address-invalid');
  }
  // Ask the node whether the address is ours BEFORE labelling it. setlabel on a foreign
  // address is an error from Core, but the reason this check is here rather than left to
  // the node is the message: "that address is not in this wallet" is a sentence someone
  // can act on, where Core's own error is about key origins.
  const info = await walletCall(app, { node, wallet, capability: 'wallet.read', method: 'getaddressinfo', args: [address] });
  if (!info?.ismine) deny('that address is not in this wallet, so this wallet cannot label it', 'address-not-mine');
  await walletCall(app, { node, wallet, capability: 'wallet.receive', method: 'setlabel', args: [address, clean] });
  return { address, label: clean };
}
