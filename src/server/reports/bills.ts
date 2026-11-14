import { addMoney, subtractMoney } from '@ten98/runtime';
import {
  ageingBucketsInput, ageingQuery, asOfQuery, creditCheckQuery, outstandingQuery, pickerQuery,
  type AgeingBucket, type AgeingParty, type AgeingReport, type BillDetailReport, type BillDetailRow, type BillPickerRow, type BillSide,
  type BillsOutstandingReport, type CreditCheck, type PartyBillsReport, type PendingBill,
} from '../../lib/bills.ts';
import { creatorDueSql, creatorOrderSql, liveBillRowsSql, signedSql } from '../ledger/bills.ts';
import { ledgerError, parseInput, type LedgerContext } from '../ledger/context.ts';
import { countsSql, ledgerRows, reportBudget } from '../ledger/reports.ts';
import { exportLimit, exportTooLarge } from './cursor.ts';

/**
 * Bill read models (M2a slice 1). Pending amounts are signed sums of live bill rows dated on or before the date (opening
 * rows always count); a bill's date and due date come from the row that dates it (`creatorOrderSql`: its earliest-dated
 * live new reference or advance, else its earliest-dated live settlement). On account is computed from the lines
 * themselves (each live line's amount less its bill rows, plus the opening balance less its opening bills), so bills plus
 * on account equalling the ledger balance is a real check, not a definition. Lists get the statements' 30-second budget,
 * one party's screens the ledger screens' 20 seconds (D-09).
 */

const listBudget = 30, partyBudget = 20;
const fields = (labels: Record<string, string>) => (path: readonly PropertyKey[]) => labels[String(path[0])] ?? 'the report settings';
const queryFields = fields({ side: 'receivable or payable', groupId: 'the group', asOf: 'the date', basis: 'the ageing basis', date: 'the date',
  scope: 'the list scope', sort: 'the sort order', direction: 'the sort direction', buckets: 'the ageing columns', limit: 'the page size', after: 'the page cursor' });
const ledgerNotFound = ledgerError(404, 'Ledger not found.', 'not_found');

type BillState = PendingBill;
/** The keyset of the bill lists: party name, party, bill date, bill name, bill. */
type BillKey = [party: string, ledgerId: string, billDate: string, name: string, billId: string];
type StateOptions = {
  /** Only bills pending on this side at the date (Dr: receivables' natural side). */
  side?: 'Dr' | 'Cr';
  /** Only bills dated on or before this date (the pending list offered for a voucher of that date). */
  datedBy?: string;
  /** A page: rows after this key, at most this many (one more is read to tell whether a next page exists). */
  after?: BillKey; limit?: number;
};
type StateRows = { bills: (BillState & { key: BillKey })[]; total: bigint };

/**
 * Bills of `ledgerIds` at `asOf`: pending (at the date) and final pending (all dates), with the dating row's dates.
 * Bills are kept when `keep` holds ('pending': non-zero at the date; 'final': non-zero at the date or over all dates;
 * 'all'), filtered before the dating rows are chosen. `total` is the signed sum of every kept bill, across pages.
 */
async function billStates(context: LedgerContext, ledgerIds: string[], asOf: string, keep: 'pending' | 'final' | 'all', options: StateOptions = {}): Promise<StateRows> {
  if (!ledgerIds.length) return { bills: [], total: 0n };
  const after = options.after ?? [null, null, null, null, null];
  const { rows } = await context.client.query<BillState & { partyKey: string; nameKey: string; total: bigint }>(
    `WITH live AS (${liveBillRowsSql('a.bill_id IS NOT NULL AND a.ledger_id = ANY($2::uuid[])')}),
     sums AS (
       SELECT bill_id, coalesce(sum(${signedSql('live')}) FILTER (WHERE opening OR row_date <= $3), 0)::bigint AS pending,
         sum(${signedSql('live')})::bigint AS final_pending
       FROM live GROUP BY bill_id),
     wanted AS (SELECT * FROM sums WHERE ($4 = 'all' OR pending <> 0 OR ($4 = 'final' AND final_pending <> 0))
       AND ($5::text IS NULL OR ($5 = 'Dr' AND pending > 0) OR ($5 = 'Cr' AND pending < 0))),
     chosen AS (SELECT DISTINCT ON (l.bill_id) l.bill_id, l.kind, l.row_date, ${creatorDueSql('l')} AS due_date
       FROM live l JOIN wanted w USING (bill_id) ORDER BY l.bill_id, ${creatorOrderSql}),
     listed AS (
       SELECT b.id AS "billId", b.name, b.ledger_id AS "ledgerId", led.name AS "ledgerName", lower(led.name) AS "partyKey", lower(b.name) AS "nameKey",
         ch.row_date, ch.due_date, CASE ch.kind WHEN 'advance' THEN 'advance' ELSE 'new_ref' END AS method, w.pending, w.final_pending,
         (sum(w.pending) OVER ())::bigint AS total
       FROM wanted w JOIN bill b ON b.company_id = $1 AND b.id = w.bill_id JOIN ledger led ON led.company_id = $1 AND led.id = b.ledger_id
         JOIN chosen ch ON ch.bill_id = w.bill_id
       WHERE $6::date IS NULL OR ch.row_date <= $6)
     SELECT "billId", name, "ledgerId", "ledgerName", "partyKey", "nameKey", to_char(row_date, 'YYYY-MM-DD') AS "billDate",
       to_char(due_date, 'YYYY-MM-DD') AS "dueDate", method, pending, final_pending AS "finalPending",
       greatest(0, $3::date - due_date)::int AS "overdueDays", total
     FROM listed
     WHERE $7::text IS NULL OR ("partyKey", "ledgerId", row_date, "nameKey", "billId") > ($7, $8::uuid, $9::date, $10, $11::uuid)
     ORDER BY "partyKey", "ledgerId", row_date, "nameKey", "billId"
     LIMIT $12`,
    [context.company.companyId, ledgerIds, asOf, keep, options.side ?? null, options.datedBy ?? null, ...after,
      options.limit === undefined ? null : options.limit + 1]);
  return {
    total: rows[0]?.total ?? 0n,
    bills: rows.map(({ partyKey, nameKey, total: _total, ...bill }) => ({ ...bill, key: [partyKey, bill.ledgerId, bill.billDate ?? '', nameKey, bill.billId] })),
  };
}
const states = async (...args: Parameters<typeof billStates>) => (await billStates(...args)).bills.map(({ key: _key, ...bill }) => bill);

const encodeKey = (key: BillKey) => Buffer.from(JSON.stringify(key)).toString('base64url');
function decodeKey(cursor: string | undefined): BillKey | undefined {
  if (cursor === undefined) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown;
    if (Array.isArray(key) && key.length === 5 && key.every(part => typeof part === 'string') && /^\d{4}-\d{2}-\d{2}$/.test(key[2])
      && [key[1], key[4]].every(id => /^[0-9a-f-]{36}$/.test(id))) return key as BillKey;
  } catch { /* refused below */ }
  throw ledgerError(400, 'Check the page cursor and try again.', 'validation');
}

/** Each ledger's on-account amount at `asOf`, from its lines and opening (signed, debit positive). */
async function onAccount(context: LedgerContext, ledgerIds: string[], asOf: string): Promise<Map<string, bigint>> {
  if (!ledgerIds.length) return new Map();
  const { rows } = await context.client.query<{ ledgerId: string; amount: bigint }>(
    `SELECT led.id AS "ledgerId",
       (CASE led.opening_side WHEN 'Dr' THEN led.opening_amount ELSE -led.opening_amount END
        - coalesce((SELECT sum(${signedSql('a')}) FROM bill_allocation a
            WHERE a.company_id = led.company_id AND a.ledger_id = led.id AND a.voucher_id IS NULL AND a.bill_id IS NOT NULL), 0)
        + coalesce((SELECT sum(CASE l.side WHEN 'Dr' THEN l.amount ELSE -l.amount END - coalesce(r.billed, 0))
            FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id
              LEFT JOIN LATERAL (SELECT sum(${signedSql('a')}) AS billed FROM bill_allocation a
                WHERE a.company_id = l.company_id AND a.voucher_id = l.voucher_id AND a.line_no = l.line_no AND a.bill_id IS NOT NULL) r ON true
            WHERE l.company_id = led.company_id AND l.ledger_id = led.id AND ${countsSql} AND v.date <= $3), 0))::bigint AS amount
     FROM ledger led WHERE led.company_id = $1 AND led.id = ANY($2::uuid[])`, [context.company.companyId, ledgerIds, asOf]);
  return new Map(rows.map(row => [row.ledgerId, row.amount]));
}

/** The group a list covers (default: trade receivables or payables) and the ledgers below it that hold bills. */
async function scope(context: LedgerContext, side: BillSide, groupId: string | undefined): Promise<{ group: { id: string; name: string }; ledgerIds: string[] }> {
  const { rows: [group] } = await context.client.query<{ id: string; name: string }>(
    groupId ? 'SELECT id, name FROM account_group WHERE company_id = $1 AND id = $2' : 'SELECT id, name FROM account_group WHERE company_id = $1 AND system_key = $2',
    [context.company.companyId, groupId ?? (side === 'receivable' ? 'receivables' : 'payables')]);
  if (!group) throw ledgerError(404, 'Group not found.', 'not_found');
  const { rows } = await context.client.query<{ id: string }>(
    `WITH RECURSIVE below(id) AS (SELECT $2::uuid UNION ALL SELECT g.id FROM account_group g JOIN below b ON g.company_id = $1 AND g.parent_id = b.id)
     SELECT l.id FROM ledger l WHERE l.company_id = $1 AND l.group_id IN (SELECT id FROM below)
       AND EXISTS (SELECT 1 FROM bill b WHERE b.company_id = l.company_id AND b.ledger_id = l.id)`, [context.company.companyId, group.id]);
  return { group, ledgerIds: rows.map(row => row.id) };
}

const naturalSide = (side: BillSide) => side === 'receivable' ? 'Dr' as const : 'Cr' as const;
const positive = (amount: bigint) => amount < 0n ? subtractMoney(0n, amount) : amount;

/**
 * Bills receivable or payable at a date, a page at a time (`limit`, `after`; an export reads them all). Bills on the
 * other side (advances, settlements left on their own) are not listed (observed). The total covers every page.
 */
export async function billsOutstandingReport(context: LedgerContext, query: unknown, all = false): Promise<BillsOutstandingReport> {
  const { side, groupId, asOf, limit, after } = parseInput(outstandingQuery, query, queryFields);
  await reportBudget(context, listBudget);
  const { group, ledgerIds } = await scope(context, side, groupId);
  const pageSize = all ? exportLimit : limit;
  const { bills, total } = await billStates(context, ledgerIds, asOf, 'pending', { side: naturalSide(side), after: all ? undefined : decodeKey(after), limit: pageSize });
  if (all && bills.length > pageSize) throw exportTooLarge;
  const shown = bills.slice(0, pageSize);
  return {
    asOf, side, group, total: positive(total),
    bills: shown.map(({ key: _key, ...bill }) => ({ ...bill, amount: positive(bill.pending) })),
    next: bills.length > pageSize ? encodeKey(shown[shown.length - 1].key) : null,
  };
}

/** One party's bills on either side, its on-account amount and its balance (bills plus on account). */
export async function partyBillsReport(context: LedgerContext, ledgerId: string, query: unknown): Promise<PartyBillsReport> {
  const { asOf } = parseInput(asOfQuery, query, queryFields);
  await reportBudget(context, partyBudget);
  const { rows: [ledger] } = await context.client.query<PartyBillsReport['ledger']>(
    `SELECT l.id, l.name, l.group_id AS "groupId", g.name AS "groupName", l.bill_wise AS "billWise"
     FROM ledger l LEFT JOIN account_group g ON g.company_id = l.company_id AND g.id = l.group_id WHERE l.company_id = $1 AND l.id = $2`,
    [context.company.companyId, ledgerId]);
  if (!ledger) throw ledgerNotFound;
  if (asOf < context.company.booksBeginning) throw ledgerError(400, `Choose a date on or after the books begin on ${context.company.booksBeginning}.`, 'validation');
  const bills = await states(context, [ledgerId], asOf, 'pending');
  const row = (await ledgerRows(context, context.company.booksBeginning, asOf, ledgerId)).rows.find(item => item.ledgerId === ledgerId)!;
  return { asOf, ledger, bills, onAccount: (await onAccount(context, [ledgerId], asOf)).get(ledgerId) ?? 0n, balance: subtractMoney(row.closingDebit, row.closingCredit) };
}

/**
 * One bill's rows in storage order (opening rows, then by date, voucher, line and row), those that count at the date
 * with the running pending, the others (cancelled, deleted, optional, or dated later) marked among them. The method shown
 * is the dating row's own for that row and a settlement for every other live row.
 */
export async function billDetailReport(context: LedgerContext, billId: string, query: unknown): Promise<BillDetailReport> {
  const { asOf } = parseInput(asOfQuery, query, queryFields);
  await reportBudget(context, partyBudget);
  const { rows: [bill] } = await context.client.query<{ id: string; name: string; ledgerId: string; ledgerName: string }>(
    `SELECT b.id, b.name, b.ledger_id AS "ledgerId", l.name AS "ledgerName" FROM bill b JOIN ledger l ON l.company_id = b.company_id AND l.id = b.ledger_id
     WHERE b.company_id = $1 AND b.id = $2`, [context.company.companyId, billId]);
  if (!bill) throw ledgerError(404, 'Bill not found.', 'not_found');
  const { rows } = await context.client.query<Omit<BillDetailRow, 'method' | 'pending'> & { counts: boolean; live: boolean; dating: boolean }>(
    `WITH dating AS (SELECT id FROM (${liveBillRowsSql('a.bill_id = $2')}) r ORDER BY ${creatorOrderSql} LIMIT 1)
     SELECT a.voucher_id AS "voucherId", t.name AS "voucherTypeName", v.number, to_char(coalesce(a.bill_date, v.date), 'YYYY-MM-DD') AS date,
       a.kind, a.side, a.amount,
       CASE WHEN a.voucher_id IS NULL THEN 'opening' WHEN v.deleted_at IS NOT NULL THEN 'deleted' ELSE v.status END AS status,
       (a.voucher_id IS NULL OR (v.status = 'regular' AND v.deleted_at IS NULL)) AS live,
       (a.voucher_id IS NULL OR (v.status = 'regular' AND v.deleted_at IS NULL AND v.date <= $3)) AS counts,
       a.id IN (SELECT id FROM dating) AS dating
     FROM bill_allocation a LEFT JOIN voucher v ON v.company_id = a.company_id AND v.id = a.voucher_id
       LEFT JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id
     WHERE a.company_id = $1 AND a.bill_id = $2
     ORDER BY (a.voucher_id IS NULL) DESC, coalesce(a.bill_date, v.date), a.voucher_id, a.line_no, a.id`, [context.company.companyId, billId, asOf]);
  const [state] = (await states(context, [bill.ledgerId], asOf, 'all')).filter(item => item.billId === billId);
  let running = 0n;
  const shown = rows.map(({ counts, live, dating, ...row }): BillDetailRow => {
    const method = !live ? row.kind : dating ? (row.kind === 'advance' ? 'advance' : 'new_ref') : 'against_ref';
    if (!counts) return { ...row, method, pending: null };
    running = addMoney(running, row.side === 'Dr' ? row.amount : subtractMoney(0n, row.amount));
    return { ...row, method, pending: running };
  });
  return {
    asOf, rows: shown,
    bill: { ...bill, billDate: state?.billDate ?? null, dueDate: state?.dueDate ?? null, pending: state?.pending ?? 0n, finalPending: state?.finalPending ?? 0n },
  };
}

/** The company's ageing columns, in order. */
export async function readAgeingBuckets(context: LedgerContext): Promise<AgeingBucket[]> {
  const { rows } = await context.client.query<AgeingBucket>(
    'SELECT from_days AS "fromDays", to_days AS "toDays" FROM ageing_bucket WHERE company_id = $1 ORDER BY position', [context.company.companyId]);
  return rows;
}

/** Replaces the company's ageing columns (editors and above). */
export async function saveAgeingBuckets(context: LedgerContext, value: unknown): Promise<AgeingBucket[]> {
  const { buckets } = parseInput(ageingBucketsInput, value, queryFields);
  await context.client.query('DELETE FROM ageing_bucket WHERE company_id = $1', [context.company.companyId]);
  if (buckets.length) {
    await context.client.query(
      `INSERT INTO ageing_bucket (company_id, position, from_days, to_days)
       SELECT $1, t.ord, t.from_days, t.to_days FROM unnest($2::integer[], $3::integer[]) WITH ORDINALITY AS t(from_days, to_days, ord)`,
      [context.company.companyId, buckets.map(bucket => bucket.fromDays), buckets.map(bucket => bucket.toDays)]);
  }
  return readAgeingBuckets(context);
}

/**
 * The column a bill `days` old falls in. A boundary day goes to the earlier column (observed: a bill 90 days old shows
 * in "60 to 90" with columns 0-30, 30-60, 60-90, 90 onwards); the first column includes day 0.
 */
export function bucketIndex(buckets: readonly AgeingBucket[], days: number): number {
  return buckets.findIndex((bucket, index) => (index === 0 ? days >= bucket.fromDays : days > bucket.fromDays) && (bucket.toDays === null || days <= bucket.toDays));
}

/**
 * Ageing of the listed bills (as bills receivable or payable) per party, by bill date or by due date, in the company's
 * columns, which always end with an open column so that they add up to the total. By due date, bills not yet due have
 * their own column (an assumption until observed). Advances and on-account amounts are not aged (observed).
 */
export async function ageingReport(context: LedgerContext, query: unknown): Promise<AgeingReport> {
  const { side, groupId, asOf, basis } = parseInput(ageingQuery, query, queryFields);
  await reportBudget(context, listBudget);
  const { group, ledgerIds } = await scope(context, side, groupId);
  // The columns always end open-ended, so they add up to the total: the company's own, with an open column after a
  // closed last one, or a single open column while none is defined.
  const defined = await readAgeingBuckets(context);
  const last = defined.at(-1);
  const buckets: AgeingBucket[] = !last ? [{ fromDays: 0, toDays: null }] : last.toDays === null ? defined : [...defined, { fromDays: last.toDays, toDays: null }];
  const parties = new Map<string, AgeingParty>();
  const blank = (): Omit<AgeingParty, 'ledgerId' | 'name'> => ({ notDue: basis === 'due' ? 0n : null, buckets: buckets.map(() => 0n), total: 0n });
  const totals = blank();
  const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  for (const bill of await states(context, ledgerIds, asOf, 'pending', { side: naturalSide(side) })) {
    const amount = positive(bill.pending);
    const party = parties.get(bill.ledgerId) ?? { ledgerId: bill.ledgerId, name: bill.ledgerName, ...blank() };
    parties.set(bill.ledgerId, party);
    const from = basis === 'bill' ? bill.billDate : bill.dueDate;
    const days = from === null ? 0 : dayOf(asOf) - dayOf(from);
    if (basis === 'due' && days <= 0) {
      party.notDue = addMoney(party.notDue!, amount);
      totals.notDue = addMoney(totals.notDue!, amount);
    } else {
      const index = bucketIndex(buckets, Math.max(days, 0));
      party.buckets[index] = addMoney(party.buckets[index], amount);
      totals.buckets[index] = addMoney(totals.buckets[index], amount);
    }
    party.total = addMoney(party.total, amount);
    totals.total = addMoney(totals.total, amount);
  }
  return { asOf, side, basis, group, buckets, parties: [...parties.values()], totals };
}

/**
 * The entry screen's pending list for one party at a voucher date: bills dated on or before it (a later bill is not
 * offered, observed), with their pending at the date and the final pending, sorted as asked.
 */
export async function billPicker(context: LedgerContext, ledgerId: string, query: unknown): Promise<BillPickerRow[]> {
  const { asOf, scope: listScope, sort, direction } = parseInput(pickerQuery, query, queryFields);
  await reportBudget(context, partyBudget);
  const { rows: [ledger] } = await context.client.query('SELECT 1 FROM ledger WHERE company_id = $1 AND id = $2', [context.company.companyId, ledgerId]);
  if (!ledger) throw ledgerNotFound;
  const offered = await states(context, [ledgerId], asOf, listScope === 'all' ? 'final' : 'pending', { datedBy: asOf });
  const key = (bill: BillState): string | bigint => ({ name: bill.name.toLowerCase(), bill_date: bill.billDate ?? '', due_date: bill.dueDate ?? '',
    pending: bill.pending, final_pending: bill.finalPending })[sort];
  const order = direction === 'asc' ? 1 : -1;
  return offered
    .sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.billId < b.billId ? -1 : 1) * order; })
    .map(({ ledgerId: _ledger, ledgerName: _name, method: _method, ...bill }) => ({ ...bill, side: bill.pending > 0n ? 'Dr' : bill.pending < 0n ? 'Cr' : null }));
}

/**
 * The credit-days check (observed): with the party's check on, starting a sales voucher warns with the number of its
 * bills pending on the debit side that are due on or before the voucher date; entry continues. Nothing when it is off,
 * and the screens ask only when a sales voucher starts (not on receipts).
 */
export async function creditCheck(context: LedgerContext, ledgerId: string, query: unknown): Promise<CreditCheck> {
  const { date } = parseInput(creditCheckQuery, query, queryFields);
  await reportBudget(context, partyBudget);
  const { rows: [ledger] } = await context.client.query<{ check: boolean }>(
    'SELECT bill_wise AND credit_days_check AS check FROM ledger WHERE company_id = $1 AND id = $2', [context.company.companyId, ledgerId]);
  if (!ledger) throw ledgerNotFound;
  if (!ledger.check) return { check: false, overdueBills: 0 };
  const overdue = (await states(context, [ledgerId], date, 'pending', { side: 'Dr' })).filter(bill => bill.dueDate !== null && bill.dueDate <= date);
  return { check: true, overdueBills: overdue.length };
}
