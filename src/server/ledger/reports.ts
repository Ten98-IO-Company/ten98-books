import { addMoney, subtractMoney } from '@ten98/runtime';
import { financialYearOf } from '../../lib/company.ts';
import { periodQuery, type Nature, type Side, type TrialBalance, type TrialBalanceRow } from '../../lib/ledger.ts';
import { FoundationError } from '../auth.ts';
import { parseInput, type LedgerContext } from './context.ts';
import { groupTreeSql } from './masters.ts';

/**
 * The M1 read model for verification (not a report screen): typed rows straight from SQL (D-09). Only regular,
 * undeleted vouchers count; cancelled and optional vouchers have no effect and a post-dated voucher counts from its own
 * date like any other. Opening balances are computed at report time (D-04): a balance-sheet ledger opens with its
 * opening balance plus everything before the period; an income or expense ledger opens with what was posted earlier in
 * the same financial year only, and what it gathered in earlier years is carried into the profit and loss ledger.
 */

/** Report queries get their own time budget instead of the pool's 10-second default (D-02). */
const reportTimeout = '30s';

type Movement = {
  ledgerId: string; name: string; systemKey: string | null; groupId: string | null; primaryGroupId: string | null;
  primaryGroupName: string | null; nature: Nature | null; grossProfit: boolean;
  opening: bigint; beforeFrom: bigint; beforeYear: bigint; debit: bigint; credit: bigint;
};

const sides = (signed: bigint) => signed >= 0n ? { debit: signed, credit: 0n } : { debit: 0n, credit: subtractMoney(0n, signed) };

export async function trialBalance(context: LedgerContext, from: string, to: string): Promise<TrialBalance> {
  const period = parseInput(periodQuery, { from, to }, path => path[0] === 'to' ? 'the end date' : 'the period');
  const { client, company } = context;
  const yearStart = financialYearOf(company.financialYearStart, period.from).from;
  await client.query(`SET LOCAL statement_timeout = '${reportTimeout}'`);
  const { rows } = await client.query<Movement>(
    `WITH RECURSIVE ${groupTreeSql},
     moves AS (
       SELECT l.ledger_id,
         coalesce(sum(CASE l.side WHEN 'Dr' THEN l.amount ELSE -l.amount END) FILTER (WHERE v.date < $2), 0)::bigint AS before_from,
         coalesce(sum(CASE l.side WHEN 'Dr' THEN l.amount ELSE -l.amount END) FILTER (WHERE v.date < $4), 0)::bigint AS before_year,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Dr' AND v.date >= $2), 0)::bigint AS debit,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Cr' AND v.date >= $2), 0)::bigint AS credit
       FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id
       WHERE l.company_id = $1 AND v.status = 'regular' AND v.deleted_at IS NULL AND v.date <= $3
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
     WHERE led.company_id = $1 ORDER BY lower(led.name), led.id`,
    [company.companyId, period.from, period.to, yearStart]);

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
  const totals = { openingDebit: 0n, openingCredit: 0n, debit: 0n, credit: 0n, closingDebit: 0n, closingCredit: 0n };
  const result = rows.map(({ opening: _opening, beforeFrom: _beforeFrom, beforeYear: _beforeYear, ...row }, index): TrialBalanceRow => {
    const opening = row.systemKey === 'profit_and_loss' ? addMoney(openings[index], carried) : openings[index];
    const closing = subtractMoney(addMoney(opening, row.debit), row.credit);
    const open = sides(opening), close = sides(closing);
    const line = { ...row, openingDebit: open.debit, openingCredit: open.credit, closingDebit: close.debit, closingCredit: close.credit };
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = addMoney(totals[key], line[key]);
    return line;
  });
  const side: Side | null = difference > 0n ? 'Dr' : difference < 0n ? 'Cr' : null;
  const amount = side === 'Cr' ? subtractMoney(0n, difference) : difference;
  return { from: period.from, to: period.to, rows: result, totals, openingDifference: { amount, side } };
}

/** One ledger's opening, movements and closing for the period (the trial balance row, so both always agree). */
export async function ledgerBalance(context: LedgerContext, ledgerId: string, from: string, to: string): Promise<TrialBalanceRow> {
  const row = (await trialBalance(context, from, to)).rows.find(item => item.ledgerId === ledgerId);
  if (!row) throw new FoundationError(404, 'Ledger not found.');
  return row;
}
