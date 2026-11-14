import { addMoney, subtractMoney } from '@ten98/runtime';
import { financialYearOf } from '../../lib/company.ts';
import { periodQuery, type Nature, type Side, type TrialBalance, type TrialBalanceRow } from '../../lib/ledger.ts';
import { FoundationError } from '../auth.ts';
import { parseInput, type LedgerContext } from './context.ts';
import { groupTreeSql } from './masters.ts';

/**
 * The M1 read model: typed rows straight from SQL (D-09), shared by the verification API and the report modules in
 * src/server/reports. Only regular, undeleted vouchers count; cancelled and optional vouchers have no effect and a
 * post-dated voucher counts from its own date like any other. Opening balances are computed at report time (D-04): a
 * balance-sheet ledger opens with its opening balance plus everything before the period; an income or expense ledger
 * opens with what was posted earlier in the same financial year only, and what it gathered in earlier years is carried
 * into the profit and loss ledger.
 */

/** Report queries get their own time budget instead of the pool's 10-second default (D-02). */
export async function reportBudget(context: LedgerContext, seconds: number): Promise<void> {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) throw new RangeError('A report budget is 1 to 120 seconds.');
  await context.client.query(`SET LOCAL statement_timeout = '${seconds}s'`);
}

/** The SQL condition for a voucher that affects balances, for a `voucher v`. */
export const countsSql = `v.status = 'regular' AND v.deleted_at IS NULL`;

type Movement = {
  ledgerId: string; name: string; systemKey: string | null; groupId: string | null; primaryGroupId: string | null;
  primaryGroupName: string | null; nature: Nature | null; grossProfit: boolean;
  opening: bigint; beforeFrom: bigint; beforeYear: bigint; debit: bigint; credit: bigint;
};

/** A trial balance row plus the opening balance as entered (signed, debit positive), which statements need. */
export type LedgerRow = TrialBalanceRow & { enteredOpening: bigint };
export type LedgerRows = { from: string; to: string; rows: LedgerRow[]; openingDifference: { amount: bigint; side: Side | null } };

const sides = (signed: bigint) => signed >= 0n ? { debit: signed, credit: 0n } : { debit: 0n, credit: subtractMoney(0n, signed) };
const periodFields = (path: readonly PropertyKey[]) => path[0] === 'to' ? 'the end date' : 'the period';

/**
 * One row per ledger for the period, from one set-based query. With `only`, the query reads that ledger's lines alone,
 * except for the profit and loss ledger, whose opening needs every income and expense ledger of earlier years; the
 * opening difference then covers the rows returned.
 */
export async function ledgerRows(context: LedgerContext, from: string, to: string, only?: string): Promise<LedgerRows> {
  const period = parseInput(periodQuery, { from, to }, periodFields);
  const { client, company } = context;
  const yearStart = financialYearOf(company.financialYearStart, period.from).from;
  let filter = '';
  if (only !== undefined) {
    const { rows } = await client.query<{ systemKey: string | null }>('SELECT system_key AS "systemKey" FROM ledger WHERE company_id = $1 AND id = $2', [company.companyId, only]);
    if (!rows[0]) throw new FoundationError(404, 'Ledger not found.');
    if (rows[0].systemKey !== 'profit_and_loss') filter = 'AND l.ledger_id = $5';
  }
  const parameters: unknown[] = [company.companyId, period.from, period.to, yearStart];
  if (filter) parameters.push(only);
  const { rows } = await client.query<Movement>(
    `WITH RECURSIVE ${groupTreeSql},
     moves AS (
       SELECT l.ledger_id,
         coalesce(sum(CASE l.side WHEN 'Dr' THEN l.amount ELSE -l.amount END) FILTER (WHERE v.date < $2), 0)::bigint AS before_from,
         coalesce(sum(CASE l.side WHEN 'Dr' THEN l.amount ELSE -l.amount END) FILTER (WHERE v.date < $4), 0)::bigint AS before_year,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Dr' AND v.date >= $2), 0)::bigint AS debit,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Cr' AND v.date >= $2), 0)::bigint AS credit
       FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id
       WHERE l.company_id = $1 ${filter} AND ${countsSql} AND v.date <= $3
       GROUP BY l.ledger_id)
     SELECT led.id AS "ledgerId", led.name, led.system_key AS "systemKey", led.group_id AS "groupId", t.primary_id AS "primaryGroupId",
       t.primary_name AS "primaryGroupName", g.nature, coalesce(g.gross_profit, false) AS "grossProfit",
       CASE led.opening_side WHEN 'Dr' THEN led.opening_amount ELSE -led.opening_amount END AS opening,
       coalesce(m.before_from, 0::bigint) AS "beforeFrom", coalesce(m.before_year, 0::bigint) AS "beforeYear",
       coalesce(m.debit, 0::bigint) AS debit, coalesce(m.credit, 0::bigint) AS credit
     FROM ledger led
       LEFT JOIN account_group g ON g.company_id = led.company_id AND g.id = led.group_id
       LEFT JOIN tree t ON t.id = led.group_id
       LEFT JOIN moves m ON m.ledger_id = led.id
     WHERE led.company_id = $1 ${filter.replace('l.ledger_id', 'led.id')} ORDER BY lower(led.name), led.id`,
    parameters);

  // Income and expense of earlier financial years, closed into the profit and loss ledger at report time.
  let carried = 0n, difference = 0n;
  const openings = rows.map(row => {
    difference = addMoney(difference, row.opening);
    const before = addMoney(row.opening, row.beforeFrom);
    if (row.nature !== 'income' && row.nature !== 'expense') return before;
    const earlierYears = addMoney(company.booksBeginning < yearStart ? row.opening : 0n, row.beforeYear);
    carried = addMoney(carried, earlierYears);
    return subtractMoney(before, earlierYears);
  });
  const result = rows.map(({ opening: enteredOpening, beforeFrom: _beforeFrom, beforeYear: _beforeYear, ...row }, index): LedgerRow => {
    const opening = row.systemKey === 'profit_and_loss' ? addMoney(openings[index], carried) : openings[index];
    const closing = subtractMoney(addMoney(opening, row.debit), row.credit);
    const open = sides(opening), close = sides(closing);
    return { ...row, openingDebit: open.debit, openingCredit: open.credit, closingDebit: close.debit, closingCredit: close.credit, enteredOpening };
  });
  const side: Side | null = difference > 0n ? 'Dr' : difference < 0n ? 'Cr' : null;
  const amount = side === 'Cr' ? subtractMoney(0n, difference) : difference;
  return { from: period.from, to: period.to, rows: result, openingDifference: { amount, side } };
}

export async function trialBalance(context: LedgerContext, from: string, to: string): Promise<TrialBalance> {
  await reportBudget(context, 30);
  const { rows, openingDifference, ...period } = await ledgerRows(context, from, to);
  const totals = { openingDebit: 0n, openingCredit: 0n, debit: 0n, credit: 0n, closingDebit: 0n, closingCredit: 0n };
  const result = rows.map(({ enteredOpening: _entered, ...row }): TrialBalanceRow => {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = addMoney(totals[key], row[key]);
    return row;
  });
  return { ...period, rows: result, totals, openingDifference };
}

/** One ledger's opening, movements and closing for the period (the trial balance row, so both always agree). */
export async function ledgerBalance(context: LedgerContext, ledgerId: string, from: string, to: string): Promise<TrialBalanceRow> {
  await reportBudget(context, 30);
  const row = (await ledgerRows(context, from, to, ledgerId)).rows.find(item => item.ledgerId === ledgerId);
  if (!row) throw new FoundationError(404, 'Ledger not found.');
  const { enteredOpening: _entered, ...balance } = row;
  return balance;
}
