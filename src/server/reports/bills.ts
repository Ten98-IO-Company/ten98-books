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
type StateOptions = {
  /** Only bills pending on this side at the date (Dr: receivables' natural side). */
  side?: 'Dr' | 'Cr';
  /** Only bills dated on or before this date (the pending list offered for a voucher of that date). */
  datedBy?: string;
  /** Only these bills. */
  billIds?: string[];
};

/**
 * Bills of `ledgerIds` at `asOf`: pending (at the date) and final pending (all dates), with the dating row's dates, by
 * party, bill date and name. Bills are kept when `keep` holds ('pending': non-zero at the date; 'final': non-zero at the
 * date or over all dates; 'all'), filtered before the dating rows are chosen.
 */
async function billStates(context: LedgerContext, ledgerIds: string[], asOf: string, keep: 'pending' | 'final' | 'all', options: StateOptions = {}): Promise<BillState[]> {
  if (!ledgerIds.length) return [];
  const { rows } = await context.client.query<BillState>(
    // Given bills are read by their ids alone (an optional condition inside an OR is no index condition, and the planner
    // then read every bill row of the ledgers); otherwise every bill row of the ledgers.
    `WITH live AS (${liveBillRowsSql(options.billIds ? 'a.bill_id = ANY($7::uuid[]) AND a.ledger_id = ANY($2::uuid[])' : 'a.bill_id IS NOT NULL AND a.ledger_id = ANY($2::uuid[]) AND $7::uuid[] IS NULL')}),
     sums AS (
       SELECT bill_id, coalesce(sum(${signedSql('live')}) FILTER (WHERE opening OR row_date <= $3), 0)::bigint AS pending,
         sum(${signedSql('live')})::bigint AS final_pending
       FROM live GROUP BY bill_id),
     wanted AS (SELECT * FROM sums WHERE ($4 = 'all' OR pending <> 0 OR ($4 = 'final' AND final_pending <> 0))
       AND ($5::text IS NULL OR ($5 = 'Dr' AND pending > 0) OR ($5 = 'Cr' AND pending < 0))),
     chosen AS (SELECT DISTINCT ON (l.bill_id) l.bill_id, l.kind, l.row_date, ${creatorDueSql('l')} AS due_date
       FROM live l JOIN wanted w USING (bill_id) ORDER BY l.bill_id, ${creatorOrderSql})
     SELECT b.id AS "billId", b.name, b.ledger_id AS "ledgerId", led.name AS "ledgerName", to_char(ch.row_date, 'YYYY-MM-DD') AS "billDate",
       to_char(ch.due_date, 'YYYY-MM-DD') AS "dueDate", CASE ch.kind WHEN 'advance' THEN 'advance' ELSE 'new_ref' END AS method,
       w.pending, w.final_pending AS "finalPending", greatest(0, $3::date - ch.due_date)::int AS "overdueDays"
     FROM wanted w
       -- Each wanted bill by its key (a join could read every bill of the company while the table has no statistics).
       -- By id alone (bill_id_idx; the ledgers name the company and the row-level policy filters as everywhere).
       CROSS JOIN LATERAL (SELECT x.id, x.name, x.name_key, x.ledger_id FROM bill x WHERE x.id = w.bill_id AND x.ledger_id = ANY($2::uuid[]) LIMIT 1) b
       JOIN ledger led ON led.company_id = $1 AND led.id = b.ledger_id
       JOIN chosen ch ON ch.bill_id = w.bill_id
     WHERE $6::date IS NULL OR ch.row_date <= $6
     ORDER BY lower(led.name), led.id, ch.row_date, b.name_key, b.id`,
    [context.company.companyId, ledgerIds, asOf, keep, options.side ?? null, options.datedBy ?? null, options.billIds ?? null]);
  return rows;
}
const states = billStates;

/**
 * The keyset of the bills receivable or payable list: party name, party, the bill's stored match key (`name_key`: the
 * name as the reference compares it) and bill.
 */
type PageKey = [party: string, ledgerId: string, name: string, billId: string];
const encodeKey = (key: PageKey) => Buffer.from(JSON.stringify(key)).toString('base64url');
function decodeKey(cursor: string | undefined): PageKey | undefined {
  if (cursor === undefined) return undefined;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown;
    if (Array.isArray(key) && key.length === 4 && key.every(part => typeof part === 'string') && /^[0-9a-f-]{36}$/.test(key[1]) && /^[0-9a-f-]{36}$/.test(key[3])) return key as PageKey;
  } catch { /* refused below */ }
  throw ledgerError(400, 'Check the page cursor and try again.', 'validation');
}

/**
 * One page of the bills pending on `side` at `asOf`, in list order (party name, party, bill name): parties are taken in
 * order, and each party's bills from the cursor in key order (bill_ledger_order_idx on the stored key `name_key`, by
 * ledger alone: the ledger implies the company), each with its pending summed from its own rows, until the page is full.
 * The keyset compares the plain stored column, so under the row-level policy it is an index condition and the page
 * seeks to the cursor. With statistics on bill, a page reads the bills it returns, the settled ones it passes and one
 * bill of each party in scope (the parties probe); without them the planner may read the party's bills from the cursor
 * to the party's end (LEDGER.md, "Known limits").
 */
async function pendingPage(context: LedgerContext, ledgerIds: string[], asOf: string, side: 'Dr' | 'Cr', after: PageKey | undefined, limit: number) {
  const { client, company } = context;
  const { rows: parties } = await client.query<{ id: string; key: string }>(
    `SELECT id, lower(name) AS key FROM ledger WHERE company_id = $1 AND id = ANY($2::uuid[])
       AND ($3::text IS NULL OR (lower(name), id) >= ($3, $4::uuid)) ORDER BY lower(name), id`,
    [company.companyId, ledgerIds, after?.[0] ?? null, after?.[1] ?? null]);
  const page: { billId: string; ledgerId: string; key: PageKey }[] = [];
  for (const party of parties) {
    const from = after && party.id === after[1] ? after : null;
    const { rows } = await client.query<{ billId: string; name: string }>(
      `SELECT b.id AS "billId", b.name_key AS name FROM bill b
         CROSS JOIN LATERAL (SELECT coalesce(sum(${signedSql('r')}) FILTER (WHERE r.opening OR r.row_date <= $4), 0) AS pending
           FROM (${liveBillRowsSql('a.bill_id = b.id')}) r) s
       WHERE b.ledger_id = $2
         AND ($3::text IS NULL OR (b.name_key, b.id) > ($3::text, $7::uuid))
         AND (($5 = 'Dr' AND s.pending > 0) OR ($5 = 'Cr' AND s.pending < 0))
       ORDER BY b.name_key, b.id LIMIT $6`,
      [company.companyId, party.id, from?.[2] ?? null, asOf, side, limit + 1 - page.length, from?.[3] ?? null]);
    page.push(...rows.map(row => ({ billId: row.billId, ledgerId: party.id, key: [party.key, party.id, row.name, row.billId] as PageKey })));
    if (page.length > limit) break;
  }
  return { page: page.slice(0, limit), more: page.length > limit };
}

/** The total pending on `side` over every bill of `ledgerIds` at `asOf` (signed). */
async function pendingTotal(context: LedgerContext, ledgerIds: string[], asOf: string, side: 'Dr' | 'Cr'): Promise<bigint> {
  if (!ledgerIds.length) return 0n;
  const { rows } = await context.client.query<{ total: bigint }>(
    `SELECT coalesce(sum(pending), 0)::bigint AS total FROM (
       SELECT sum(${signedSql('r')}) FILTER (WHERE r.opening OR r.row_date <= $3) AS pending
       FROM (${liveBillRowsSql('a.bill_id IS NOT NULL AND a.ledger_id = ANY($2::uuid[])')}) r GROUP BY r.bill_id) s
     WHERE ($4 = 'Dr' AND pending > 0) OR ($4 = 'Cr' AND pending < 0)`, [context.company.companyId, ledgerIds, asOf, side]);
  return rows[0].total;
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

/**
 * The groups a list covers and the ledgers below them that hold bills. By default both trade receivables and trade
 * payables, whichever list is asked for: a list holds the bills lying on its side, whatever the party's group
 * (observed: a customer's advance, a credit bill of a debtor, is listed under bills payable and not under bills
 * receivable). With `groupId`, that group alone.
 */
async function scope(context: LedgerContext, groupId: string | undefined): Promise<{ groups: { id: string; name: string }[]; ledgerIds: string[] }> {
  const { rows: groups } = await context.client.query<{ id: string; name: string }>(
    groupId ? 'SELECT id, name FROM account_group WHERE company_id = $1 AND id = $2'
      : "SELECT id, name FROM account_group WHERE company_id = $1 AND system_key = ANY('{receivables,payables}'::text[]) ORDER BY system_key DESC",
    groupId ? [context.company.companyId, groupId] : [context.company.companyId]);
  if (!groups.length) throw ledgerError(404, 'Group not found.', 'not_found');
  const { rows } = await context.client.query<{ id: string }>(
    `WITH RECURSIVE below(id) AS (SELECT unnest($2::uuid[]) UNION SELECT g.id FROM account_group g JOIN below b ON g.company_id = $1 AND g.parent_id = b.id)
     SELECT l.id FROM ledger l WHERE l.company_id = $1 AND l.group_id IN (SELECT id FROM below)
       -- By ledger alone (the ledger implies the company). A semi-join: at worst, with statistics older than the company's
       -- bills, it reads the company's bills once; a lookup per ledger then read them once per ledger without bills.
       AND EXISTS (SELECT 1 FROM bill b WHERE b.ledger_id = l.id)`, [context.company.companyId, groups.map(group => group.id)]);
  return { groups, ledgerIds: rows.map(row => row.id) };
}

const naturalSide = (side: BillSide) => side === 'receivable' ? 'Dr' as const : 'Cr' as const;
const positive = (amount: bigint) => amount < 0n ? subtractMoney(0n, amount) : amount;

/**
 * Bills receivable or payable at a date, a page at a time (`limit`, `after`; an export reads them all), by party and bill
 * name: the bills pending on the list's side, of the ledgers below both trade groups unless a group is given. A bill on
 * the other side (a customer's advance, a settlement left on its own) is in the other list (observed). The total of every
 * page comes with the first page only (a later page would have to read every bill again).
 */
export async function billsOutstandingReport(context: LedgerContext, query: unknown, all = false): Promise<BillsOutstandingReport> {
  const { side, groupId, asOf, limit, after } = parseInput(outstandingQuery, query, queryFields);
  await reportBudget(context, listBudget);
  const { groups, ledgerIds } = await scope(context, groupId);
  const pageSize = all ? exportLimit : limit;
  const cursor = all ? undefined : decodeKey(after);
  const { page, more } = await pendingPage(context, ledgerIds, asOf, naturalSide(side), cursor, pageSize);
  if (all && more) throw exportTooLarge;
  const details = new Map((await states(context, [...new Set(page.map(item => item.ledgerId))], asOf, 'all', { billIds: page.map(item => item.billId) }))
    .map(bill => [bill.billId, bill]));
  return {
    asOf, side, groups, total: cursor ? null : positive(await pendingTotal(context, ledgerIds, asOf, naturalSide(side))),
    bills: page.map(item => { const bill = details.get(item.billId)!; return { ...bill, amount: positive(bill.pending) }; }),
    next: more ? encodeKey(page[page.length - 1].key) : null,
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
  const { groups, ledgerIds } = await scope(context, groupId);
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
  return { asOf, side, basis, groups, buckets, parties: [...parties.values()], totals };
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
  // By name: the bill's stored match key (`name_key`, from `name_match_key`), compared as plain text like the lists.
  const keys = sort === 'name' ? new Map((await context.client.query<{ id: string; key: string }>(
    'SELECT id, name_key AS key FROM bill WHERE company_id = $1 AND id = ANY($2::uuid[])', [context.company.companyId, offered.map(bill => bill.billId)])).rows
    .map(row => [row.id, row.key])) : new Map<string, string>();
  const key = (bill: BillState): string | bigint => ({ name: keys.get(bill.billId) ?? '', bill_date: bill.billDate ?? '', due_date: bill.dueDate ?? '',
    pending: bill.pending, final_pending: bill.finalPending })[sort];
  const order = direction === 'asc' ? 1 : -1;
  const compare = (x: string | bigint, y: string | bigint) => x < y ? -1 : x > y ? 1 : 0;
  return offered
    .sort((a, b) => (compare(key(a), key(b)) || (a.billId < b.billId ? -1 : 1)) * order)
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
