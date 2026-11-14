import { z } from 'zod';
import { isCalendarDate } from './company.ts';
import { moneyText } from './money.ts';

/**
 * The ledger's shared vocabulary: wire schemas (zod at the API boundary) and the shapes the server returns. Amounts are
 * `bigint` minor units on the server and decimal strings on the wire (`Wire<T>` in ./money.ts).
 */
export const natures = ['asset', 'liability', 'income', 'expense'] as const;
export type Nature = (typeof natures)[number];
export const sides = ['Dr', 'Cr'] as const;
export type Side = (typeof sides)[number];
export const voucherKinds = ['contra', 'payment', 'receipt', 'journal', 'sales', 'purchase', 'credit_note', 'debit_note'] as const;
export type VoucherKind = (typeof voucherKinds)[number];
export type VoucherStatus = 'regular' | 'cancelled' | 'optional';

/**
 * Stable reasons the ledger API sends as `code` beside the plain-language `error`, so screens branch on the reason, not
 * the sentence. Statuses stay as they were; a code never changes meaning once published.
 */
export const ledgerErrorCodes = [
  'validation', // a field is missing, malformed, out of range or contradicts another field
  'not_found', // the company, master or voucher (or one it refers to) is not there or not reachable
  'stale_revision', // someone changed the row since the client read it
  'retry', // a deadlock or serialization failure; nothing was saved
  'duplicate_name', // another group, ledger or voucher type of the company has the name
  'in_use', // a group holds sub-groups or ledgers, or a ledger has voucher lines
  'seeded_row', // a built-in row cannot be deleted
  'nature_fixed', // a nature cannot change here (built-in rows, or ledgers with postings or openings below)
  'family_rule', // a built-in ledger would leave its behaviour family
  'cycle', // a group would sit under its own sub-group
  'locked_period', // the date or the opening balances are inside the locked period
  'before_books_beginning', // the date is before the company's books begin
  'unbalanced', // fewer than two lines, or debits differ from credits
  'posting_rule', // the voucher type's rule for cash and bank ledgers is broken
  'voucher_state', // the voucher's status does not allow this change (cancelled, optional, numbered)
  'idempotency_mismatch', // the idempotency key was used for a different voucher body (or company, on company creation)
  'not_set_up', // the company has no books settings yet; members get this, non-members get not_found
  'allocation_total', // a line's (or an opening balance's) bill rows net to more than it, or to its other side
  'bill_inactive', // a settlement names a bill whose vouchers were all deleted or cancelled
] as const;
export type LedgerErrorCode = (typeof ledgerErrorCodes)[number];

const id = z.uuid().transform(value => value.toLowerCase());
const clean = (value: string) => !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
const name = z.string().trim().min(1).max(120).refine(clean);
const secondLanguageName = z.string().trim().max(120).refine(clean).nullish().transform(value => value || null);
const revision = z.number().int().positive();
export const calendarDate = z.string().refine(isCalendarDate, { message: 'Enter a real date as YYYY-MM-DD.' });

export const groupCreateInput = z.object({
  name, secondLanguageName,
  parentId: id.nullish().transform(value => value ?? null),
  nature: z.enum(natures).optional(),
  grossProfit: z.boolean().optional(),
}).strict();
export const groupAlterInput = groupCreateInput.extend({ revision }).strict();

/**
 * A credit period as entered (observed): a count of days, weeks or months, or a fixed due date. Screens render and parse
 * the typed forms in their own wording; the wire carries the structure.
 */
export const creditUnits = ['day', 'week', 'month'] as const;
export type CreditUnit = (typeof creditUnits)[number];
export const creditPeriod = z.union([
  z.object({ count: z.number().int().min(0).max(3650), unit: z.enum(creditUnits) }).strict(),
  z.object({ dueDate: calendarDate }).strict(),
]);
export type CreditPeriod = { count: number; unit: CreditUnit } | { dueDate: string };

/**
 * The four methods of a bill row. A new reference or an advance on a name the party already has joins that bill
 * (observed); an against reference names an existing bill; on account belongs to no bill.
 */
export const billKinds = ['new_ref', 'advance', 'against_ref', 'on_account'] as const;
export type BillKind = (typeof billKinds)[number];
const billName = z.string().trim().min(1).max(100).refine(clean);
const billRowShape = {
  kind: z.enum(billKinds), name: billName.optional(), billId: id.optional(), creditPeriod: creditPeriod.optional(),
  amount: moneyText, side: z.enum(sides).optional(),
};
type BillRowShape = { kind: BillKind; name?: string; billId?: string; creditPeriod?: unknown };
const billRowRules = (row: BillRowShape, context: z.RefinementCtx) => {
  if (row.name !== undefined && row.billId !== undefined) context.addIssue({ code: 'custom', path: ['name'], message: 'Give the bill name or the bill, not both.' });
  if (row.kind === 'on_account' && (row.name !== undefined || row.billId !== undefined)) context.addIssue({ code: 'custom', path: ['name'], message: 'An on-account row names no bill.' });
  if ((row.kind === 'on_account' || row.kind === 'against_ref') && row.creditPeriod !== undefined) context.addIssue({ code: 'custom', path: ['creditPeriod'], message: 'Only a new reference or an advance takes a credit period.' });
  if (row.kind === 'against_ref' && row.name === undefined && row.billId === undefined) context.addIssue({ code: 'custom', path: ['name'], message: 'Name the bill this row settles.' });
};
/** A bill row on a voucher line. A new reference without a name takes the default name (LEDGER.md, "Bills"). */
export const billRowInput = z.object(billRowShape).strict().superRefine(billRowRules);
export type BillRowInput = z.output<typeof billRowInput>;
/**
 * A bill of a ledger's opening balance (observed: new bills only, on the opening side): named, dated (default the day
 * before the books begin), with an optional credit period.
 */
export const openingBillInput = z.object({
  kind: z.literal('new_ref').default('new_ref'), name: billName, billDate: calendarDate.optional(), creditPeriod: creditPeriod.optional(), amount: moneyText,
}).strict();
export type OpeningBillInput = z.output<typeof openingBillInput>;

const opening = z.object({ amount: moneyText, side: z.enum(sides), bills: z.array(openingBillInput).max(500).optional() }).strict();
export const ledgerCreateInput = z.object({
  name, secondLanguageName,
  groupId: id.nullish().transform(value => value ?? null),
  opening: opening.optional(),
  billWise: z.boolean().optional(),
  creditPeriod: creditPeriod.nullable().optional(),
  creditDaysCheck: z.boolean().optional(),
}).strict();
export const ledgerAlterInput = ledgerCreateInput.extend({ revision }).strict();

export const voucherTypeAlterInput = z.object({ name, secondLanguageName, revision }).strict();
export const revisionInput = z.object({ revision }).strict();

const voucherLine = z.object({ ledgerId: id, side: z.enum(sides), amount: moneyText, bills: z.array(billRowInput).max(100).optional() }).strict();
const reference = z.string().trim().max(100).refine(clean);
const narration = z.string().max(2000);
const voucherStatus = z.enum(['regular', 'optional']);
const lines = z.array(voucherLine).max(500);
/** Creating a voucher. The idempotency key makes a retried request return the first result instead of posting twice. */
export const voucherCreateInput = z.object({
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  voucherTypeId: id,
  date: calendarDate,
  narration: narration.nullish().transform(value => value?.trim() || null),
  status: voucherStatus.default('regular'),
  postDated: z.boolean().default(false),
  reference: reference.nullish().transform(value => value || null),
  referenceDate: calendarDate.nullish().transform(value => value ?? null),
  lines,
}).strict();
/**
 * Altering replaces the whole voucher body except its type and number, so every field is stated: an omitted status or
 * post-dated flag must never fall back to a default (that would post an optional voucher). `revision` is the one the
 * editor last read; `narration` may be null to clear it.
 */
export const voucherAlterInput = z.object({
  date: calendarDate,
  narration: narration.nullable().transform(value => value?.trim() || null),
  status: voucherStatus,
  postDated: z.boolean(),
  reference: reference.nullable().transform(value => value || null),
  referenceDate: calendarDate.nullable(),
  lines,
  revision,
}).strict();
/** A page of the voucher list: keyset cursor from the previous page's `next`. */
export const voucherListQuery = z.object({
  from: calendarDate, to: calendarDate,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  after: z.string().max(200).optional(),
}).strict().refine(query => query.from <= query.to, { message: 'The period must end on or after its start.' });
export type VoucherCreateInput = z.input<typeof voucherCreateInput>;
export type VoucherAlterInput = z.input<typeof voucherAlterInput>;

export const periodQuery = z.object({ from: calendarDate, to: calendarDate }).refine(period => period.from <= period.to, { message: 'The period must end on or after its start.' });

export type AccountGroup = {
  id: string; parentId: string | null; nature: Nature; grossProfit: boolean; systemKey: string | null;
  name: string; secondLanguageName: string | null; revision: number;
};
/** A row of a ledger's opening bill-wise breakup. */
export type OpeningBill = {
  kind: BillKind; billId: string | null; billName: string | null; billDate: string; dueDate: string | null;
  creditPeriod: CreditPeriod | null; amount: bigint; side: Side;
};
export type Ledger = {
  id: string; groupId: string | null; groupName: string | null; nature: Nature | null; systemKey: string | null;
  name: string; secondLanguageName: string | null; cashOrBank: boolean;
  opening: { amount: bigint; side: Side }; revision: number;
  /** Bill-wise settings (M2a): the default credit period and whether sales entry warns about overdue bills. */
  billWise: boolean; creditPeriod: CreditPeriod | null; creditDaysCheck: boolean; openingBills: OpeningBill[];
};
/**
 * A group or ledger as the list and read routes return it: plus `inUse`, true when a delete would be refused because
 * the group holds sub-groups or ledgers, or because voucher lines (also of cancelled or deleted vouchers) name the
 * ledger. Built-in rows are refused on another ground: `systemKey` is set. Create and alter answers, and revision
 * snapshots, are the plain master without `inUse`.
 */
export type GroupListItem = AccountGroup & { inUse: boolean };
export type LedgerListItem = Ledger & { inUse: boolean };
export type VoucherType = {
  id: string; kind: VoucherKind; systemKey: string | null; name: string; secondLanguageName: string | null;
  numberingSeries: string; revision: number;
};
/** A stored bill row of a line: the method as entered, the bill it belongs to and the terms it carries. */
export type BillRow = {
  kind: BillKind; billId: string | null; billName: string | null; side: Side; amount: bigint;
  dueDate: string | null; creditPeriod: CreditPeriod | null;
};
export type VoucherLine = {
  lineNo: number; ledgerId: string; ledgerName: string; side: Side; amount: bigint;
  currency: string; currencyAmount: bigint; fxRate: string; bills: BillRow[];
};
export type Voucher = {
  id: string; voucherTypeId: string; voucherTypeName: string; kind: VoucherKind; series: string; number: number | null;
  date: string; narration: string | null; status: VoucherStatus; postDated: boolean; deleted: boolean; revision: number;
  reference: string | null; referenceDate: string | null; total: bigint; lines: VoucherLine[];
};
/**
 * What a posting did with bill rows that the caller may not expect, reproduced from the reference behaviour rather than
 * refused: rows dropped on a ledger that is not bill-wise, earlier rows kept on such a ledger at an alter, a new row that
 * joins another voucher's bill, a settlement beyond the pending amount, one line on both sides of one bill, and rows of
 * other vouchers left on a bill this voucher no longer creates.
 */
export const billWarningCodes = ['bills_ignored', 'bills_kept', 'bill_attached', 'bill_over_settled', 'bill_both_sides', 'bill_split'] as const;
export type BillWarningCode = (typeof billWarningCodes)[number];
export type BillWarning = { code: BillWarningCode; line: number | null; billId: string | null; billName: string | null; amount: bigint | null };
export type VoucherSummary = Omit<Voucher, 'lines'>;
export type VoucherPage = { vouchers: VoucherSummary[]; next: string | null };

/** One ledger in a trial balance for a period. Amounts are non-negative; each pair has at most one non-zero side. */
export type TrialBalanceRow = {
  ledgerId: string; name: string; systemKey: string | null; groupId: string | null;
  primaryGroupId: string | null; primaryGroupName: string | null; nature: Nature | null; grossProfit: boolean;
  openingDebit: bigint; openingCredit: bigint; debit: bigint; credit: bigint; closingDebit: bigint; closingCredit: bigint;
};
export type TrialBalance = {
  from: string; to: string; rows: TrialBalanceRow[];
  totals: { openingDebit: bigint; openingCredit: bigint; debit: bigint; credit: bigint; closingDebit: bigint; closingCredit: bigint };
  /** Opening balances entered out of balance while a company is set up (D-10): shown, never blocking. */
  openingDifference: { amount: bigint; side: Side | null };
};

export type Revision = {
  id: string; entity: 'group' | 'ledger' | 'voucher_type' | 'voucher'; entityId: string;
  /** `actorName` is the user's display name, or null once that user no longer exists; never an email. */
  action: 'create' | 'alter' | 'cancel' | 'delete'; actorId: string; actorName: string | null; at: string; before: unknown; after: unknown;
};

/**
 * Reads for the voucher entry screen (docs/LEDGER.md, "Voucher entry reads"). None of them writes or locks anything: a
 * previewed number can be taken by another voucher before this one is saved, and a previewed balance is the books as
 * they stand plus the draft.
 */
export const nextNumberQuery = z.object({ date: calendarDate }).strict();
export type NextNumber = { number: number; periodStart: string; periodEnd: string };
const previewLine = z.object({ ledgerId: id, side: z.enum(sides), amount: moneyText }).strict();
export const balancePreviewInput = z.object({ date: calendarDate, voucherId: id.optional(), lines: z.array(previewLine).max(500) }).strict();
/** A ledger's balance at the date, signed: positive on the debit side, negative on the credit side. */
export type BalancePreview = { balances: { ledgerId: string; balance: bigint }[] };
export const counterLedgerQuery = z.object({ voucherTypeId: id, side: z.enum(sides) }).strict();
export type CounterLedger = { counter: { ledgerId: string; voucherId: string; voucherDate: string } | null };
