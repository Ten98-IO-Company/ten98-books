import { z } from 'zod';
import { financialYearOf } from './company.ts';
import { calendarDate, type Nature, type Side, type VoucherKind, type VoucherStatus } from './ledger.ts';
import type { CostCategorySummary, CostCentreBreakup, CostFigures } from './cost-centres.ts';
import type { Wire } from './money.ts';

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

const dates = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
const months = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** A calendar date for reading: "3 February 2026". Dates are company calendar dates, so no time zone applies. */
export const longDate = (date: string) => dates.format(new Date(`${date}T00:00:00Z`));
/** A month key (YYYY-MM) for reading: "February 2026". */
export const monthText = (month: string) => months.format(new Date(`${month}-01T00:00:00Z`));
/** A period for reading: one day, or "1 January 2026 to 3 February 2026". */
export const periodText = (period: ReportPeriod) => period.from === period.to ? longDate(period.from) : `${longDate(period.from)} to ${longDate(period.to)}`;

/**
 * Which period a report screen uses and remembers: statements share one remembered period (it carries from report to
 * report), the day book opens on its own day and never changes the statements' period, and the voucher view has none.
 */
export type PeriodKind = 'statement' | 'day' | 'none';

/** Records the period shown on a screen of `kind`; only statement periods are remembered for the next report. */
export function recordPeriod(memory: Map<string, ReportPeriod>, companyId: string, kind: PeriodKind, period: ReportPeriod): void {
  if (kind === 'statement') memory.set(companyId, period);
}

/** The remembered period a screen of `kind` opens on when its address has none. */
export function rememberedPeriod(memory: ReadonlyMap<string, ReportPeriod>, companyId: string, kind: PeriodKind): ReportPeriod | undefined {
  return kind === 'statement' ? memory.get(companyId) : undefined;
}

/**
 * The cursors of the pages before the one shown, newest last. Pushing the cursor already on top changes nothing, so a
 * key repeated while the next page loads (when the old page and its `next` are still on screen) cannot record the same
 * page twice and break the way back.
 */
export const pushCursor = (stack: readonly string[], cursor: string): readonly string[] => stack.at(-1) === cursor ? stack : [...stack, cursor];
export const popCursor = (stack: readonly string[]): readonly string[] => stack.slice(0, -1);

/**
 * A register's cursor stack in the address (`pages`): the cursors joined by dots, which base64url cursors never contain.
 * Text that is not such a list reads as no pages (the first page), so a hand-edited address cannot break the screen.
 */
const cursorList = /^[A-Za-z0-9_-]{1,120}(\.[A-Za-z0-9_-]{1,120}){0,199}$/;
export const readCursorStack = (text: unknown): readonly string[] => typeof text === 'string' && cursorList.test(text) ? text.split('.') : [];
export const writeCursorStack = (stack: readonly string[]): string | undefined => stack.length ? stack.join('.') : undefined;

/** A line of the cost category summary screen: each category with its figures, then its top-level centres one level in. */
export type CostSummaryLine = {
  key: string; kind: 'category' | 'centre'; id: string; name: string; depth: 0 | 1;
  opening: string; debit: string; credit: string; closing: string;
};

/** The summary's categories and centres as table lines in the server's order, keyed `k:` (category) and `c:` (centre). */
export function costSummaryLines(report: Wire<CostCategorySummary>): CostSummaryLine[] {
  const figures = ({ opening, debit, credit, closing }: Wire<CostFigures>) => ({ opening, debit, credit, closing });
  return report.categories.flatMap((category): CostSummaryLine[] => [
    { key: `k:${category.categoryId}`, kind: 'category', id: category.categoryId, name: category.name, depth: 0, ...figures(category) },
    ...category.centres.map((centre): CostSummaryLine => ({ key: `c:${centre.costCentreId}`, kind: 'centre', id: centre.costCentreId, name: centre.name, depth: 1, ...figures(centre) })),
  ]);
}

/** The table key of a break-up line: `c:` for a sub-centre, `l:` for a ledger (ids alone could be equal across the two). */
export const costBreakupKey = (row: { kind: 'centre' | 'ledger'; id: string }) => `${row.kind === 'centre' ? 'c' : 'l'}:${row.id}`;

/** What a report screen shows apart from its period and view. Drilling to another subject on the same route is another level. */
export const reportSubject = (search: { group?: string; ledger?: string; voucher?: string; centre?: string }) =>
  [search.group, search.ledger, search.voucher, search.centre].map(value => value ?? '').join('|');

/** A screen's highlighted line, with the subject and the address's `hl` it was last synced with. */
export type HighlightState = { subject: string; hl: string | undefined; highlight: string | undefined };

/**
 * The highlight after the address changed. Another subject (a drill on the same route) takes the address's `hl`; so does
 * a new `hl` on the same subject (back to a level whose highlight the drill-down trail wrote). An `hl` that only went
 * away (a period change clears it) keeps the line the user moved to. Returns `state` itself when nothing changed, so a
 * screen can compare by identity.
 */
export function syncHighlight(state: HighlightState, subject: string, hl: string | undefined): HighlightState {
  if (subject === state.subject && hl === state.hl) return state;
  if (subject === state.subject && hl === undefined) return { subject, hl, highlight: state.highlight };
  return { subject, hl, highlight: hl };
}

/** Search parameters that change how a level is shown, not which level it is: a drill-down trail ignores them. */
const transientParameters = ['hl', 'pages', 'from', 'to', 'detail', 'zeros'];

/**
 * A report address as a drill-down level: the path (any case) and its subject parameters in a stable order, without the
 * highlight, the register page, the period or the view, so a level whose period or page changed after the drill is
 * still found in the trail.
 */
export function reportLevel(href: string): string {
  const url = new URL(href, 'http://report.invalid');
  for (const name of transientParameters) url.searchParams.delete(name);
  url.searchParams.sort();
  return `${url.pathname.toLowerCase()}?${url.searchParams}`;
}

/** Loaded report data, shown only for the subject it was read for (a period change keeps it on screen while it reloads). */
export const dataForSubject = <T>(loaded: { subject: string | undefined; data: T | null }, subject: string | undefined): T | null =>
  loaded.subject === subject ? loaded.data : null;

/** Where a line of a cost report leads, as a report route and its subject (the period carries over). */
export type CostDrill =
  | { report: 'cost-centre-breakup'; search: { centre: string } }
  | { report: 'ledger-vouchers'; search: { ledger: string; fromCentre: string } };

/** A summary line opens its centre's break-up; a category line leads nowhere. */
export const costSummaryTarget = (line: Pick<CostSummaryLine, 'kind' | 'id'>): CostDrill | null =>
  line.kind === 'centre' ? { report: 'cost-centre-breakup', search: { centre: line.id } } : null;

/** A break-up line opens a sub-centre's break-up, or the ledger's vouchers marked as reached from `centreId`'s break-up. */
export const costBreakupTarget = (row: { kind: 'centre' | 'ledger'; id: string }, centreId: string): CostDrill =>
  row.kind === 'centre' ? { report: 'cost-centre-breakup', search: { centre: row.id } } : { report: 'ledger-vouchers', search: { ledger: row.id, fromCentre: centreId } };

/** The break-up's line under the title: the category, and what a ledger's figures mean here. */
export function costBreakupSummary(report: Pick<Wire<CostCentreBreakup>, 'centre' | 'rows'>): string {
  if (!report.rows.length) return `Category: ${report.centre.categoryName}. No amounts in this period.`;
  const ledgers = report.rows.some(row => row.kind === 'ledger');
  return `Category: ${report.centre.categoryName}.${ledgers ? ' A ledger’s figures here are this centre’s share; Enter on a ledger opens all of its vouchers for the period, for every centre.' : ''}`;
}

/** The centres the break-up's chooser lists for the typed text: a part of the name or the second-language name, any case. */
export function matchingCentres<T extends { name: string; secondLanguageName: string | null }>(centres: readonly T[], text: string): T[] {
  const words = text.trim().toLowerCase();
  return centres.filter(row => !words || row.name.toLowerCase().includes(words) || (row.secondLanguageName?.toLowerCase().includes(words) ?? false));
}

/** The notice on a ledger's vouchers reached from a cost centre break-up (`fromCentre`): they are not filtered by centre. */
export const centreOriginNotice = (search: { fromCentre?: string }): string | null => search.fromCentre
  ? 'Opened from a cost centre break-up. These are all of the ledger’s vouchers for the period, for every cost centre and those without one, so the totals are the ledger’s, not the centre’s.'
  : null;

/** Where the voucher view goes back to without a drill-down trail: the ledger's vouchers it came from (keeping the break-up it was reached from), else its day in the day book. */
export function voucherParent(search: { from?: string; to?: string; ledger?: string; fromCentre?: string }, date: string):
  { report: 'ledger-vouchers'; search: { from?: string; to?: string; ledger: string; fromCentre?: string } } | { report: 'day-book'; search: { from: string; to: string } } {
  return search.ledger
    ? { report: 'ledger-vouchers', search: { from: search.from, to: search.to, ledger: search.ledger, ...search.fromCentre ? { fromCentre: search.fromCentre } : {} } }
    : { report: 'day-book', search: { from: date, to: date } };
}

/** Where a ledger's vouchers go back to without a drill-down trail: the break-up they came from, else the ledger's monthly summary. */
export function ledgerVouchersParent(search: { from?: string; to?: string; ledger?: string; fromCentre?: string }):
  { report: 'cost-centre-breakup'; search: { from?: string; to?: string; centre: string } } | { report: 'ledger-monthly'; search: { from?: string; to?: string; ledger: string } } | null {
  if (search.fromCentre) return { report: 'cost-centre-breakup', search: { from: search.from, to: search.to, centre: search.fromCentre } };
  return search.ledger ? { report: 'ledger-monthly', search: { from: search.from, to: search.to, ledger: search.ledger } } : null;
}
