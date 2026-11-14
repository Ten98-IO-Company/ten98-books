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
const voucherBody = {
  date: calendarDate,
  narration: z.string().max(2000).nullish().transform(value => value?.trim() || null),
  status: z.enum(['regular', 'optional']).default('regular'),
  postDated: z.boolean().default(false),
  lines: z.array(voucherLine).max(500),
};
/** Creating a voucher. The idempotency key makes a retried request return the first result instead of posting twice. */
export const voucherCreateInput = z.object({
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  voucherTypeId: id,
  ...voucherBody,
}).strict();
/** Altering keeps the voucher type and number; `revision` is the one the editor last read. */
export const voucherAlterInput = z.object({ ...voucherBody, revision }).strict();
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
  action: 'create' | 'alter' | 'cancel' | 'delete'; actorId: string; at: string; before: unknown; after: unknown;
};
