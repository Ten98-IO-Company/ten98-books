import { assertMoneyInRange, formatMoney, type MoneyExponent } from '@ten98/runtime/browser';
import { voucherCreateInput, type Side, type VoucherCreateInput } from '../ledger.ts';
import { billRowBody, billRowProblem, type BillDraft } from './bills.ts';
import { accountSide, isBlankLine, isCompleteLine, lineTotals, particularsSide, particularsTotal, type EntryDraft } from './layout.ts';

/** The create request and what the accept path checks before sending it (docs/VOUCHERS.md, "Saving"). */

export type BodyInput = EntryDraft & {
  idempotencyKey: string; voucherTypeId: string; date: string; narration: string;
  bills: Readonly<Record<string, readonly BillDraft[]>>;
};

/** The complete lines in body order with their sides; single entry adds the Account line, for the total, last. */
export function bodyLines(draft: EntryDraft, exponent: MoneyExponent): { key: string | null; side: Side; ledger: string; amount: string }[] {
  if (draft.layout === 'double') return draft.lines.filter(isCompleteLine).map(line => ({ key: line.key, side: line.side as Side, ledger: line.ledger, amount: line.amount }));
  const particulars = draft.lines.filter(line => line.ledger !== '' && line.amount !== '')
    .map(line => ({ key: line.key as string | null, side: particularsSide(draft.kind), ledger: line.ledger, amount: line.amount }));
  const total = particularsTotal(draft.lines, exponent);
  return draft.account === '' || total === 0n ? particulars
    : [...particulars, { key: null, side: accountSide(draft.kind), ledger: draft.account, amount: formatMoney(total, exponent) }];
}

/**
 * The create request for the draft (observed order): single entry sends the particulars, then the Account with the
 * total on the other side; double entry sends its complete lines in order. Each line carries its bill rows; the
 * narration is null when empty; a new voucher is regular and not post-dated (slice 3 adds the rest). Send it only when
 * `bodyProblems` finds nothing.
 */
export function toVoucherBody(input: BodyInput, exponent: MoneyExponent): VoucherCreateInput {
  const narration = input.narration.trim();
  return {
    idempotencyKey: input.idempotencyKey, voucherTypeId: input.voucherTypeId, date: input.date,
    narration: narration === '' ? null : narration, status: 'regular', postDated: false, reference: null, referenceDate: null,
    lines: bodyLines(input, exponent).map(line => {
      const bills = (line.key === null ? [] : input.bills[line.key] ?? []).map(row => billRowBody(row, line.side, input.date)).filter(row => row !== null);
      return { ledgerId: line.ledger, side: line.side, amount: line.amount, ...bills.length ? { bills } : {} };
    }),
  };
}

/** A problem the accept path refuses on, with the line it is about (its key) when there is one. */
export type BodyProblem = { message: string; line?: string; column?: 'side' | 'ledger' | 'amount' };

/**
 * Everything the screen refuses before sending, so nothing typed is silently left out: a line with something in it but
 * no ledger, amount or (in double entry) side; a bill row that names no bill, has no method or amount, or a credit
 * period that does not parse; totals beyond the stored range; and the server's own body limits (its schema: at most 500
 * lines, the narration's length), checked on the body as it would be sent.
 */
export function bodyProblems(input: BodyInput, exponent: MoneyExponent): BodyProblem[] {
  const problems: BodyProblem[] = [];
  input.lines.forEach((line, index) => {
    if (isBlankLine(line)) return;
    const column = line.ledger === '' ? 'ledger' : line.amount === '' ? 'amount' : input.layout === 'double' && line.side === '' ? 'side' : null;
    if (column) problems.push({ message: `Line ${index + 1} has no ${column === 'side' ? 'side (Dr or Cr)' : column}: complete it or empty it.`, line: line.key, column });
    (input.bills[line.key] ?? []).forEach((row, rowIndex) => {
      const problem = billRowProblem(row, rowIndex, input.date);
      if (problem) problems.push({ message: `Line ${index + 1}, ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`, line: line.key, column: 'amount' });
    });
  });
  const { debit, credit } = lineTotals(input.lines, exponent);
  const totals = input.layout === 'single' ? [particularsTotal(input.lines, exponent)] : [debit, credit];
  try { for (const total of totals) assertMoneyInRange(total); } catch { problems.push({ message: 'The total is too large to be stored.' }); }
  if (problems.length) return problems;
  const checked = voucherCreateInput.safeParse(toVoucherBody(input, exponent));
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const label = issue.path[0] === 'lines' ? 'The lines' : issue.path[0] === 'narration' ? 'The narration' : 'The voucher';
    problems.push({ message: `${label}: ${issue.message}` });
  }
  return problems;
}
