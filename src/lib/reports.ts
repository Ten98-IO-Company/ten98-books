import { z } from 'zod';
import { financialYearOf } from './company.ts';
import { calendarDate, type Nature, type Side, type VoucherKind, type VoucherStatus } from './ledger.ts';

/**
 * The M1 reports' shared vocabulary: query schemas (zod at the API boundary), the shapes the server returns and pure
 * presentation helpers. Amounts are `bigint` minor units on the server and decimal strings on the wire (`Wire<T>` in
 * ./money.ts). A signed balance is positive on the debit side and negative on the credit side.
 */

/** The longest period a report covers. Statements spanning more than this are not an M1 use case. */
export const maxPeriodDays = 3660;
const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;
/** Days in the period, counting both the first and the last day. */
export const periodDays = (from: string, to: string) => dayNumber(to) - dayNumber(from) + 1;

const periodShape = { from: calendarDate, to: calendarDate };
const checkPeriod = <T extends { from: string; to: string }>(schema: z.ZodType<T>) => schema
  .refine(period => period.from <= period.to, { message: 'The period must end on or after its start.', path: ['to'] })
  .refine(period => period.from > period.to || periodDays(period.from, period.to) <= maxPeriodDays, { message: 'Choose a period of at most ten years.', path: ['to'] });

export const reportPeriodQuery = checkPeriod(z.object(periodShape).strict());
export const balanceSheetQuery = z.object({ date: calendarDate }).strict();
/** Paged registers (day book, ledger vouchers): a keyset cursor from the previous page's `next`. */
export const reportPageQuery = checkPeriod(z.object({
  ...periodShape,
  limit: z.coerce.number().int().min(1).max(500).default(200),
  after: z.string().max(200).optional(),
}).strict());
export type ReportPeriod = { from: string; to: string };

/** Report names as they appear in API paths and screen routes. */
export const reportNames = ['day-book', 'trial-balance', 'profit-and-loss', 'balance-sheet', 'group-summary', 'ledger-monthly', 'ledger-vouchers'] as const;
export type ReportName = (typeof reportNames)[number];

/** The six amounts every statement node carries. Each pair holds gross sums of its ledgers' debit and credit sides. */
export type NodeAmounts = {
  openingDebit: bigint; openingCredit: bigint; debit: bigint; credit: bigint; closingDebit: bigint; closingCredit: bigint;
};
export const amountKeys = ['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const satisfies readonly (keyof NodeAmounts)[];

/**
 * One line of the group hierarchy: a group (with the sums of every ledger below it) or a ledger. `depth` 0 is a primary
 * group, or a ledger outside every group (the profit and loss ledger). Lists are in pre-order, so a group is followed by
 * its sub-groups and then its ledgers.
 */
export type StatementNode = BalancedAmounts & {
  key: string; kind: 'group' | 'ledger'; id: string; name: string; parentKey: string | null; depth: number;
  nature: Nature | null; grossProfit: boolean; systemKey: string | null;
};
/** The six amounts plus the signed opening and closing balances they net to. */
export type BalancedAmounts = NodeAmounts & { opening: bigint; closing: bigint };

export type OpeningDifference = { amount: bigint; side: Side | null };

export type TrialBalanceReport = {
  from: string; to: string; nodes: StatementNode[];
  /** Sums of the primary-level lines. */
  totals: NodeAmounts;
  /** Opening balances entered out of balance (D-10). */
  openingDifference: OpeningDifference;
  /** The difference line on the short side (null when the openings agree), and the totals with it, which agree. */
  difference: NodeAmounts | null;
  grandTotals: NodeAmounts;
};

/**
 * One line of a statement. Headings and totals have no depth and always show; group and ledger lines carry the depth
 * of their node, and the condensed view keeps depth 0. `amount` is in the section's natural direction (income and
 * liabilities on the credit side, expenses and assets on the debit side), so a negative amount sits against it.
 */
export type StatementLine = {
  key: string;
  kind: 'heading' | 'group' | 'ledger' | 'subtotal' | 'result' | 'profit-and-loss' | 'difference';
  label: string; depth: number | null; amount: bigint | null;
  /** Where Enter leads: a group's summary, a ledger's monthly summary, or another statement. */
  target: { report: 'group-summary'; groupId: string } | { report: 'ledger-monthly'; ledgerId: string } | { report: 'profit-and-loss' } | null;
};

export type ProfitAndLossReport = {
  from: string; to: string; lines: StatementLine[];
  /** Signed results: profit positive, loss negative. */
  grossProfit: bigint; netProfit: bigint;
};

export type BalanceSheetReport = {
  date: string; from: string; lines: StatementLine[];
  totals: { liabilities: bigint; assets: bigint };
  /** Results carried into the balance sheet: profit positive, loss negative. */
  profitAndLoss: { broughtForward: bigint; currentPeriod: bigint };
  openingDifference: OpeningDifference;
};

export type GroupSummaryReport = {
  from: string; to: string;
  /** null for the primary level (every primary group and the ledgers outside any group). */
  group: { id: string; name: string; parentId: string | null; nature: Nature } | null;
  rows: StatementNode[]; totals: BalancedAmounts;
};

export type LedgerHeader = { id: string; name: string; groupId: string | null; groupName: string | null; nature: Nature | null };

export type LedgerMonth = { month: string; from: string; to: string; debit: bigint; credit: bigint; closing: bigint };
export type LedgerMonthlyReport = {
  /** `to` is clipped to the end of the financial year that contains `from`: one year's months at a time. */
  from: string; to: string; ledger: LedgerHeader; opening: bigint; months: LedgerMonth[];
  totals: { debit: bigint; credit: bigint; closing: bigint };
};

export type LedgerVoucherRow = {
  voucherId: string; date: string; voucherTypeName: string; kind: VoucherKind; number: number | null;
  /** The first ledger on the other side of the voucher, and how many more there are. */
  particulars: string; otherLedgers: number;
  debit: bigint; credit: bigint; balance: bigint;
};
export type LedgerVouchersReport = {
  from: string; to: string; ledger: LedgerHeader; opening: bigint; rows: LedgerVoucherRow[]; next: string | null;
  totals: { debit: bigint; credit: bigint; closing: bigint };
};

export type DayBookRow = {
  voucherId: string; date: string; voucherTypeName: string; kind: VoucherKind; number: number | null;
  status: VoucherStatus; postDated: boolean; narration: string | null;
  /** The first line's ledger; the voucher amount stands in that line's column. */
  particulars: string; side: Side; amount: bigint;
};
export type DayBookReport = {
  from: string; to: string; rows: DayBookRow[]; next: string | null;
  /** Regular vouchers of the whole period; cancelled and optional ones are listed but never counted. */
  totals: { debit: bigint; credit: bigint; vouchers: number };
};

export type ReportDefaults = {
  /** The latest date of a regular, undeleted, not post-dated voucher; null while there is none. */
  lastVoucherDate: string | null;
  /** Statements open on this period: the financial-year start through the last voucher date (or the books beginning). */
  period: ReportPeriod;
  /** The day book opens on this day. */
  dayBookDate: string;
  booksBeginning: string;
};

/** The default statement period for `anchor` (the last voucher date): its financial-year start through that date. */
export function defaultPeriod(financialYearStart: { month: number; day: number }, anchor: string): ReportPeriod {
  return { from: financialYearOf(financialYearStart, anchor).from, to: anchor };
}

/** A signed balance as an amount and its side: `{ amount: 5n, side: 'Cr' }` for -5n, side null for zero. */
export function splitBalance(signed: bigint): OpeningDifference {
  return signed > 0n ? { amount: signed, side: 'Dr' } : signed < 0n ? { amount: -signed, side: 'Cr' } : { amount: 0n, side: null };
}

/** True when every amount of the node is zero: the "hide zero lines" option leaves it out. */
export const isZeroNode = (node: Record<(typeof amountKeys)[number], bigint | string>) =>
  amountKeys.every(key => node[key] === 0n || /^-?0(\.0+)?$/.test(String(node[key])));

const groupers = new Map<number, Intl.NumberFormat>();
/**
 * A wire amount (an exact decimal string) for reading: digit grouping and exactly `exponent` decimal places. Intl formats
 * the decimal string exactly, never through a float, so 3-decimal currencies keep their fils.
 */
export function formatAmount(text: string, exponent: number): string {
  let format = groupers.get(exponent);
  if (!format) groupers.set(exponent, format = new Intl.NumberFormat('en-US', { minimumFractionDigits: exponent, maximumFractionDigits: exponent }));
  return format.format(text as Intl.StringNumericLiteral);
}

/** A signed wire balance as "1,250.00 Dr" or "300.000 Cr"; zero reads as the bare amount. */
export function formatBalance(text: string, exponent: number): string {
  const negative = text.startsWith('-');
  const amount = formatAmount(negative ? text.slice(1) : text, exponent);
  return /^-?0(\.0+)?$/.test(text) ? amount : `${amount} ${negative ? 'Cr' : 'Dr'}`;
}
