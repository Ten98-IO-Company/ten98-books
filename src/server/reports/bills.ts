import { addMoney, subtractMoney } from '@ten98/runtime';
import {
  ageingBucketsInput, ageingQuery, asOfQuery, creditCheckQuery, outstandingQuery, pickerQuery,
  type AgeingBucket, type AgeingParty, type AgeingReport, type BillDetailReport, type BillDetailRow, type BillPickerRow, type BillSide,
  type BillsOutstandingReport, type CreditCheck, type PartyBillsReport, type PendingBill,
} from '../../lib/bills.ts';
import { creatorDueSql, liveBillRowsSql, signedSql, storageOrderSql } from '../ledger/bills.ts';
import { ledgerError, parseInput, type LedgerContext } from '../ledger/context.ts';
import { countsSql, ledgerRows, reportBudget } from '../ledger/reports.ts';

/**
 * Bill read models (M2a slice 1). Pending amounts are signed sums of live bill rows dated on or before the date (opening
 * rows always count); a bill's date and due date come from its creating row, the first live row in storage order at
 * that date. On account is computed from the lines themselves (each live line's amount less its bill rows, plus the
 * opening balance less its opening bills), so bills plus on account equalling the ledger balance is a real check, not a
 * definition. Lists get the statements' 30-second budget, one party's screens the ledger screens' 20 seconds (D-09).
 */

const listBudget = 30, partyBudget = 20;
const fields = (labels: Record<string, string>) => (path: readonly PropertyKey[]) => labels[String(path[0])] ?? 'the report settings';
const queryFields = fields({ side: 'receivable or payable', groupId: 'the group', asOf: 'the date', basis: 'the ageing basis', date: 'the date',
  scope: 'the list scope', sort: 'the sort order', direction: 'the sort direction', buckets: 'the ageing columns' });
const ledgerNotFound = ledgerError(404, 'Ledger not found.', 'not_found');

type BillState = PendingBill;

/**
 * Bills of `ledgerIds` at `asOf`: pending (at the date) and final pending (all dates), with the creating row's dates.
 * Bills are kept when `keep` holds ('pending': non-zero at the date; 'final': non-zero at the date or over all dates; 'all'),
 * and filtered before the creating rows are chosen.
 */
async function billStates(context: LedgerContext, ledgerIds: string[], asOf: string, keep: 'pending' | 'final' | 'all'): Promise<BillState[]> {
  if (!ledgerIds.length) return [];
  const { rows } = await context.client.query<BillState>(
    `WITH live AS (${liveBillRowsSql} AND a.bill_id IS NOT NULL AND a.ledger_id = ANY($2::uuid[])),
     sums AS (
       SELECT bill_id, coalesce(sum(${signedSql('live')}) FILTER (WHERE opening OR row_date <= $3), 0)::bigint AS pending,
         sum(${signedSql('live')})::bigint AS final_pending
       FROM live GROUP BY bill_id),
     wanted AS (SELECT * FROM sums WHERE $4 = 'all' OR pending <> 0 OR ($4 = 'final' AND final_pending <> 0)),
     dated AS (SELECT DISTINCT ON (l.bill_id) l.* FROM live l JOIN wanted w USING (bill_id) WHERE l.opening OR l.row_date <= $3 ORDER BY l.bill_id, ${storageOrderSql}),
     first AS (SELECT DISTINCT ON (l.bill_id) l.* FROM live l JOIN wanted w USING (bill_id) ORDER BY l.bill_id, ${storageOrderSql}),
     creators AS (SELECT w.bill_id, coalesce(d.id, f.id) AS row_id FROM wanted w LEFT JOIN dated d USING (bill_id) LEFT JOIN first f USING (bill_id)),
     chosen AS (SELECT c.bill_id, r.kind, r.row_date, ${creatorDueSql('r')} AS due_date
       FROM creators c JOIN live r ON r.id = c.row_id)
     SELECT b.id AS "billId", b.name, b.ledger_id AS "ledgerId", led.name AS "ledgerName",
       to_char(ch.row_date, 'YYYY-MM-DD') AS "billDate", to_char(ch.due_date, 'YYYY-MM-DD') AS "dueDate",
       CASE ch.kind WHEN 'advance' THEN 'advance' ELSE 'new_ref' END AS method, w.pending, w.final_pending AS "finalPending",
       greatest(0, $3::date - ch.due_date)::int AS "overdueDays"
     FROM wanted w JOIN bill b ON b.company_id = $1 AND b.id = w.bill_id JOIN ledger led ON led.company_id = $1 AND led.id = b.ledger_id
       LEFT JOIN chosen ch ON ch.bill_id = w.bill_id
     ORDER BY lower(led.name), led.id, ch.row_date, lower(b.name), b.id`,
    [context.company.companyId, ledgerIds, asOf, keep]);
  return rows;
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

/** Pending on the side's natural side (debit for receivables, credit for payables) as a positive amount, else zero. */
const natural = (side: BillSide, pending: bigint) => side === 'receivable' ? (pending > 0n ? pending : 0n) : (pending < 0n ? subtractMoney(0n, pending) : 0n);

/** Bills receivable or payable at a date. Bills on the other side (advances, settlements left on their own) are not listed (observed). */
export async function billsOutstandingReport(context: LedgerContext, query: unknown): Promise<BillsOutstandingReport> {
  const { side, groupId, asOf } = parseInput(outstandingQuery, query, queryFields);
  await reportBudget(context, listBudget);
  const { group, ledgerIds } = await scope(context, side, groupId);
  let total = 0n;
  const bills = (await billStates(context, ledgerIds, asOf, 'pending')).flatMap(bill => {
    const amount = natural(side, bill.pending);
    if (amount === 0n) return [];
    total = addMoney(total, amount);
    return [{ ...bill, amount }];
  });
  return { asOf, side, group, bills, total };
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
  const bills = await billStates(context, [ledgerId], asOf, 'pending');
  const row = (await ledgerRows(context, context.company.booksBeginning, asOf, ledgerId)).rows.find(item => item.ledgerId === ledgerId)!;
  return { asOf, ledger, bills, onAccount: (await onAccount(context, [ledgerId], asOf)).get(ledgerId) ?? 0n, balance: subtractMoney(row.closingDebit, row.closingCredit) };
}

/** One bill's rows in storage order, the ones that count at the date with the running pending, the others marked. */
export async function billDetailReport(context: LedgerContext, billId: string, query: unknown): Promise<BillDetailReport> {
  const { asOf } = parseInput(asOfQuery, query, queryFields);
  await reportBudget(context, partyBudget);
  const { rows: [bill] } = await context.client.query<{ id: string; name: string; ledgerId: string; ledgerName: string }>(
    `SELECT b.id, b.name, b.ledger_id AS "ledgerId", l.name AS "ledgerName" FROM bill b JOIN ledger l ON l.company_id = b.company_id AND l.id = b.ledger_id
     WHERE b.company_id = $1 AND b.id = $2`, [context.company.companyId, billId]);
  if (!bill) throw ledgerError(404, 'Bill not found.', 'not_found');
  const { rows } = await context.client.query<Omit<BillDetailRow, 'method' | 'pending'> & { counts: boolean }>(
    `SELECT a.voucher_id AS "voucherId", t.name AS "voucherTypeName", v.number, to_char(coalesce(a.bill_date, v.date), 'YYYY-MM-DD') AS date,
       a.kind, a.side, a.amount,
       CASE WHEN a.voucher_id IS NULL THEN 'opening' WHEN v.deleted_at IS NOT NULL THEN 'deleted' ELSE v.status END AS status,
       (a.voucher_id IS NULL OR (v.status = 'regular' AND v.deleted_at IS NULL AND v.date <= $3)) AS counts
     FROM bill_allocation a LEFT JOIN voucher v ON v.company_id = a.company_id AND v.id = a.voucher_id
       LEFT JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id
     WHERE a.company_id = $1 AND a.bill_id = $2
     ORDER BY (a.voucher_id IS NULL) DESC, v.created_at, a.voucher_id, a.line_no, a.id`, [context.company.companyId, billId, asOf]);
  const [state] = await billStates(context, [bill.ledgerId], asOf, 'all').then(states => states.filter(item => item.billId === billId));
  let running = 0n, creatorSeen = false;
  const shown = rows.map(({ counts, ...row }): BillDetailRow => {
    if (!counts) return { ...row, method: row.kind, pending: null };
    running = addMoney(running, row.side === 'Dr' ? row.amount : subtractMoney(0n, row.amount));
    const method = creatorSeen ? 'against_ref' : row.kind === 'advance' ? 'advance' : 'new_ref';
    creatorSeen = true;
    return { ...row, method: row.kind === 'on_account' ? 'on_account' : method, pending: running };
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
 * columns. By due date, bills not yet due have their own column (an assumption until observed). Advances and on-account
 * amounts are not aged (observed).
 */
export async function ageingReport(context: LedgerContext, query: unknown): Promise<AgeingReport> {
  const { side, groupId, asOf, basis } = parseInput(ageingQuery, query, queryFields);
  await reportBudget(context, listBudget);
  const { group, ledgerIds } = await scope(context, side, groupId);
  const buckets = await readAgeingBuckets(context);
  const parties = new Map<string, AgeingParty>();
  const blank = (): Omit<AgeingParty, 'ledgerId' | 'name'> => ({ notDue: basis === 'due' ? 0n : null, buckets: buckets.map(() => 0n), total: 0n });
  const totals = blank();
  const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  for (const bill of await billStates(context, ledgerIds, asOf, 'pending')) {
    const amount = natural(side, bill.pending);
    if (amount === 0n) continue;
    const party = parties.get(bill.ledgerId) ?? { ledgerId: bill.ledgerId, name: bill.ledgerName, ...blank() };
    parties.set(bill.ledgerId, party);
    const from = basis === 'bill' ? bill.billDate : bill.dueDate;
    const days = from === null ? 0 : dayOf(asOf) - dayOf(from);
    if (basis === 'due' && days <= 0) {
      party.notDue = addMoney(party.notDue!, amount);
      totals.notDue = addMoney(totals.notDue!, amount);
    } else {
      const index = bucketIndex(buckets, Math.max(days, 0));
      if (index >= 0) {
        party.buckets[index] = addMoney(party.buckets[index], amount);
        totals.buckets[index] = addMoney(totals.buckets[index], amount);
      }
    }
    party.total = addMoney(party.total, amount);
    totals.total = addMoney(totals.total, amount);
  }
  return { asOf, side, basis, group, buckets, parties: [...parties.values()], totals };
}

/** The entry screen's pending list for one party: pending at the voucher date, the final pending, sorted as asked. */
export async function billPicker(context: LedgerContext, ledgerId: string, query: unknown): Promise<BillPickerRow[]> {
  const { asOf, scope: listScope, sort, direction } = parseInput(pickerQuery, query, queryFields);
  await reportBudget(context, partyBudget);
  const { rows: [ledger] } = await context.client.query('SELECT 1 FROM ledger WHERE company_id = $1 AND id = $2', [context.company.companyId, ledgerId]);
  if (!ledger) throw ledgerNotFound;
  const states = await billStates(context, [ledgerId], asOf, listScope === 'all' ? 'final' : 'pending');
  const key = (bill: BillState): string | bigint => ({ name: bill.name.toLowerCase(), bill_date: bill.billDate ?? '', due_date: bill.dueDate ?? '',
    pending: bill.pending, final_pending: bill.finalPending })[sort];
  const order = direction === 'asc' ? 1 : -1;
  return states
    .sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : a.billId < b.billId ? -1 : 1) * order; })
    .map(({ ledgerId: _ledger, ledgerName: _name, method: _method, ...bill }) => ({ ...bill, side: bill.pending > 0n ? 'Dr' : bill.pending < 0n ? 'Cr' : null }));
}

/**
 * The credit-days check (observed): with the party's check on, starting a sales voucher warns with the number of its
 * bills pending on the debit side whose due date is before the voucher date; entry continues. Nothing when it is off.
 */
export async function creditCheck(context: LedgerContext, ledgerId: string, query: unknown): Promise<CreditCheck> {
  const { date } = parseInput(creditCheckQuery, query, queryFields);
  await reportBudget(context, partyBudget);
  const { rows: [ledger] } = await context.client.query<{ check: boolean }>(
    'SELECT bill_wise AND credit_days_check AS check FROM ledger WHERE company_id = $1 AND id = $2', [context.company.companyId, ledgerId]);
  if (!ledger) throw ledgerNotFound;
  if (!ledger.check) return { check: false, overdueBills: 0 };
  const overdue = (await billStates(context, [ledgerId], date, 'pending')).filter(bill => bill.pending > 0n && bill.dueDate !== null && bill.dueDate < date);
  return { check: true, overdueBills: overdue.length };
}
