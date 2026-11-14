import { createHash } from 'node:crypto';
import { addMoney, assertMoneyInRange, compareMoney, formatMoney } from '@ten98/runtime';
import {
  revisionInput, voucherAlterInput, voucherCreateInput,
  type Side, type Voucher, type VoucherKind, type VoucherLine, type VoucherSummary, type VoucherType,
} from '../../lib/ledger.ts';
import { FoundationError } from '../auth.ts';
import { conflict, parseAmount, parseInput, type LedgerContext } from './context.ts';
import { groupTreeSql, missingAs, readVoucherType } from './masters.ts';
import { logRevision } from './revisions.ts';

/**
 * Voucher posting rules (D-04, D-09). Rules are checked here with plain-language refusals; the database repeats the
 * ones that matter for integrity (balance, two lines, positive amounts, the number lifecycle) so no path can commit a
 * voucher that breaks them. Posting transactions stay short: reads and checks first, writes next, the numbering
 * counter last.
 */

const voucherNotFound = new FoundationError(404, 'Voucher not found.');

const voucherFields = (path: readonly PropertyKey[]): string => {
  const [first, index, inner] = path;
  if (first === 'lines' && typeof index === 'number') return `the ${inner === 'ledgerId' ? 'ledger' : inner === 'side' ? 'Dr or Cr side' : 'amount'} on line ${index + 1}`;
  return ({ idempotencyKey: 'the idempotency key', voucherTypeId: 'the voucher type', date: 'the date', narration: 'the narration',
    status: 'the status', postDated: 'the post-dated setting', lines: 'the lines', revision: 'the revision' } as Record<string, string>)[String(first)] ?? 'the voucher details';
};

const headerSelect = `SELECT v.id, v.voucher_type_id AS "voucherTypeId", t.name AS "voucherTypeName", t.kind, v.series, v.number, v.date,
    v.narration, v.status, v.post_dated AS "postDated", v.deleted_at IS NOT NULL AS deleted, v.revision,
    coalesce((SELECT sum(x.amount) FROM voucher_line x WHERE x.company_id = v.company_id AND x.voucher_id = v.id AND x.side = 'Dr'), 0)::bigint AS total
  FROM voucher v JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id
  WHERE v.company_id = $1`;

/** One voucher with its lines, including cancelled and soft-deleted ones (their history stays readable). */
export async function readVoucher(context: LedgerContext, voucherId: string, lock = false): Promise<Voucher> {
  const { client, company } = context;
  if (lock) await client.query('SELECT 1 FROM voucher WHERE company_id = $1 AND id = $2 FOR UPDATE', [company.companyId, voucherId]);
  const { rows } = await client.query<VoucherSummary>(`${headerSelect} AND v.id = $2`, [company.companyId, voucherId]);
  if (!rows[0]) throw voucherNotFound;
  const lines = await client.query<VoucherLine>(
    `SELECT l.line_no AS "lineNo", l.ledger_id AS "ledgerId", led.name AS "ledgerName", l.side, l.amount, l.currency,
       l.currency_amount AS "currencyAmount", l.fx_rate::text AS "fxRate"
     FROM voucher_line l JOIN ledger led ON led.company_id = l.company_id AND led.id = l.ledger_id
     WHERE l.company_id = $1 AND l.voucher_id = $2 ORDER BY l.line_no`, [company.companyId, voucherId]);
  return { ...rows[0], lines: lines.rows };
}

/** Vouchers dated within the period that are not deleted, in date order and, within a day, in entry order. */
export async function listVouchers(context: LedgerContext, from: string, to: string): Promise<VoucherSummary[]> {
  const { rows } = await context.client.query<VoucherSummary>(
    `${headerSelect} AND v.deleted_at IS NULL AND v.date BETWEEN $2 AND $3 ORDER BY v.date, v.created_at, v.id`, [context.company.companyId, from, to]);
  return rows;
}

/** D-09: nothing is created, altered, cancelled or deleted before the books begin or on or before the locked-through date. */
function assertDateOpen(context: LedgerContext, date: string): void {
  const { booksBeginning, lockedThrough } = context.company;
  if (date < booksBeginning) throw new FoundationError(400, `The date ${date} is before the books begin on ${booksBeginning}.`);
  if (lockedThrough !== null && date <= lockedThrough) throw new FoundationError(409, `The books are locked through ${lockedThrough}. Choose a later date or ask an owner to unlock the period.`);
}

type PreparedLine = { lineNo: number; ledgerId: string; side: Side; amount: bigint };
type LineInput = { ledgerId: string; side: Side; amount: string };

/**
 * Applies the posting rules to a voucher body and returns its lines in minor units. Contra moves money between cash and
 * bank ledgers only; a payment credits, and a receipt debits, at least one cash or bank ledger and never uses one on its
 * other side; a journal never touches cash or bank (those movements belong to the three types above). Sales, purchase
 * and the two notes accept any ledgers in M1.
 */
async function prepareLines(context: LedgerContext, kind: VoucherKind, body: { date: string; lines: LineInput[] }): Promise<PreparedLine[]> {
  const { client, company } = context;
  assertDateOpen(context, body.date);
  if (body.lines.length < 2) throw new FoundationError(400, 'A voucher needs at least two lines.');
  const lines = body.lines.map((line, index): PreparedLine => {
    const amount = parseAmount(line.amount, company.exponent, `The amount on line ${index + 1}`);
    if (amount <= 0n) throw new FoundationError(400, `The amount on line ${index + 1} must be more than zero.`);
    return { lineNo: index + 1, ledgerId: line.ledgerId, side: line.side, amount };
  });
  let debit = 0n, credit = 0n;
  for (const line of lines) if (line.side === 'Dr') debit = addMoney(debit, line.amount); else credit = addMoney(credit, line.amount);
  try { assertMoneyInRange(debit); assertMoneyInRange(credit); }
  catch { throw new FoundationError(400, 'The voucher total is too large.'); }
  if (compareMoney(debit, credit) !== 0) {
    throw new FoundationError(400, `Debits (${formatMoney(debit, company.exponent)}) and credits (${formatMoney(credit, company.exponent)}) must be equal.`);
  }

  const { rows } = await client.query<{ id: string; cash_bank: boolean }>(
    `WITH RECURSIVE ${groupTreeSql}
     SELECT l.id, coalesce(t.cash_bank, false) AS cash_bank FROM ledger l LEFT JOIN tree t ON t.id = l.group_id
     WHERE l.company_id = $1 AND l.id = ANY($2::uuid[])`, [company.companyId, [...new Set(lines.map(line => line.ledgerId))]]);
  const cashBank = new Map(rows.map(row => [row.id, row.cash_bank]));
  const missing = lines.find(line => !cashBank.has(line.ledgerId));
  if (missing) throw new FoundationError(400, `The ledger on line ${missing.lineNo} was not found in this company.`);

  const isCash = (line: PreparedLine) => cashBank.get(line.ledgerId) === true;
  const refuse = (message: string) => { throw new FoundationError(400, message); };
  const first = (match: (line: PreparedLine) => boolean) => lines.find(match)?.lineNo;
  if (kind === 'contra') {
    const other = first(line => !isCash(line));
    if (other) refuse(`A contra voucher moves money between cash and bank ledgers only; line ${other} uses another ledger.`);
  } else if (kind === 'payment' || kind === 'receipt') {
    const [paidFrom, word] = kind === 'payment' ? ['Cr', 'credit'] : ['Dr', 'debit'];
    if (!lines.some(line => line.side === paidFrom && isCash(line))) refuse(`A ${kind} must ${word} at least one cash or bank ledger.`);
    const wrong = first(line => line.side !== paidFrom && isCash(line));
    if (wrong) refuse(`A ${kind} cannot ${paidFrom === 'Cr' ? 'debit' : 'credit'} a cash or bank ledger (line ${wrong}). Use a contra voucher for transfers between them.`);
  } else if (kind === 'journal') {
    const cash = first(isCash);
    if (cash) refuse(`A journal cannot use a cash or bank ledger (line ${cash}). Use a payment, receipt or contra voucher.`);
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
 * Issues the next number of the voucher's type and series from its counter row and stores it, in one statement. The
 * counter row stays locked until commit, so concurrent postings of the same series queue here, and only here; a rolled
 * back posting returns its number, so issued numbers have no gaps except those deleted vouchers leave on purpose.
 */
async function issueNumber(context: LedgerContext, voucherId: string, voucherTypeId: string, series: string): Promise<number> {
  const { rows } = await context.client.query<{ number: number }>(
    `WITH issued AS (
       INSERT INTO voucher_counter (company_id, voucher_type_id, series, last_number) VALUES ($1, $2, $3, 1)
       ON CONFLICT (company_id, voucher_type_id, series) DO UPDATE SET last_number = voucher_counter.last_number + 1
       RETURNING last_number)
     UPDATE voucher SET number = (SELECT last_number FROM issued) WHERE company_id = $1 AND id = $4 RETURNING number`,
    [context.company.companyId, voucherTypeId, series, voucherId]);
  return rows[0].number;
}

const requestHash = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

/**
 * Posts a new voucher. The idempotency key is unique per company: the same key with the same body returns the first
 * result (`replayed`), the same key with a different body is refused. A transaction-scoped lock on the key makes a
 * concurrent retry wait for the first attempt instead of racing it.
 */
export async function createVoucher(context: LedgerContext, value: unknown): Promise<{ voucher: Voucher; replayed: boolean }> {
  const { client, company, userId } = context;
  const { idempotencyKey, ...body } = parseInput(voucherCreateInput, value, voucherFields);
  const hash = requestHash(body);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`voucher:${company.companyId}:${idempotencyKey}`]);
  const prior = await client.query<{ id: string; request_hash: string }>('SELECT id, request_hash FROM voucher WHERE company_id = $1 AND idempotency_key = $2', [company.companyId, idempotencyKey]);
  if (prior.rows[0]) {
    if (prior.rows[0].request_hash !== hash) throw new FoundationError(409, 'This idempotency key was already used for a different voucher. Send a new key for a new voucher.');
    return { voucher: await readVoucher(context, prior.rows[0].id), replayed: true };
  }
  const type: VoucherType = await readVoucherType(context, body.voucherTypeId).catch(missingAs(new FoundationError(400, 'The voucher type was not found.')));
  const lines = await prepareLines(context, type.kind, body);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO voucher (company_id, voucher_type_id, series, date, narration, status, post_dated, idempotency_key, request_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [company.companyId, type.id, type.numberingSeries, body.date, body.narration, body.status, body.postDated, idempotencyKey, hash, userId]);
  const voucherId = rows[0].id;
  await insertLines(context, voucherId, lines);
  let voucher = await readVoucher(context, voucherId);
  // An optional voucher takes no number until it is made regular.
  if (body.status === 'regular') voucher = { ...voucher, number: await issueNumber(context, voucherId, type.id, voucher.series) };
  await logRevision(context, 'voucher', voucherId, 'create', null, voucher);
  return { voucher, replayed: false };
}

/** The voucher, locked, if it may still change: not deleted and at the revision the editor read. */
async function changeable(context: LedgerContext, voucherId: string, revision: number): Promise<Voucher> {
  const before = await readVoucher(context, voucherId, true);
  if (before.deleted) throw voucherNotFound;
  if (before.revision !== revision) throw conflict('voucher');
  return before;
}

/**
 * Replaces a voucher's date, narration, flags and lines. The type, series and number never change; an optional voucher
 * made regular takes the next number then, and a numbered voucher cannot become optional again.
 */
export async function alterVoucher(context: LedgerContext, voucherId: string, value: unknown): Promise<Voucher> {
  const { client, company } = context;
  const input = parseInput(voucherAlterInput, value, voucherFields);
  const before = await changeable(context, voucherId, input.revision);
  if (before.status === 'cancelled') throw new FoundationError(409, 'A cancelled voucher cannot be altered.');
  if (before.status !== 'optional' && input.status === 'optional') throw new FoundationError(409, 'A numbered voucher cannot become optional. Cancel or delete it instead.');
  assertDateOpen(context, before.date);
  const lines = await prepareLines(context, before.kind, input);
  await client.query('DELETE FROM voucher_line WHERE company_id = $1 AND voucher_id = $2', [company.companyId, voucherId]);
  await insertLines(context, voucherId, lines);
  await client.query(
    `UPDATE voucher SET date = $3, narration = $4, status = $5, post_dated = $6, revision = revision + 1, updated_at = now() WHERE company_id = $1 AND id = $2`,
    [company.companyId, voucherId, input.date, input.narration, input.status, input.postDated]);
  let after = await readVoucher(context, voucherId);
  if (before.status === 'optional' && input.status === 'regular') after = { ...after, number: await issueNumber(context, voucherId, after.voucherTypeId, after.series) };
  await logRevision(context, 'voucher', voucherId, 'alter', before, after);
  return after;
}

/** A cancelled voucher keeps its number and its row (and lines, for the record) but has no accounting effect. */
export async function cancelVoucher(context: LedgerContext, voucherId: string, value: unknown): Promise<Voucher> {
  const input = parseInput(revisionInput, value, voucherFields);
  const before = await changeable(context, voucherId, input.revision);
  if (before.status === 'cancelled') throw new FoundationError(409, 'This voucher is already cancelled.');
  if (before.status === 'optional') throw new FoundationError(409, 'An optional voucher has no number to keep. Delete it instead.');
  assertDateOpen(context, before.date);
  await context.client.query(`UPDATE voucher SET status = 'cancelled', revision = revision + 1, updated_at = now() WHERE company_id = $1 AND id = $2`, [context.company.companyId, voucherId]);
  const after = await readVoucher(context, voucherId);
  await logRevision(context, 'voucher', voucherId, 'cancel', before, after);
  return after;
}

/** Soft delete: the row stays for the revision log and its number stays used, so the gap is permanent. */
export async function deleteVoucher(context: LedgerContext, voucherId: string, value: unknown): Promise<void> {
  const input = parseInput(revisionInput, value, voucherFields);
  const before = await changeable(context, voucherId, input.revision);
  assertDateOpen(context, before.date);
  await context.client.query('UPDATE voucher SET deleted_at = now(), deleted_by = $3, revision = revision + 1, updated_at = now() WHERE company_id = $1 AND id = $2',
    [context.company.companyId, voucherId, context.userId]);
  await logRevision(context, 'voucher', voucherId, 'delete', before, await readVoucher(context, voucherId));
}
