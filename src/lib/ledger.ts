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

const opening = z.object({ amount: moneyText, side: z.enum(sides) }).strict();
export const ledgerCreateInput = z.object({
  name, secondLanguageName,
  groupId: id.nullish().transform(value => value ?? null),
  opening: opening.optional(),
}).strict();
export const ledgerAlterInput = ledgerCreateInput.extend({ revision }).strict();

export const voucherTypeAlterInput = z.object({ name, secondLanguageName, revision }).strict();
export const revisionInput = z.object({ revision }).strict();

const voucherLine = z.object({ ledgerId: id, side: z.enum(sides), amount: moneyText }).strict();
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
export type Ledger = {
  id: string; groupId: string | null; groupName: string | null; nature: Nature | null; systemKey: string | null;
  name: string; secondLanguageName: string | null; cashOrBank: boolean;
  opening: { amount: bigint; side: Side }; revision: number;
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
export type VoucherLine = {
  lineNo: number; ledgerId: string; ledgerName: string; side: Side; amount: bigint;
  currency: string; currencyAmount: bigint; fxRate: string;
};
export type Voucher = {
  id: string; voucherTypeId: string; voucherTypeName: string; kind: VoucherKind; series: string; number: number | null;
  date: string; narration: string | null; status: VoucherStatus; postDated: boolean; deleted: boolean; revision: number;
  total: bigint; lines: VoucherLine[];
};
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
