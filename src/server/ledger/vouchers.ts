import { createHash } from 'node:crypto';
import { addMoney, assertMoneyInRange, compareMoney, formatMoney } from '@ten98/runtime';
import { isCalendarDate } from '../../lib/company.ts';
import {
  revisionInput, voucherAlterInput, voucherCreateInput, voucherListQuery,
  type BillRow, type BillRowInput, type BillWarning, type CreditPeriod, type CreditUnit, type Side, type Voucher, type VoucherKind,
  type VoucherLine, type VoucherPage, type VoucherSummary, type VoucherType,
} from '../../lib/ledger.ts';
import { billsCreatedBy, billWarnings, planBills, storedBillRows, writeBills, type BillLine, type BillPlan } from './bills.ts';
import { conflict, ledgerError, parseAmount, parseInput, type LedgerContext } from './context.ts';
import { groupTreeSql, missingAs, readVoucherType } from './masters.ts';
import { logRevision } from './revisions.ts';

/**
 * Voucher posting rules (D-04, D-09). Rules are checked here with plain-language refusals; the database repeats the
 * ones that matter for integrity (balance, two lines, positive amounts, the number lifecycle) so no path can commit a
 * voucher that breaks them. Posting transactions stay short: reads and checks first, writes next, the numbering
 * counter last.
 */

const voucherNotFound = ledgerError(404, 'Voucher not found.', 'not_found');

const voucherFields = (path: readonly PropertyKey[]): string => {
  const [first, index, inner] = path;
  if (first === 'lines' && typeof index === 'number') {
    if (inner === 'bills') return `the bill rows on line ${index + 1}`;
    return `the ${inner === 'ledgerId' ? 'ledger' : inner === 'side' ? 'Dr or Cr side' : 'amount'} on line ${index + 1}`;
  }
  return ({ idempotencyKey: 'the idempotency key', voucherTypeId: 'the voucher type', date: 'the date', narration: 'the narration',
    status: 'the status', postDated: 'the post-dated setting', reference: 'the reference', referenceDate: 'the reference date',
    lines: 'the lines', revision: 'the revision' } as Record<string, string>)[String(first)] ?? 'the voucher details';
};

const headerSelect = `SELECT v.id, v.voucher_type_id AS "voucherTypeId", t.name AS "voucherTypeName", t.kind, v.series, v.number, v.date,
    v.narration, v.status, v.post_dated AS "postDated", v.deleted_at IS NOT NULL AS deleted, v.revision,
    v.reference, v.reference_date AS "referenceDate",
    coalesce((SELECT sum(x.amount) FROM voucher_line x WHERE x.company_id = v.company_id AND x.voucher_id = v.id AND x.side = 'Dr'), 0)::bigint AS total
  FROM voucher v JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id
  WHERE v.company_id = $1`;

/** One voucher with its lines, including cancelled and soft-deleted ones (their history stays readable). */
export async function readVoucher(context: LedgerContext, voucherId: string, lock = false): Promise<Voucher> {
  const { client, company } = context;
  if (lock) await client.query('SELECT 1 FROM voucher WHERE company_id = $1 AND id = $2 FOR UPDATE', [company.companyId, voucherId]);
  const { rows } = await client.query<VoucherSummary>(`${headerSelect} AND v.id = $2`, [company.companyId, voucherId]);
  if (!rows[0]) throw voucherNotFound;
  const lines = await client.query<Omit<VoucherLine, 'bills'>>(
    `SELECT l.line_no AS "lineNo", l.ledger_id AS "ledgerId", led.name AS "ledgerName", l.side, l.amount, l.currency,
       l.currency_amount AS "currencyAmount", l.fx_rate::text AS "fxRate"
     FROM voucher_line l JOIN ledger led ON led.company_id = l.company_id AND led.id = l.ledger_id
     WHERE l.company_id = $1 AND l.voucher_id = $2 ORDER BY l.line_no`, [company.companyId, voucherId]);
  const bills = await client.query<Omit<BillRow, 'creditPeriod'> & { lineNo: number; creditCount: number | null; creditUnit: CreditUnit | null }>(
    `SELECT a.line_no AS "lineNo", a.kind, a.bill_id AS "billId", b.name AS "billName", a.side, a.amount, a.due_date AS "dueDate",
       a.credit_count AS "creditCount", a.credit_unit AS "creditUnit"
     FROM bill_allocation a LEFT JOIN bill b ON b.company_id = a.company_id AND b.id = a.bill_id
     WHERE a.company_id = $1 AND a.voucher_id = $2 ORDER BY a.line_no, a.id`, [company.companyId, voucherId]);
  const byLine = new Map<number, BillRow[]>();
  for (const { lineNo, creditCount, creditUnit, ...row } of bills.rows) {
    const list = byLine.get(lineNo) ?? [];
    list.push({ ...row, creditPeriod: creditCount !== null && creditUnit !== null ? { count: creditCount, unit: creditUnit } : null });
    byLine.set(lineNo, list);
  }
  return { ...rows[0], lines: lines.rows.map(line => ({ ...line, bills: byLine.get(line.lineNo) ?? [] })) };
}

const cursorShape = /^(\d{4}-\d{2}-\d{2})~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const encodeCursor = (voucher: VoucherSummary) => Buffer.from(`${voucher.date}~${voucher.id}`).toString('base64url');
function decodeCursor(cursor: string): [date: string, id: string] {
  const match = cursorShape.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match || !isCalendarDate(match[1])) throw ledgerError(400, 'Check the page cursor and try again.', 'validation');
  return [match[1], match[2]];
}

/**
 * One page of the undeleted vouchers dated within the period, in date order and, within a day, in entry order (ids are
 * time-ordered UUIDv7). Keyset pagination on (date, id): `next` is the cursor for the following page, or null.
 * Numbers are not the key: they repeat per voucher type and financial year, and optional vouchers have none.
 */
export async function listVouchers(context: LedgerContext, value: unknown): Promise<VoucherPage> {
  const query = parseInput(voucherListQuery, value, path => ({ from: 'the start date', to: 'the end date', limit: 'the page size', after: 'the page cursor' } as Record<string, string>)[String(path[0])] ?? 'the period');
  const [afterDate, afterId] = query.after ? decodeCursor(query.after) : [null, null];
  const { rows } = await context.client.query<VoucherSummary>(
    `${headerSelect} AND v.deleted_at IS NULL AND v.date BETWEEN $2 AND $3 AND ($4::date IS NULL OR (v.date, v.id) > ($4::date, $5::uuid))
     ORDER BY v.date, v.id LIMIT $6`, [context.company.companyId, query.from, query.to, afterDate, afterId, query.limit + 1]);
  const vouchers = rows.slice(0, query.limit);
  return { vouchers, next: rows.length > query.limit ? encodeCursor(vouchers[vouchers.length - 1]) : null };
}

/** D-09: nothing is created, altered, cancelled or deleted before the books begin or on or before the locked-through date. */
function assertDateOpen(context: LedgerContext, date: string): void {
  const { booksBeginning, lockedThrough } = context.company;
  if (date < booksBeginning) throw ledgerError(400, `The date ${date} is before the books begin on ${booksBeginning}.`, 'before_books_beginning');
  if (lockedThrough !== null && date <= lockedThrough) throw ledgerError(409, `The books are locked through ${lockedThrough}. Choose a later date or ask an owner to unlock the period.`, 'locked_period');
}

type PreparedLine = BillLine;
type LineInput = { ledgerId: string; side: Side; amount: string; bills?: BillRowInput[] };

/**
 * Applies the posting rules to a voucher body and returns its lines in minor units. Contra moves money between cash and
 * bank ledgers only; a payment credits, and a receipt debits, at least one cash or bank ledger and may use cash or bank
 * on its other side too (observed at save on the entry screens). A journal, sales, purchase and the two notes accept any ledgers, cash and bank included (observed: the
 * journal entry list only hides cash and bank until asked to show more; hiding them is the entry screen's job).
 */
async function prepareLines(context: LedgerContext, kind: VoucherKind, body: { date: string; lines: LineInput[] }): Promise<PreparedLine[]> {
  const { client, company } = context;
  assertDateOpen(context, body.date);
  if (body.lines.length < 2) throw ledgerError(400, 'A voucher needs at least two lines.', 'unbalanced');
  const lines = body.lines.map((line, index): PreparedLine => {
    const amount = parseAmount(line.amount, company.exponent, `The amount on line ${index + 1}`);
    if (amount <= 0n) throw ledgerError(400, `The amount on line ${index + 1} must be more than zero.`, 'validation');
    return { lineNo: index + 1, ledgerId: line.ledgerId, side: line.side, amount, billWise: false, credit: null, bills: line.bills };
  });
  let debit = 0n, credit = 0n;
  for (const line of lines) if (line.side === 'Dr') debit = addMoney(debit, line.amount); else credit = addMoney(credit, line.amount);
  try { assertMoneyInRange(debit); assertMoneyInRange(credit); }
  catch { throw ledgerError(400, 'The voucher total is too large.', 'validation'); }
  if (compareMoney(debit, credit) !== 0) {
    throw ledgerError(400, `Debits (${formatMoney(debit, company.exponent)}) and credits (${formatMoney(credit, company.exponent)}) must be equal.`, 'unbalanced');
  }

  // Key-share the ledgers in id order before anything else locks them: a concurrent nature change locks the same rows
  // in the same order (and waits for this posting), so the two never deadlock.
  const ledgerIds = [...new Set(lines.map(line => line.ledgerId))].sort();
  await client.query('SELECT 1 FROM ledger WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE', [company.companyId, ledgerIds]);
  const { rows } = await client.query<{ id: string; cash_bank: boolean; bill_wise: boolean; credit: CreditPeriod | null }>(
    `WITH RECURSIVE ${groupTreeSql}
     SELECT l.id, coalesce(t.cash_bank, false) AS cash_bank, l.bill_wise,
       CASE WHEN l.credit_count IS NOT NULL THEN json_build_object('count', l.credit_count, 'unit', l.credit_unit)
         WHEN l.credit_due_date IS NOT NULL THEN json_build_object('dueDate', l.credit_due_date) END AS credit
     FROM ledger l LEFT JOIN tree t ON t.id = l.group_id
     WHERE l.company_id = $1 AND l.id = ANY($2::uuid[])`, [company.companyId, ledgerIds]);
  const cashBank = new Map(rows.map(row => [row.id, row.cash_bank]));
  const missing = lines.find(line => !cashBank.has(line.ledgerId));
  if (missing) throw ledgerError(400, `The ledger on line ${missing.lineNo} was not found in this company.`, 'not_found');
  const facts = new Map(rows.map(row => [row.id, row]));
  for (const line of lines) {
    const fact = facts.get(line.ledgerId)!;
    line.billWise = fact.bill_wise;
    line.credit = fact.credit;
  }

  const isCash = (line: PreparedLine) => cashBank.get(line.ledgerId) === true;
  const refuse = (message: string) => { throw ledgerError(400, message, 'posting_rule'); };
  const first = (match: (line: PreparedLine) => boolean) => lines.find(match)?.lineNo;
  if (kind === 'contra') {
    const other = first(line => !isCash(line));
    if (other) refuse(`A contra voucher moves money between cash and bank ledgers only; line ${other} uses another ledger.`);
  } else if (kind === 'payment' || kind === 'receipt') {
    const [paidFrom, word] = kind === 'payment' ? ['Cr', 'credit'] : ['Dr', 'debit'];
    if (!lines.some(line => line.side === paidFrom && isCash(line))) refuse(`A ${kind} must ${word} at least one cash or bank ledger.`);
  }
  return lines;
}

async function insertLines(context: LedgerContext, voucherId: string, lines: PreparedLine[]): Promise<void> {
  const { company } = context;
  // M1 posts in the base currency at rate 1, so the transaction amount equals the base amount.
  await context.client.query(
    `INSERT INTO voucher_line (company_id, voucher_id, line_no, ledger_id, side, amount, currency, currency_amount, fx_rate)
     SELECT $1, $2, t.line_no, t.ledger_id, t.side, t.amount, $3, t.amount, 1
     FROM unnest($4::smallint[], $5::uuid[], $6::text[], $7::bigint[]) AS t(line_no, ledger_id, side, amount)`,
    [company.companyId, voucherId, company.baseCurrency, lines.map(line => line.lineNo), lines.map(line => line.ledgerId), lines.map(line => line.side), lines.map(line => line.amount)]);
}

/**
 * Issues the next number of the voucher's type and series in the numbering period of its date (the voucher type's
 * restart rule in force on the date decides, `ledger_numbering_rule` in the database), then stores the number and
 * the period on the voucher. A period's counter starts at the rule's starting number. The counter row stays locked until commit, so
 * concurrent postings of the same series and period queue here, and only here; a rolled back posting returns its
 * number. The counter never rewinds: a number deleted at the end of a period stays used, and the next voucher dated in
 * that period, entered whenever, takes the number after it. Two statements, so the database's number check sees the
 * counter row this transaction has just written.
 */
async function issueNumber(context: LedgerContext, voucher: { id: string; date: string; typeId: string; series: string }): Promise<number> {
  const { client, company } = context;
  const { rows } = await client.query<{ last_number: number; period_start: string }>(
    `INSERT INTO voucher_counter (company_id, voucher_type_id, series, period_start, last_number)
     SELECT $1, $2, $3, r.period_start, r.starting_number FROM ledger_numbering_rule($1, $2, $4::date) r
     ON CONFLICT (company_id, voucher_type_id, series, period_start) DO UPDATE SET last_number = voucher_counter.last_number + 1
     RETURNING last_number, to_char(period_start, 'YYYY-MM-DD') AS period_start`, [company.companyId, voucher.typeId, voucher.series, voucher.date]);
  await client.query('UPDATE voucher SET number = $3, number_period = $4 WHERE company_id = $1 AND id = $2',
    [company.companyId, voucher.id, rows[0].last_number, rows[0].period_start]);
  return rows[0].last_number;
}

/** Whether an alter moves a numbered voucher's date into another numbering period, so that it takes a new number. */
async function movesPeriod(context: LedgerContext, before: Voucher, date: string): Promise<boolean> {
  if (before.number === null || date === before.date) return false;
  const { rows } = await context.client.query<{ moves: boolean }>(
    `SELECT ledger_numbering_period(company_id, voucher_type_id, $3::date) IS DISTINCT FROM number_period AS moves
     FROM voucher WHERE company_id = $1 AND id = $2`, [context.company.companyId, before.id, date]);
  return rows[0].moves;
}

const requestHash = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

/** A posting's answer: the voucher plus what happened to its bill rows that the caller may not expect. */
export type VoucherResult = { voucher: Voucher; warnings: BillWarning[] };

/**
 * Writes the voucher's bill rows in the lock order: rows named now (and their new bills) before the counter, then the
 * number, then the rows named by that number (a new reference left unnamed on a voucher numbered now). The number is
 * issued through `issueNumber` only; `numbering` is false when the voucher keeps the number it has or stays optional.
 */
async function writeVoucherBills(context: LedgerContext, voucher: { id: string; date: string; typeId: string; series: string }, plan: BillPlan, numbering: boolean, number: number | null): Promise<number | null> {
  const later = plan.rows.filter(row => row.auto);
  await writeBills(context, voucher, plan.rows.filter(row => !row.auto));
  const issued = numbering ? await issueNumber(context, voucher) : number;
  if (later.length) await writeBills(context, voucher, later, issued);
  return issued;
}

/**
 * Posts a new voucher. The idempotency key is unique per company: the same key with the same body returns the first
 * result (`replayed`), the same key with a different body is refused. A transaction-scoped lock on the key makes a
 * concurrent retry wait for the first attempt instead of racing it.
 */
export async function createVoucher(context: LedgerContext, value: unknown): Promise<VoucherResult & { replayed: boolean }> {
  const { client, company, userId } = context;
  const { idempotencyKey, ...body } = parseInput(voucherCreateInput, value, voucherFields);
  const hash = requestHash(body);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`voucher:${company.companyId}:${idempotencyKey}`]);
  const prior = await client.query<{ id: string; request_hash: string }>('SELECT id, request_hash FROM voucher WHERE company_id = $1 AND idempotency_key = $2', [company.companyId, idempotencyKey]);
  if (prior.rows[0]) {
    if (prior.rows[0].request_hash !== hash) throw ledgerError(409, 'This idempotency key was already used for a different voucher. Send a new key for a new voucher.', 'idempotency_mismatch');
    return { voucher: await readVoucher(context, prior.rows[0].id), replayed: true, warnings: [] };
  }
  const type: VoucherType = await readVoucherType(context, body.voucherTypeId).catch(missingAs(ledgerError(400, 'The voucher type was not found.', 'not_found')));
  const lines = await prepareLines(context, type.kind, body);
  const plan = await planBills(context, { kind: type.kind, reference: body.reference, optional: body.status === 'optional' }, lines);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO voucher (company_id, voucher_type_id, series, date, narration, status, post_dated, reference, reference_date, idempotency_key, request_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [company.companyId, type.id, type.numberingSeries, body.date, body.narration, body.status, body.postDated, body.reference, body.referenceDate, idempotencyKey, hash, userId]);
  const voucherId = rows[0].id;
  await insertLines(context, voucherId, lines);
  // An optional voucher takes no number until it is made regular.
  await writeVoucherBills(context, { id: voucherId, date: body.date, typeId: type.id, series: type.numberingSeries }, plan, body.status === 'regular', null);
  const voucher = await readVoucher(context, voucherId);
  await logRevision(context, 'voucher', voucherId, 'create', null, voucher);
  return { voucher, replayed: false, warnings: [...plan.warnings, ...await billWarnings(context, voucherId, plan.rows)] };
}

/** The voucher, locked, if it may still change: not deleted and at the revision the editor read. */
async function changeable(context: LedgerContext, voucherId: string, revision: number): Promise<Voucher> {
  const before = await readVoucher(context, voucherId, true);
  if (before.deleted) throw voucherNotFound;
  if (before.revision !== revision) throw conflict('voucher');
  return before;
}

/**
 * Replaces a voucher's date, narration, reference, flags, lines and bill rows. The type and series never change; the
 * number stays while the date stays in its numbering period, and a date moved into another period takes that period's
 * next number at the counter step (the database checks at commit that the number is of its date's period). An
 * optional voucher made regular takes the next
 * number of the period of its (new) date, and a numbered voucher cannot become optional again. Each row finds its bill
 * by name again, so an unchanged name keeps the bill; a renamed reference or a changed
 * party leaves other vouchers' rows on the old bill, which then stands on its own (observed; answered with
 * `bill_split`). A line whose ledger is no longer bill-wise keeps the rows it had (`bills_kept`).
 */
export async function alterVoucher(context: LedgerContext, voucherId: string, value: unknown): Promise<VoucherResult> {
  const { client, company } = context;
  const input = parseInput(voucherAlterInput, value, voucherFields);
  const before = await changeable(context, voucherId, input.revision);
  if (before.status === 'cancelled') throw ledgerError(409, 'A cancelled voucher cannot be altered.', 'voucher_state');
  if (before.status !== 'optional' && input.status === 'optional') throw ledgerError(409, 'A numbered voucher cannot become optional. Cancel or delete it instead.', 'voucher_state');
  assertDateOpen(context, before.date);
  const crossing = await movesPeriod(context, before, input.date);
  const lines = await prepareLines(context, before.kind, input);
  const stored = await storedBillRows(context, voucherId);
  const plan = await planBills(context, { kind: before.kind, reference: input.reference, optional: input.status === 'optional' }, lines, stored);
  const created = await billsCreatedBy(context, voucherId);
  await client.query(
    `UPDATE voucher SET date = $3, narration = $4, status = $5, post_dated = $6, reference = $7, reference_date = $8, revision = revision + 1, updated_at = now()
     WHERE company_id = $1 AND id = $2`,
    [company.companyId, voucherId, input.date, input.narration, input.status, input.postDated, input.reference, input.referenceDate]);
  await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2', [company.companyId, voucherId]);
  await insertLines(context, voucherId, lines);
  const numbering = (before.status === 'optional' && input.status === 'regular') || crossing;
  await writeVoucherBills(context, { id: voucherId, date: input.date, typeId: before.voucherTypeId, series: before.series }, plan, numbering, before.number);
  const after = await readVoucher(context, voucherId);
  await logRevision(context, 'voucher', voucherId, 'alter', before, after);
  const held = new Set(stored.flatMap(row => row.billId ? [row.billId] : []));
  return { voucher: after, warnings: [...plan.warnings, ...await billWarnings(context, voucherId, plan.rows, created, held)] };
}

/**
 * A cancelled voucher keeps its number and its row (and lines and bill rows, for the record) but has no accounting
 * effect; its settlements of other vouchers' bills stop counting and bills it created stand on their remaining rows.
 */
export async function cancelVoucher(context: LedgerContext, voucherId: string, value: unknown): Promise<VoucherResult> {
  const input = parseInput(revisionInput, value, voucherFields);
  const before = await changeable(context, voucherId, input.revision);
  if (before.status === 'cancelled') throw ledgerError(409, 'This voucher is already cancelled.', 'voucher_state');
  if (before.status === 'optional') throw ledgerError(409, 'An optional voucher has no number to keep. Delete it instead.', 'voucher_state');
  assertDateOpen(context, before.date);
  const created = await billsCreatedBy(context, voucherId);
  await context.client.query(`UPDATE voucher SET status = 'cancelled', revision = revision + 1, updated_at = now() WHERE company_id = $1 AND id = $2`, [context.company.companyId, voucherId]);
  const after = await readVoucher(context, voucherId);
  await logRevision(context, 'voucher', voucherId, 'cancel', before, after);
  return { voucher: after, warnings: await billWarnings(context, voucherId, [], created) };
}

/** Soft delete: the row stays for the revision log and its number stays used, so the gap is permanent. */
export async function deleteVoucher(context: LedgerContext, voucherId: string, value: unknown): Promise<{ warnings: BillWarning[] }> {
  const input = parseInput(revisionInput, value, voucherFields);
  const before = await changeable(context, voucherId, input.revision);
  assertDateOpen(context, before.date);
  const created = await billsCreatedBy(context, voucherId);
  await context.client.query('UPDATE voucher SET deleted_at = now(), deleted_by = $3, revision = revision + 1, updated_at = now() WHERE company_id = $1 AND id = $2',
    [context.company.companyId, voucherId, context.userId]);
  await logRevision(context, 'voucher', voucherId, 'delete', before, await readVoucher(context, voucherId));
  return { warnings: await billWarnings(context, voucherId, [], created) };
}
