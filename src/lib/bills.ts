import { z } from 'zod';
import { calendarDate, type BillKind, type Side } from './ledger.ts';

/**
 * The bill reports' shared vocabulary (M2a slice 1): query schemas (zod at the API boundary) and the shapes the server
 * returns. Amounts are `bigint` minor units on the server and decimal strings on the wire; a signed amount is positive
 * on the debit side. A bill's date and due date come from its creating row, its first live row in storage order.
 */

const id = z.uuid().transform(value => value.toLowerCase());
export const billSides = ['receivable', 'payable'] as const;
export type BillSide = (typeof billSides)[number];
export const ageingBases = ['bill', 'due'] as const;
export type AgeingBasis = (typeof ageingBases)[number];

/** Bills receivable or payable: bills on the side's natural side (debit for receivables) under a group, at a date. */
export const outstandingQuery = z.object({
  side: z.enum(billSides), groupId: id.optional(), asOf: calendarDate,
  limit: z.coerce.number().int().min(1).max(1000).default(200), after: z.string().max(500).optional(),
}).strict();
export const ageingQuery = z.object({ side: z.enum(billSides), groupId: id.optional(), asOf: calendarDate, basis: z.enum(ageingBases).default('bill') }).strict();
export const asOfQuery = z.object({ asOf: calendarDate }).strict();
export const pickerSorts = ['name', 'bill_date', 'due_date', 'pending', 'final_pending'] as const;
/** The pending list offered while entering a voucher: pending at the voucher date, plus the final pending over all dates. */
export const pickerQuery = z.object({
  asOf: calendarDate, scope: z.enum(['pending', 'all']).default('pending'),
  sort: z.enum(pickerSorts).default('bill_date'), direction: z.enum(['asc', 'desc']).default('asc'),
}).strict();
export const creditCheckQuery = z.object({ date: calendarDate }).strict();

/** The company's ageing columns, contiguous from 0 days; only the last may be open-ended (`toDays` null). */
export const ageingBucketsInput = z.object({
  buckets: z.array(z.object({ fromDays: z.number().int().min(0).max(36500), toDays: z.number().int().min(1).max(36500).nullable() }).strict()).max(20),
}).strict().superRefine(({ buckets }, context) => {
  buckets.forEach((bucket, index) => {
    const message = (text: string) => context.addIssue({ code: 'custom', path: ['buckets', index], message: text });
    if (index === 0 && bucket.fromDays !== 0) message('The first column starts at 0 days.');
    if (index > 0 && bucket.fromDays !== buckets[index - 1].toDays) message('Each column starts where the one before ends.');
    if (bucket.toDays !== null && bucket.toDays <= bucket.fromDays) message('A column ends after it starts.');
    if (bucket.toDays === null && index !== buckets.length - 1) message('Only the last column can be open-ended.');
  });
});
export type AgeingBucket = { fromDays: number; toDays: number | null };

/** A pending bill: signed pending at the date and over all dates, its dates and how many days it is overdue. */
export type PendingBill = {
  billId: string; name: string; ledgerId: string; ledgerName: string; billDate: string | null; dueDate: string | null;
  /** The creating row's method: a new reference, or an advance. */
  method: 'new_ref' | 'advance'; pending: bigint; finalPending: bigint; overdueDays: number;
};
export type BillsOutstandingReport = {
  asOf: string; side: BillSide; group: { id: string; name: string };
  /** `amount` is the pending amount on the side's natural side (positive). */
  bills: (PendingBill & { amount: bigint })[]; total: bigint;
  /** The cursor of the next page (`after`), or null on the last one; `total` covers every page. */
  next: string | null;
};
export type PartyBillsReport = {
  asOf: string; ledger: { id: string; name: string; groupId: string | null; groupName: string | null; billWise: boolean };
  /** Every bill with a pending amount on either side. */
  bills: PendingBill[];
  /** What the party's lines and opening leave outside bills: on account. Bills plus on account is the balance. */
  onAccount: bigint; balance: bigint;
};
export type BillDetailRow = {
  voucherId: string | null; voucherTypeName: string | null; number: number | null; date: string;
  /** As entered, and as the bill shows it now (the creating row is new or advance; later live rows are settlements). */
  kind: BillKind; method: BillKind; side: Side; amount: bigint;
  status: 'opening' | 'regular' | 'optional' | 'cancelled' | 'deleted';
  /** Running pending after this row, for rows that count at the date; null otherwise. */
  pending: bigint | null;
};
export type BillDetailReport = {
  asOf: string;
  bill: { id: string; name: string; ledgerId: string; ledgerName: string; billDate: string | null; dueDate: string | null; pending: bigint; finalPending: bigint };
  rows: BillDetailRow[];
};
export type AgeingParty = { ledgerId: string; name: string; notDue: bigint | null; buckets: bigint[]; total: bigint };
export type AgeingReport = {
  asOf: string; side: BillSide; basis: AgeingBasis; group: { id: string; name: string };
  /** The company's columns (none by default), always ending with an open-ended column, so the columns add up to the total. */
  buckets: AgeingBucket[];
  parties: AgeingParty[]; totals: { notDue: bigint | null; buckets: bigint[]; total: bigint };
};
export type BillPickerRow = Omit<PendingBill, 'ledgerId' | 'ledgerName' | 'method'> & { side: Side | null };
export type CreditCheck = { check: boolean; overdueBills: number };
