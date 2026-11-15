import { addMoney, compareMoney, formatMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime/browser';
import { creditPeriod as creditPeriodSchema, type BillKind, type BillRowInput, type CreditPeriod, type Side, type VoucherKind } from '../ledger.ts';
import { longDate } from '../reports.ts';
import { minorOf, parseEntryDate } from './amounts.ts';
import { isBlankLine, type EntryLine } from './layout.ts';

/** Detail steps and the bill panel's rows (docs/VOUCHERS.md, "Bills"). */

export type DetailStep = 'bills';
/**
 * The detail steps a line opens after its amount, in order: bills for a bill-wise ledger now; cost centres and bank
 * details plug into the same list later. Nothing for a line without a ledger or an amount.
 */
export function detailSteps(line: Pick<EntryLine, 'ledger' | 'amount'>, ledger: { billWise: boolean } | undefined): DetailStep[] {
  if (isBlankLine(line) || line.ledger === '' || line.amount === '' || !ledger) return [];
  return ledger.billWise ? ['bills'] : [];
}

export const billKindTitles: Record<BillKind, string> = { against_ref: 'Against a bill', new_ref: 'New bill', advance: 'Advance', on_account: 'On account' };
export const billKindOrder: readonly BillKind[] = ['against_ref', 'new_ref', 'advance', 'on_account'];
/** A method read back from a grid cell's text, or '' for anything else. */
export const billKindOf = (value: string | undefined): BillKind | '' => billKindOrder.find(kind => kind === value) ?? '';

/** A pending bill the picker offers, as the picker read answers it (signed: positive on the debit side). */
export type PendingChoice = { billId: string; name: string; billDate: string | null; dueDate: string | null; pending: bigint; finalPending: bigint };
/** One row of the bill panel as the screen holds it. `bill` is a pending bill's id (against), `name` a new bill's name. */
export type BillDraft = { key: string; method: BillKind | ''; bill: string; name: string; credit: string; amount: string; side: Side | '' };

/** Pending bills on the side a line settles: the other side of the line. */
export const settleable = (pending: readonly PendingChoice[], lineSide: Side): PendingChoice[] =>
  pending.filter(bill => lineSide === 'Cr' ? bill.pending > 0n : bill.pending < 0n);

/**
 * The method a new row starts with (observed): a new bill on sales and purchase; on every other type against a bill
 * while the party has pending bills on the other side that the rows have not used up, else on account.
 */
export function defaultBillMethod(kind: VoucherKind, open: readonly PendingChoice[]): BillKind {
  if (kind === 'sales' || kind === 'purchase') return 'new_ref';
  return open.length ? 'against_ref' : 'on_account';
}

/** What the rows have taken so far, net on the line's side (a row on the other side gives back). */
export function allocated(rows: readonly BillDraft[], lineSide: Side, exponent: MoneyExponent): bigint {
  return rows.reduce((sum, row) => {
    if (row.amount === '') return sum;
    const amount = minorOf(row.amount, exponent);
    return (row.side || lineSide) === lineSide ? addMoney(sum, amount) : subtractMoney(sum, amount);
  }, 0n);
}

/** Pending bills not yet fully taken by the rows: what the next row can still settle against. */
export function openBills(pending: readonly PendingChoice[], rows: readonly BillDraft[], lineSide: Side, exponent: MoneyExponent): PendingChoice[] {
  return settleable(pending, lineSide).filter(bill => {
    const left = rows.filter(row => row.method === 'against_ref' && row.bill === bill.billId)
      .reduce((sum, row) => subtractMoney(sum, minorOf(row.amount, exponent)), bill.pending < 0n ? -bill.pending : bill.pending);
    return left > 0n;
  });
}

/** A new row for what is left of the line: its method by `defaultBillMethod`, the remainder as its amount, the line's side. */
export function nextBillRow(input: { kind: VoucherKind; lineSide: Side; lineAmount: bigint; rows: readonly BillDraft[]; pending: readonly PendingChoice[]; exponent: MoneyExponent; key: string; name?: string }): BillDraft {
  const left = subtractMoney(input.lineAmount, allocated(input.rows, input.lineSide, input.exponent));
  const method = defaultBillMethod(input.kind, openBills(input.pending, input.rows, input.lineSide, input.exponent));
  return { key: input.key, method, bill: '', name: method === 'new_ref' ? input.name ?? '' : '', credit: '', amount: left > 0n ? formatMoney(left, input.exponent) : '', side: input.lineSide };
}

/** The amount a picked pending bill proposes: the lesser of what is left of the line and the bill's pending (observed). */
export function againstAmount(bill: PendingChoice, unallocated: bigint, exponent: MoneyExponent): string {
  const pending = bill.pending < 0n ? -bill.pending : bill.pending;
  const amount = compareMoney(unallocated, pending) <= 0 ? unallocated : pending;
  return amount > 0n ? formatMoney(amount, exponent) : '';
}

/** Why the rows cannot stand for the line: they add up to more than it, or to its other side; '' when they can. */
export function allocationProblem(rows: readonly BillDraft[], lineSide: Side, lineAmount: bigint, exponent: MoneyExponent): string {
  const taken = allocated(rows, lineSide, exponent);
  if (taken > lineAmount) return `The rows add up to ${formatMoney(taken, exponent)}, more than the line's ${formatMoney(lineAmount, exponent)}: lower a row's amount.`;
  return taken < 0n ? 'The rows add up to the other side of the line: change a row\'s side or amount.' : '';
}

/** Whether the rows cover the whole line: the panel then closes by itself (observed). */
export const billsCover = (rows: readonly BillDraft[], lineSide: Side, lineAmount: bigint, exponent: MoneyExponent): boolean =>
  rows.length > 0 && allocated(rows, lineSide, exponent) === lineAmount && rows.every(row => row.method !== '' && row.amount !== '');

const unitWords: Record<string, 'day' | 'week' | 'month'> = { d: 'day', day: 'day', days: 'day', w: 'week', week: 'week', weeks: 'week', m: 'month', month: 'month', months: 'month' };
/** The server's credit period rule (its schema), so the panel refuses what the server would. */
const periodAccepted = (period: CreditPeriod) => creditPeriodSchema.safeParse(period).success;

/**
 * Typed credit period text: `30` (days), `30 days`, `2 weeks`, `1 month`, or a due date in the voucher date's forms, not
 * before the voucher date. Empty is no period (the bill is due on its date). Anything else is an error, never dropped.
 */
export function parseCreditPeriod(text: string, voucherDate: string): { value: CreditPeriod | null } | { error: string } {
  const typed = text.trim().toLowerCase();
  if (typed === '') return { value: null };
  const counted = /^(\d{1,5})\s*([a-z]*)$/.exec(typed);
  if (counted && (counted[2] === '' || unitWords[counted[2]])) {
    const period = { count: Number(counted[1]), unit: counted[2] === '' ? 'day' as const : unitWords[counted[2]] };
    return periodAccepted(period) ? { value: period } : { error: 'Enter a credit period of at most 3650 days, weeks or months.' };
  }
  const date = parseEntryDate(typed, voucherDate);
  if ('error' in date) return { error: `“${text.trim()}” is not a credit period: enter 30, 2 weeks, 1 month or a due date.` };
  if (date.value < voucherDate) return { error: `A due date before the voucher date (${longDate(voucherDate)}) is not a credit period.` };
  return { value: { dueDate: date.value } };
}

/** A credit period as the panel shows it again: `30 days`, `2 weeks`, `1 month`, or the due date. */
export function creditPeriodText(period: CreditPeriod | null): string {
  if (period === null) return '';
  if ('dueDate' in period) return longDate(period.dueDate);
  return `${period.count} ${period.unit}${period.count === 1 ? '' : 's'}`;
}

/** Why a panel row cannot be sent, naming it, or undefined. A row with neither a method nor an amount is empty and left out. */
export function billRowProblem(row: BillDraft, index: number, voucherDate: string): string | undefined {
  const where = `Bill row ${index + 1}`;
  if (row.method === '' && row.amount === '') return undefined;
  if (row.method === '') return `${where}: choose how it is settled.`;
  if (row.amount === '') return `${where}: enter its amount.`;
  if (row.method === 'against_ref' && row.bill === '') return `${where}: choose the bill it settles.`;
  if (row.method === 'new_ref' || row.method === 'advance') {
    const period = parseCreditPeriod(row.credit, voucherDate);
    if ('error' in period) return `${where}: ${period.error}`;
  }
  return undefined;
}

/** A panel row as the body's bill row; `billRowProblem` must hold first (the accept path checks it), and an empty row is null. */
export function billRowBody(row: BillDraft, lineSide: Side, voucherDate: string): BillRowInput | null {
  if (row.method === '' || row.amount === '') return null;
  const side = row.side && row.side !== lineSide ? { side: row.side } : {};
  if (row.method === 'on_account') return { kind: 'on_account', amount: row.amount, ...side };
  if (row.method === 'against_ref') return { kind: 'against_ref', billId: row.bill, amount: row.amount, ...side };
  const period = parseCreditPeriod(row.credit, voucherDate);
  const credit = 'value' in period && period.value ? { creditPeriod: period.value } : {};
  return { kind: row.method, ...row.name.trim() ? { name: row.name.trim() } : {}, ...credit, amount: row.amount, ...side };
}
