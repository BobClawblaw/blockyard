// BITCOIN CORE'S WALLET LAYOUT, AS THIS SUITE USES IT.
//
// Operator, 2026-09-18: "Look at how Core does wallet handling in their GUI and rip off
// their UI." So this file is the part that was read off Core rather than invented: the
// four screens, the words on them, the columns, and the shape of the confirmation.
//
// WHERE IT COMES FROM AND WHAT THAT MEANS. Bitcoin Core is MIT-licensed, and what is
// copied here is its INTERFACE -- the information architecture, the field names, the
// status wording -- not its code. None of Core's C++ is in this repository. The value of
// copying it is not saving work: it is that anyone who has run Bitcoin Core already knows
// where everything is, and a wallet screen is a bad place to be inventive. Where Core's
// wording is quoted, it is quoted exactly, because a near-miss paraphrase is worse than
// either copying or not.
//
// Read from src/qt of the v31.1 source on this machine:
//   forms/overviewpage.ui        Available / Pending / Immature / Total, "Recent transactions"
//   forms/sendcoinsdialog.ui     Coin Control, Quantity/Bytes/Amount/Fee/After Fee/Change,
//                                "Transaction Fee", Recommended/Custom
//   forms/sendcoinsentry.ui      "Pay To", "Label", "Amount", "Subtract fee from amount"
//   forms/receivecoinsdialog.ui  Amount / Label / Message, "Create new receiving address"
//   forms/coincontroldialog.ui   "Coin Selection", the same six totals
//   sendcoinsdialog.cpp          the confirmation: "Please, review your transaction.",
//                                "Transaction fee", "You can increase the fee later.",
//                                "Total Amount"
//   transactiontablemodel.cpp    columns: Date, Type, Label, Amount; and the status strings
//
// WHAT IS DELIBERATELY NOT COPIED: Core's send screen offers several recipients per
// transaction and a custom change address. Neither is here yet, and pretending otherwise
// with dead controls would be worse than their absence.

/** Core's four wallet screens, in Core's order. */
export const SCREENS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'send', label: 'Send' },
  { id: 'receive', label: 'Receive' },
  { id: 'transactions', label: 'Transactions' },
]);

/** The balance rows of overviewpage.ui, with Core's own tooltips. */
export const BALANCES = Object.freeze([
  { key: 'trustedSat', label: 'Available:', hint: 'Your current spendable balance' },
  { key: 'untrustedPendingSat', label: 'Pending:', hint: 'Total of transactions that have yet to be confirmed, and do not yet count toward the spendable balance' },
  { key: 'immatureSat', label: 'Immature:', hint: 'Mined balance that has not yet matured' },
  { key: 'totalSat', label: 'Total:', hint: 'Your current total balance', strong: true },
]);

/** transactiontablemodel.cpp's columns. The first is the status column, which has no title. */
export const TX_COLUMNS = Object.freeze(['', 'Date', 'Type', 'Label', 'Amount']);

/** The six figures Core puts under Coin Control, in its order. */
export const COIN_CONTROL_TOTALS = Object.freeze(['Quantity:', 'Bytes:', 'Amount:', 'Fee:', 'After Fee:', 'Change:']);

/**
 * Core's transaction type names (TransactionRecord), from the wallet's own category plus
 * whether the destination was ours.
 *
 * Core distinguishes "with address" from "from other" -- a payment to an address the
 * wallet can name, versus one it can only see. The distinction survives here because it is
 * the difference between a row you can act on and a row you can only read.
 */
export function txType(row) {
  if (row.category === 'generate' || row.category === 'immature' || row.category === 'orphan') return 'Mined';
  if (row.category === 'send') return row.address ? 'Sent to' : 'Payment to yourself';
  if (row.category === 'receive') return row.address ? 'Received with' : 'Received from';
  return row.category ?? '';
}

/**
 * Core's status wording, verbatim where it has one.
 *
 * `Confirming (%1 of %2 recommended confirmations)` counts to six, which is Core's
 * recommendation rather than a rule; saying so keeps the number from reading as consensus.
 */
export function txStatus(row, { recommended = 6 } = {}) {
  const conf = row.confirmations ?? 0;
  if (row.abandoned) return { text: 'Abandoned', tone: 'warn' };
  if (conf < 0) return { text: 'Conflicted', tone: 'warn' };
  if (row.category === 'immature') {
    return { text: `Immature (${conf} confirmations, will be available after 100)`, tone: 'sub' };
  }
  if (conf === 0) return { text: 'Unconfirmed', tone: 'warn' };
  if (conf < recommended) return { text: `Confirming (${conf} of ${recommended} recommended confirmations)`, tone: 'sub' };
  return { text: `Confirmed (${conf} confirmations)`, tone: 'ok' };
}

/** The little status glyph in Core's first column, in text this page can draw. */
export function txGlyph(row, { recommended = 6 } = {}) {
  const conf = row.confirmations ?? 0;
  if (row.abandoned || conf < 0) return '✕';
  if (row.category === 'immature') return '◷';
  if (conf === 0) return '◔';
  if (conf < recommended) return '◕';
  return '✓';
}

/**
 * The confirmation Core shows before it sends, in Core's own words.
 *
 * "You can increase the fee later" is only true of a replaceable transaction, and this
 * suite builds them replaceable -- so the sentence is kept, conditioned on the flag rather
 * than assumed, because a promise about a fee bump that cannot happen is worse than
 * silence.
 */
export function confirmationLines(build, { fmt }) {
  const lines = [{ kind: 'lead', text: 'Please, review your transaction.' }];
  lines.push({ kind: 'recipient', label: 'Pay To', value: build.to });
  lines.push({ kind: 'row', label: 'Amount', value: fmt(build.sendingSat) });
  if (build.feeSat > 0) {
    lines.push({
      kind: 'fee',
      label: 'Transaction fee',
      // Core prints the size in kvB beside the fee, for context.
      note: build.vsize ? `${(build.vsize / 1000).toFixed(3)} kvB` : null,
      value: fmt(build.feeSat),
    });
  }
  if (build.replaceable) lines.push({ kind: 'note', text: 'You can increase the fee later.' });
  lines.push({ kind: 'total', label: 'Total Amount', value: fmt(build.totalSat) });
  return lines;
}
