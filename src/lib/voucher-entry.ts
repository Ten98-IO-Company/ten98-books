import { normalizeDecimal } from '@ten98/ui';
import { addMoney, compareMoney, formatMoney, MONEY_MAX, multiplyMoney, parseMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime/browser';
import { financialYearOf, isCalendarDate } from './company.ts';
import type { BillKind, BillRowInput, CreditPeriod, LedgerErrorCode, Side, VoucherCreateInput, VoucherKind } from './ledger.ts';
import { readStored, writeStored, type StoreSource } from './working-date.ts';
export { billDueDate } from './bills.ts';

/**
 * The voucher entry screen's decisions, kept pure so they can be tested (docs/VOUCHERS.md). The components in
 * src/components/vouchers/ only apply them. Amounts are decimal strings in the company's minor units on the way in and
 * out, `bigint` minor units inside (D-04, D-07); nothing here ever uses a JavaScript number for money.
 */

// ---- Types, layouts and sides ----

/** The voucher types slice 1 builds. */
export const entryKinds = ['payment', 'receipt', 'contra', 'journal'] as const;
export type EntryKind = (typeof entryKinds)[number];
export const isEntryKind = (value: unknown): value is EntryKind => entryKinds.includes(value as EntryKind);

export const kindTitles: Record<VoucherKind, string> = {
  payment: 'Payment', receipt: 'Receipt', contra: 'Contra', journal: 'Journal', sales: 'Sales', purchase: 'Purchase',
  credit_note: 'Credit note', debit_note: 'Debit note',
};

/** Single entry: an Account field and particulars lines. Double entry: lines with a side each. */
export type EntryLayout = 'single' | 'double';
export const layoutTitles: Record<EntryLayout, string> = { single: 'Single entry', double: 'Double entry' };

/** The layouts a type offers: journal is double entry only. */
export const layoutsOf = (kind: EntryKind): readonly EntryLayout[] => kind === 'journal' ? ['double'] : ['single', 'double'];
/** Each type's own layout before any choice (observed): payment, receipt and contra open in single entry. */
export const defaultLayout = (kind: EntryKind): EntryLayout => kind === 'journal' ? 'double' : 'single';

const other = (side: Side): Side => side === 'Dr' ? 'Cr' : 'Dr';
export const otherSide = other;

/**
 * The side of the single-entry Account: credited on a payment, debited on a receipt and on a contra (observed: the
 * contra's Account is the receiving side, and the starter dataset's contra lines follow that order).
 */
export const accountSide = (kind: EntryKind): Side => kind === 'payment' ? 'Cr' : 'Dr';
/** The side of single-entry particulars lines: the other side of the Account. */
export const particularsSide = (kind: EntryKind): Side => other(accountSide(kind));
/**
 * The first line's side in double entry, fixed by the type (observed: payment and journal debit first, receipt credits
 * first). The contra's is not observed; ours follows its Account, the receiving side.
 */
export const firstLineSide = (kind: EntryKind): Side => kind === 'receipt' ? 'Cr' : 'Dr';

// ---- Mode memory ----

/**
 * A layout chosen in one type applies to every type of its family (observed). The cash family (payment, receipt,
 * contra) keeps its choice per tab and company; the journal has no choice. Invoice types (slice 2) keep theirs per
 * browser under `voucherMode:invoice`.
 */
export const cashModeKey = (companyId: string): string => `voucherMode:${companyId}:cash`;
export const invoiceModeKey = 'voucherMode:invoice';

export function readLayout(kind: EntryKind, session: StoreSource, companyId: string): EntryLayout {
  if (kind === 'journal') return 'double';
  const stored = readStored(session, cashModeKey(companyId));
  return stored === 'single' || stored === 'double' ? stored : defaultLayout(kind);
}

export function writeLayout(kind: EntryKind, layout: EntryLayout, session: StoreSource, companyId: string): void {
  if (kind !== 'journal') writeStored(session, cashModeKey(companyId), layout);
}

// ---- Amounts ----

export type ParseResult = { value: string } | { error: string };

/**
 * Typed amount text as the company stores it: Arabic-Indic digits and grouping are accepted (the grid's
 * `normalizeDecimal`), then the value is rounded half up to the currency's places (observed: entry rounds). A value
 * that rounds to zero is an empty cell, so no line exists; a sign or a value beyond the stored range is an error.
 */
export function parseEntryAmount(text: string, exponent: MoneyExponent): ParseResult {
  const normal = normalizeDecimal(text, Infinity, false);
  if ('error' in normal) return { error: 'Enter an amount such as 1,250.50.' };
  const rounded = multiplyMoney(10n ** BigInt(exponent), normal.value, 'half-up');
  if (rounded > MONEY_MAX) return { error: 'This amount is too large.' };
  return { value: rounded === 0n ? '' : formatMoney(rounded, exponent) };
}

/** Minor units of a stored cell value; an empty cell is zero. */
export const minorOf = (value: string, exponent: MoneyExponent): bigint => value === '' ? 0n : parseMoney(value, exponent);

/** `1250.5` as `1,250.50`: display only. */
export function groupedAmount(amount: bigint, exponent: MoneyExponent): string {
  const plain = formatMoney(amount < 0n ? -amount : amount, exponent);
  const [whole, fraction] = plain.split('.');
  return `${amount < 0n ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** A signed balance (positive on the debit side) as "4,950.00 Dr"; zero has no side. */
export function balanceText(balance: bigint, exponent: MoneyExponent): string {
  if (balance === 0n) return groupedAmount(0n, exponent);
  return `${groupedAmount(balance < 0n ? -balance : balance, exponent)} ${balance < 0n ? 'Cr' : 'Dr'}`;
}

// ---- Dates ----

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const arabicDigits = (text: string) => text.replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06F0));
const pad = (value: number) => String(value).padStart(2, '0');

export const dateExample = 'Enter a date such as 9, 10-8, 12 sep or 15-10-2026.';

/**
 * Typed date text as a calendar date (observed forms): the day first, then an optional month (a number or a month
 * name of at least three letters) and an optional year (two digits are 20yy); missing parts come from `current`, the
 * voucher's date. Separators are `-`, `/`, `.` and spaces. Refused: digits without separators (`130526`), a month
 * before the day (`sep 16`), a day the month does not have (`35`, `31-2`). Ours also takes `2026-01-31`.
 */
export function parseEntryDate(text: string, current: string): ParseResult {
  const typed = arabicDigits(text).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(typed)) return isCalendarDate(typed) ? { value: typed } : { error: dateExample };
  const parts = typed.split(/[-/.\s]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 3 || !/^\d{1,2}$/.test(parts[0])) return { error: dateExample };
  const [currentYear, currentMonth] = current.split('-').map(Number);
  const day = Number(parts[0]);
  let month = currentMonth;
  if (parts[1] !== undefined) {
    if (/^\d{1,2}$/.test(parts[1])) month = Number(parts[1]);
    else {
      const index = parts[1].length >= 3 ? monthNames.findIndex(name => name.startsWith(parts[1])) : -1;
      if (index < 0) return { error: dateExample };
      month = index + 1;
    }
  }
  let year = currentYear;
  if (parts[2] !== undefined) {
    if (/^\d{2}$/.test(parts[2])) year = 2000 + Number(parts[2]);
    else if (/^\d{4}$/.test(parts[2])) year = Number(parts[2]);
    else return { error: dateExample };
  }
  const value = `${year}-${pad(month)}-${pad(day)}`;
  return isCalendarDate(value) ? { value } : { error: dateExample };
}

/** `2026-01-01` as `1 Jan 2026`. */
export function entryDateText(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${day} ${months[month - 1][0].toUpperCase()}${months[month - 1].slice(1)} ${year}`;
}

/** The date with its weekday, as the header shows it: `Thursday, 1 Jan 2026`. */
export const entryDateLabel = (date: string): string => `${weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()]}, ${entryDateText(date)}`;

const nextDay = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export type DateRules = { booksBeginning: string; lockedThrough: string | null; financialYearStart: { month: number; day: number } };

/**
 * Why a voucher date cannot be taken, or undefined. The lower bounds are the posting rules' (the books beginning and
 * the locked period); the upper bound is the end of the financial year that holds the tab's working date (observed:
 * the reference refuses a date past its current period; ours derives that period from the working date).
 */
export function entryDateProblem(date: string, rules: DateRules, workingDate: string): string | undefined {
  if (date < rules.booksBeginning) return `Date cannot be before the books begin, ${entryDateText(rules.booksBeginning)}.`;
  if (rules.lockedThrough !== null && date <= rules.lockedThrough) return `Date is in the locked period, which ends ${entryDateText(rules.lockedThrough)}; the first open date is ${entryDateText(nextDay(rules.lockedThrough))}.`;
  const end = financialYearOf(rules.financialYearStart, workingDate).to;
  if (date > end) return `Date cannot be after the end of the current financial year, ${entryDateText(end)}.`;
  return undefined;
}

// ---- Lines ----

/** One line as the screen holds it: a side ('' only while a double-entry line has none yet), a ledger id and an amount. */
export type EntryLine = { key: string; side: Side | ''; ledger: string; amount: string };

/** A line with nothing in it: no ledger and no amount (its side alone does not count). */
export const isBlankLine = (line: Pick<EntryLine, 'ledger' | 'amount'>): boolean => line.ledger === '' && line.amount === '';
/** A line the body carries: a ledger and an amount, and a side in double entry. */
export const isCompleteLine = (line: EntryLine): boolean => line.ledger !== '' && line.amount !== '' && line.side !== '';

/** Debit and credit totals of the complete lines (typed amounts, not ledger balances). */
export function lineTotals(lines: readonly EntryLine[], exponent: MoneyExponent): { debit: bigint; credit: bigint } {
  let debit = 0n, credit = 0n;
  for (const line of lines) {
    if (!isCompleteLine(line)) continue;
    if (line.side === 'Dr') debit = addMoney(debit, minorOf(line.amount, exponent));
    else credit = addMoney(credit, minorOf(line.amount, exponent));
  }
  return { debit, credit };
}

/** What a double-entry voucher is short of: the side that needs more and by how much, or null when it balances. */
export function shortfall(lines: readonly EntryLine[], exponent: MoneyExponent): { side: Side; amount: bigint } | null {
  const { debit, credit } = lineTotals(lines, exponent);
  const sign = compareMoney(debit, credit);
  if (sign === 0) return null;
  return sign > 0 ? { side: 'Cr', amount: subtractMoney(debit, credit) } : { side: 'Dr', amount: subtractMoney(credit, debit) };
}

/** The status line's difference: "Difference 50.00 Dr" names the side that is ahead, as the totals read. */
export function differenceText(lines: readonly EntryLine[], exponent: MoneyExponent): string | null {
  const short = shortfall(lines, exponent);
  return short && `Difference ${groupedAmount(short.amount, exponent)} ${other(short.side)}`;
}

/** The single-entry total: the particulars' amounts. */
export function particularsTotal(lines: readonly EntryLine[], exponent: MoneyExponent): bigint {
  return lines.reduce((sum, line) => line.ledger !== '' && line.amount !== '' ? addMoney(sum, minorOf(line.amount, exponent)) : sum, 0n);
}

/** The draft's content as the screen holds it (everything a type switch or a body needs). */
export type EntryDraft = { kind: EntryKind; layout: EntryLayout; account: string; lines: readonly EntryLine[] };

/**
 * The lines in another type's or layout's arrangement (observed on a type switch: kept and re-laid, never cleared and
 * never re-checked; the new type's rules apply only at accept).
 * - Single to double: the Account becomes the first line, on the new type's first-line side, with the total as its
 *   amount; the particulars keep their sides, which may leave the voucher unbalanced. A line on the short side then
 *   follows, empty, as observed.
 * - Double to single: the first line becomes the Account, the others the particulars.
 * - Single to single: the particulars take the new type's side. Double to double: unchanged.
 * `key` gives new lines their keys.
 */
export function relayLines(from: EntryDraft, to: { kind: EntryKind; layout: EntryLayout }, exponent: MoneyExponent, key: () => string): { account: string; lines: EntryLine[] } {
  const kept = from.lines.filter(line => !isBlankLine(line));
  if (from.layout === 'single' && to.layout === 'double') {
    const sided = kept.map(line => ({ ...line, side: particularsSide(from.kind) as Side | '' }));
    const total = particularsTotal(kept, exponent);
    const lines: EntryLine[] = from.account === '' ? sided
      : [{ key: key(), side: firstLineSide(to.kind), ledger: from.account, amount: total === 0n ? '' : formatMoney(total, exponent) }, ...sided];
    const short = shortfall(lines, exponent);
    if (short || lines.length === 0) lines.push({ key: key(), side: short?.side ?? firstLineSide(to.kind), ledger: '', amount: '' });
    return { account: '', lines };
  }
  if (from.layout === 'double' && to.layout === 'single') {
    const [first, ...rest] = kept;
    const lines = rest.map(line => ({ ...line, side: particularsSide(to.kind) as Side | '' }));
    return { account: first?.ledger ?? '', lines: lines.length ? lines : [{ key: key(), side: particularsSide(to.kind), ledger: '', amount: '' }] };
  }
  if (to.layout === 'single') {
    const lines = kept.map(line => ({ ...line, side: particularsSide(to.kind) as Side | '' }));
    return { account: from.account, lines: lines.length ? lines : [{ key: key(), side: particularsSide(to.kind), ledger: '', amount: '' }] };
  }
  return { account: '', lines: from.lines.length ? [...from.lines] : [{ key: key(), side: firstLineSide(to.kind), ledger: '', amount: '' }] };
}

// ---- Ledger lists ----

export type EntryLedger = { id: string; name: string; secondLanguageName: string | null; cashOrBank: boolean };
export type LedgerOption = { value: string; label: string; description?: string };
/** Where a lookup sits: the single-entry Account, or a line (in single entry a particulars line). */
export type LedgerPosition = 'account' | 'line';
/**
 * What a ledger lookup offers: `defaults` while nothing is typed, `all` when typing; `closed` when the two are one set
 * and other text is refused.
 */
export type LedgerLists = { defaults: LedgerOption[]; all: LedgerOption[]; closed: boolean };

const optionOf = (ledger: EntryLedger): LedgerOption => ({ value: ledger.id, label: ledger.name, ...ledger.secondLanguageName ? { description: ledger.secondLanguageName } : {} });
// By name, as the master lists sort (lower case), ties by id, so the order is the same on every machine.
const byName = (a: EntryLedger, b: EntryLedger) => { const x = a.name.toLowerCase(), y = b.name.toLowerCase(); return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : 1; };

/**
 * The ledgers a lookup offers (docs/VOUCHERS.md, "Lists"; observed):
 * - contra: cash and bank only, everywhere (closed);
 * - the single-entry Account of a payment or receipt: cash and bank (closed);
 * - the side that pays on a double-entry payment (credit) or receipt (debit): every ledger, cash and bank first;
 * - every other line, and the journal: other ledgers when nothing is typed, every ledger when typing (a cash or bank
 *   ledger is found by typing its name).
 */
export function ledgerOptions(kind: EntryKind, layout: EntryLayout, position: LedgerPosition, side: Side | '', ledgers: readonly EntryLedger[]): LedgerLists {
  const sorted = [...ledgers].sort(byName);
  const cash = sorted.filter(ledger => ledger.cashOrBank).map(optionOf);
  const rest = sorted.filter(ledger => !ledger.cashOrBank).map(optionOf);
  const every = sorted.map(optionOf);
  if (kind === 'contra' || (layout === 'single' && position === 'account' && kind !== 'journal')) return { defaults: cash, all: cash, closed: true };
  const paysOn = kind === 'payment' ? 'Cr' : kind === 'receipt' ? 'Dr' : null;
  if (layout === 'double' && paysOn !== null && side === paysOn) { const first = [...cash, ...rest]; return { defaults: first, all: first, closed: true }; }
  return { defaults: rest, all: every, closed: false };
}

/**
 * Whether the posting rule accepts a ledger on a line by itself: only the contra restricts single lines (every line cash
 * or bank). Payment and receipt rules are about the voucher as a whole (a cash or bank credit, or debit), checked by
 * `cashRuleProblem` before sending.
 */
export const lineAccepts = (kind: EntryKind, ledger: Pick<EntryLedger, 'cashOrBank'>): boolean => kind !== 'contra' || ledger.cashOrBank;

/** The posting rule's refusal before sending, with the first line of the side that needs cash or bank; undefined when it holds. */
export function cashRuleProblem(kind: EntryKind, lines: readonly { side: Side; ledger: string }[], isCash: (ledgerId: string) => boolean): { message: string; line: number } | undefined {
  if (kind === 'contra') {
    const index = lines.findIndex(line => !isCash(line.ledger));
    return index < 0 ? undefined : { message: `A contra voucher moves money between cash and bank ledgers only; line ${index + 1} uses another ledger.`, line: index };
  }
  if (kind !== 'payment' && kind !== 'receipt') return undefined;
  const pays: Side = kind === 'payment' ? 'Cr' : 'Dr';
  if (lines.some(line => line.side === pays && isCash(line.ledger))) return undefined;
  const index = Math.max(0, lines.findIndex(line => line.side === pays));
  return { message: kind === 'payment' ? 'No cash or bank ledger is credited: a payment must credit at least one.' : 'No cash or bank ledger is debited: a receipt must debit at least one.', line: index };
}

// ---- Detail steps and bills ----

export type DetailStep = 'bills';
export type StepLedger = { billWise: boolean };

/**
 * The detail steps a line opens after its amount, in order: bills for a bill-wise ledger now; cost centres and bank
 * details plug into the same list later. Nothing for a line without a ledger or an amount.
 */
export function detailSteps(line: Pick<EntryLine, 'ledger' | 'amount'>, ledger: StepLedger | undefined): DetailStep[] {
  if (isBlankLine(line) || line.ledger === '' || line.amount === '' || !ledger) return [];
  return ledger.billWise ? ['bills'] : [];
}

export const billKindTitles: Record<BillKind, string> = { against_ref: 'Against a bill', new_ref: 'New bill', advance: 'Advance', on_account: 'On account' };
export const billKindOrder: readonly BillKind[] = ['against_ref', 'new_ref', 'advance', 'on_account'];

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
      .reduce((sum, row) => subtractMoney(sum, minorOf(row.amount || '0', exponent)), bill.pending < 0n ? -bill.pending : bill.pending);
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

/** Whether the rows cover the whole line: the panel then closes by itself (observed). */
export const billsCover = (rows: readonly BillDraft[], lineSide: Side, lineAmount: bigint, exponent: MoneyExponent): boolean =>
  rows.length > 0 && allocated(rows, lineSide, exponent) === lineAmount && rows.every(row => row.method !== '' && row.amount !== '');

const creditUnitWords: Record<string, 'day' | 'week' | 'month'> = { d: 'day', day: 'day', days: 'day', w: 'week', week: 'week', weeks: 'week', m: 'month', month: 'month', months: 'month' };

/**
 * Typed credit period text: `30` (days), `30 days`, `2 weeks`, `1 month`, or a date in the voucher date's forms. Empty
 * is no period (the bill is due on its date). `voucherDate` fills a date's missing parts.
 */
export function parseCreditPeriod(text: string, voucherDate: string): { value: CreditPeriod | null } | { error: string } {
  const typed = arabicDigits(text).trim().toLowerCase();
  if (typed === '') return { value: null };
  const counted = /^(\d{1,4})\s*([a-z]*)$/.exec(typed);
  if (counted && (counted[2] === '' || creditUnitWords[counted[2]])) {
    const count = Number(counted[1]);
    if (count > 3650) return { error: 'Enter at most 3650 days.' };
    // A bare number of one or two digits could be a day of the month; the observed form `30` means 30 days.
    return { value: { count, unit: counted[2] === '' ? 'day' : creditUnitWords[counted[2]] } };
  }
  const date = parseEntryDate(typed, voucherDate);
  if ('error' in date) return { error: 'Enter a credit period such as 30, 2 weeks or 1 month, or a due date.' };
  return { value: { dueDate: date.value } };
}

/** A credit period as the panel shows it again: `30 days`, `2 weeks`, `1 month`, or the due date. */
export function creditPeriodText(period: CreditPeriod | null): string {
  if (period === null) return '';
  if ('dueDate' in period) return entryDateText(period.dueDate);
  return `${period.count} ${period.unit}${period.count === 1 ? '' : 's'}`;
}

/** A panel row as the body's bill row, or null for a row with no method or no amount (it is left out). */
export function billRowBody(row: BillDraft, lineSide: Side, voucherDate: string): BillRowInput | null {
  if (row.method === '' || row.amount === '') return null;
  const side = row.side && row.side !== lineSide ? { side: row.side } : {};
  if (row.method === 'on_account') return { kind: 'on_account', amount: row.amount, ...side };
  if (row.method === 'against_ref') return { kind: 'against_ref', billId: row.bill, amount: row.amount, ...side };
  const period = parseCreditPeriod(row.credit, voucherDate);
  const credit = 'value' in period && period.value ? { creditPeriod: period.value } : {};
  return { kind: row.method, ...row.name.trim() ? { name: row.name.trim() } : {}, ...credit, amount: row.amount, ...side };
}

// ---- The body ----

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
 * narration is null when empty; a new voucher is regular and not post-dated (slice 3 adds the rest).
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

// ---- The Enter path ----

/** Where focus goes: a header field, the total or narration stop, the accept prompt, or a grid cell. */
export type EntryFocus =
  | { field: 'date' | 'account' | 'total' | 'narration' }
  | { cell: { row: string; column: 'side' | 'ledger' | 'amount'; open?: boolean; edit?: boolean } };

/**
 * What Enter does at the end of the list (the grid's `onEnd`, on its last row), or null to let the grid go on (append
 * the next line or move to the next cell):
 * - On a blank line's ledger cell: the list ends. Single entry goes to Total when the Account is a bank ledger and
 *   straight to Narration with a cash Account (observed); double entry goes to Narration.
 * - Double entry, on a complete last line, balanced: straight to Narration, with no new line (observed).
 */
export function listEnd(input: { layout: EntryLayout; lines: readonly EntryLine[]; row: string; column: string; accountIsCash: boolean; exponent: MoneyExponent }): EntryFocus | null {
  const line = input.lines.find(entry => entry.key === input.row);
  if (!line) return null;
  if (input.column === 'ledger' && isBlankLine(line)) {
    if (input.layout === 'double') return { field: 'narration' };
    return { field: input.accountIsCash ? 'narration' : 'total' };
  }
  if (input.layout === 'double' && input.column === 'amount' && isCompleteLine(line)) {
    const complete = input.lines.filter(isCompleteLine);
    if (complete.length >= 2 && shortfall(input.lines, input.exponent) === null) return { field: 'narration' };
  }
  return null;
}

/**
 * The next line Enter appends after a complete last line (the grid's `createRow`). Single entry: a blank particulars
 * line. Double entry: a line on the short side with the counter ledger from history (or empty), and the difference as
 * its amount once a ledger is there (observed); a balanced voucher never gets here (`listEnd`).
 */
export function appendedLine(input: { kind: EntryKind; layout: EntryLayout; lines: readonly EntryLine[]; counter: string | null; exponent: MoneyExponent; key: string }): EntryLine {
  if (input.layout === 'single') return { key: input.key, side: particularsSide(input.kind), ledger: '', amount: '' };
  const short = shortfall(input.lines, input.exponent);
  const side = short?.side ?? other(input.lines[input.lines.length - 1]?.side || firstLineSide(input.kind));
  const ledger = input.counter ?? '';
  return { key: input.key, side, ledger, amount: ledger !== '' && short ? formatMoney(short.amount, input.exponent) : '' };
}

/** The difference a new double-entry line proposes once its ledger is chosen (observed), or '' when nothing is short. */
export function proposedAmount(lines: readonly EntryLine[], row: string, exponent: MoneyExponent): string {
  const others = lines.filter(line => line.key !== row);
  const line = lines.find(entry => entry.key === row);
  if (!line || line.amount !== '' || line.ledger === '' || line.side === '') return '';
  const short = shortfall(others, exponent);
  return short && short.side === line.side ? formatMoney(short.amount, exponent) : '';
}

/** "No" at the accept prompt: back to the first field of the layout with its list open, everything kept (observed). */
export function afterDeclinedAccept(layout: EntryLayout, lines: readonly EntryLine[]): EntryFocus {
  if (layout === 'single') return { field: 'account' };
  return lines.length ? { cell: { row: lines[0].key, column: 'ledger', open: true } } : { field: 'date' };
}

/** Where F2's date field returns: the field or cell it was opened from; a ledger cell reopens its list (observed). */
export type FocusOrigin = { field: 'date' | 'account' | 'total' | 'narration' } | { cell: { row: string; column: 'side' | 'ledger' | 'amount' } };
export function afterDate(origin: FocusOrigin): EntryFocus {
  if ('field' in origin) return origin;
  return { cell: { ...origin.cell, ...origin.cell.column === 'ledger' ? { open: true } : { edit: false } } };
}

/** After the ledger alteration opened from a lookup: saved goes to the line's amount, closed back to the ledger with its list (observed). */
export const afterLedgerInPlace = (outcome: 'saved' | 'closed', row: string): EntryFocus =>
  outcome === 'saved' ? { cell: { row, column: 'amount', edit: true } } : { cell: { row, column: 'ledger', open: true } };

/**
 * Escape on a focused field or cell that is not editing (the grid hands it over): the first press empties a value,
 * prefilled ones included; with nothing to empty it asks to quit when anything was entered, else it leaves (observed).
 */
export const escapeStep = (value: string, dirty: boolean): 'clear' | 'ask' | 'leave' => value !== '' ? 'clear' : dirty ? 'ask' : 'leave';

// ---- The draft reducer ----

export type DraftState = EntryDraft & {
  date: string; narration: string; bills: Readonly<Record<string, readonly BillDraft[]>>;
  /** The next line key's number, so keys never repeat inside one voucher. */
  serial: number;
};

export type DraftAction =
  | { type: 'date'; date: string }
  | { type: 'account'; ledger: string }
  | { type: 'lines'; lines: readonly EntryLine[] }
  | { type: 'narration'; text: string }
  | { type: 'bills'; row: string; rows: readonly BillDraft[] }
  | { type: 'switch'; kind: EntryKind; layout: EntryLayout; exponent: MoneyExponent }
  | { type: 'next' }
  /** The draft kept in the tab before a sign-in, taken back as it was. */
  | { type: 'restore'; state: DraftState };

export const lineKey = (serial: number): string => `line-${serial}`;

/** A blank voucher of a type and layout on a date: one empty line. */
export function blankDraft(kind: EntryKind, layout: EntryLayout, date: string, serial = 1): DraftState {
  const side = layout === 'single' ? particularsSide(kind) : firstLineSide(kind);
  return { kind, layout, date, account: '', narration: '', bills: {}, lines: [{ key: lineKey(serial), side, ledger: '', amount: '' }], serial: serial + 1 };
}

/** Whether anything was entered: a leave or quit then asks first. */
export const draftDirty = (state: DraftState): boolean =>
  state.account !== '' || state.narration.trim() !== '' || state.lines.some(line => !isBlankLine(line));

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'date': return { ...state, date: action.date };
    case 'account': return { ...state, account: action.ledger };
    case 'narration': return { ...state, narration: action.text };
    case 'lines': {
      const keys = new Set(action.lines.map(line => line.key));
      const bills = Object.fromEntries(Object.entries(state.bills).filter(([key]) => keys.has(key)));
      const highest = action.lines.reduce((top, line) => Math.max(top, Number(/^line-(\d+)$/.exec(line.key)?.[1] ?? 0)), 0);
      return { ...state, lines: action.lines, bills, serial: Math.max(state.serial, highest + 1) };
    }
    case 'bills': return { ...state, bills: { ...state.bills, [action.row]: action.rows } };
    case 'switch': {
      let serial = state.serial;
      const relaid = relayLines(state, action, action.exponent, () => lineKey(serial++));
      // Bill rows stay with their lines; a line that became the Account has none (cash and bank are not bill-wise here).
      const keys = new Set(relaid.lines.map(line => line.key));
      const bills = Object.fromEntries(Object.entries(state.bills).filter(([key]) => keys.has(key)));
      return { ...state, kind: action.kind, layout: action.layout, account: relaid.account, lines: relaid.lines, bills, serial };
    }
    // After a save: same type, layout and date; everything else empty (optional and post-dated are never carried).
    case 'next': return blankDraft(state.kind, state.layout, state.date, state.serial);
    case 'restore': return action.state;
  }
}

// ---- Save refusals ----

/** Where a save refusal is shown (docs/VOUCHERS.md, "Saving"). Total over the codes, so a new code fails the typecheck until placed. */
export type RefusalPlace = 'alert' | 'difference' | 'cash-rule' | 'date' | 'status' | 'bills' | 'stale' | 'gone' | 'maybe-saved' | 'retry' | 'setup' | 'master-form';
export const refusalPlaces: Record<LedgerErrorCode, RefusalPlace> = {
  validation: 'alert',
  not_found: 'gone',
  stale_revision: 'stale',
  retry: 'retry',
  duplicate_name: 'master-form',
  in_use: 'master-form',
  seeded_row: 'master-form',
  nature_fixed: 'master-form',
  family_rule: 'master-form',
  cycle: 'master-form',
  locked_period: 'date',
  before_books_beginning: 'date',
  unbalanced: 'difference',
  posting_rule: 'cash-rule',
  voucher_state: 'status',
  idempotency_mismatch: 'maybe-saved',
  not_set_up: 'setup',
  allocation_total: 'bills',
  bill_inactive: 'bills',
  feature_off: 'alert',
};
export const refusalPlace = (code: string | undefined): RefusalPlace => code !== undefined && Object.hasOwn(refusalPlaces, code) ? refusalPlaces[code as LedgerErrorCode] : 'alert';

/** The warning a credit to a cash-in-hand ledger raises when its balance goes below zero; never blocks (observed). */
export function negativeCashWarning(name: string, balance: bigint | undefined, exponent: MoneyExponent): string | null {
  return balance !== undefined && balance < 0n ? `${name} will be ${balanceText(balance, exponent)} after this voucher.` : null;
}
