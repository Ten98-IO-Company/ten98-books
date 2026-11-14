import { addMoney, subtractMoney } from '@ten98/runtime';
import { financialYearOf } from '../../lib/company.ts';
import { reportPageQuery, type LedgerHeader, type LedgerMonth, type LedgerMonthlyReport, type LedgerVoucherRow, type LedgerVouchersReport } from '../../lib/reports.ts';
import { FoundationError } from '../auth.ts';
import { parseInput, type LedgerContext } from '../ledger/context.ts';
import { countsSql, ledgerRows, reportBudget } from '../ledger/reports.ts';
import { decodeCursor, encodeCursor, exportLimit, exportTooLarge } from './cursor.ts';
import { parsePeriod } from './statements.ts';

/**
 * One ledger's monthly summary and its vouchers. Opening, totals and closing come from the read model's row for the
 * ledger, so these screens agree with the trial balance and the group summary; the monthly and per-voucher figures are
 * one set-based query each. Ledger screens get a 20-second budget.
 */

const budgetSeconds = 20;
const pageFields = (path: readonly PropertyKey[]) => ({ from: 'the start date', to: 'the end date', limit: 'the page size', after: 'the page cursor' } as Record<string, string>)[String(path[0])] ?? 'the period';

async function ledgerHeader(context: LedgerContext, ledgerId: string): Promise<LedgerHeader> {
  const { rows } = await context.client.query<LedgerHeader>(
    `SELECT l.id, l.name, l.group_id AS "groupId", g.name AS "groupName", g.nature
     FROM ledger l LEFT JOIN account_group g ON g.company_id = l.company_id AND g.id = l.group_id
     WHERE l.company_id = $1 AND l.id = $2`, [context.company.companyId, ledgerId]);
  if (!rows[0]) throw new FoundationError(404, 'Ledger not found.');
  return rows[0];
}

async function balances(context: LedgerContext, ledgerId: string, from: string, to: string) {
  const row = (await ledgerRows(context, from, to, ledgerId)).rows.find(item => item.ledgerId === ledgerId);
  if (!row) throw new FoundationError(404, 'Ledger not found.');
  return {
    opening: subtractMoney(row.openingDebit, row.openingCredit),
    totals: { debit: row.debit, credit: row.credit, closing: subtractMoney(row.closingDebit, row.closingCredit) },
  };
}

/**
 * Opening at the start of the period, then debits, credits and closing per calendar month (the first and last months
 * clipped to the period). The period stays inside one financial year: its end is clipped to the end of the year that
 * contains its start, because income and expense ledgers start each year afresh.
 */
export async function ledgerMonthlyReport(context: LedgerContext, ledgerId: string, query: unknown): Promise<LedgerMonthlyReport> {
  const period = parsePeriod(query);
  const yearEnd = financialYearOf(context.company.financialYearStart, period.from).to;
  const from = period.from, to = period.to < yearEnd ? period.to : yearEnd;
  await reportBudget(context, budgetSeconds);
  const ledger = await ledgerHeader(context, ledgerId);
  const { opening, totals } = await balances(context, ledgerId, from, to);
  const { rows } = await context.client.query<Omit<LedgerMonth, 'closing'>>(
    `WITH months AS (SELECT generate_series(date_trunc('month', $3::date), date_trunc('month', $4::date), interval '1 month')::date AS month),
     moves AS (
       SELECT date_trunc('month', v.date)::date AS month,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Dr'), 0)::bigint AS debit,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Cr'), 0)::bigint AS credit
       FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id
       WHERE l.company_id = $1 AND l.ledger_id = $2 AND ${countsSql} AND v.date BETWEEN $3 AND $4
       GROUP BY 1)
     SELECT to_char(m.month, 'YYYY-MM') AS month, greatest(m.month, $3::date)::text AS "from",
       least((m.month + interval '1 month')::date - 1, $4::date)::text AS "to",
       coalesce(moves.debit, 0::bigint) AS debit, coalesce(moves.credit, 0::bigint) AS credit
     FROM months m LEFT JOIN moves USING (month) ORDER BY m.month`,
    [context.company.companyId, ledgerId, from, to]);
  let running = opening;
  const months = rows.map(month => ({ ...month, closing: running = subtractMoney(addMoney(running, month.debit), month.credit) }));
  return { from, to, ledger, opening, months, totals };
}

type EntryRow = Omit<LedgerVoucherRow, 'balance'> & { movement: bigint };

/**
 * The ledger's vouchers in the period, one row per voucher (its debit and credit lines on this ledger), with the running
 * balance after each and the first ledger on the other side as particulars. Keyset-paged on (date, voucher id); the
 * running balance is a window over the whole period, so every page continues from the one before.
 */
export async function ledgerVouchersReport(context: LedgerContext, ledgerId: string, query: unknown, all = false): Promise<LedgerVouchersReport> {
  const page = parseInput(reportPageQuery, query, pageFields);
  const [afterDate, afterId] = all ? [null, null] : decodeCursor(page.after);
  const limit = all ? exportLimit : page.limit;
  await reportBudget(context, budgetSeconds);
  const ledger = await ledgerHeader(context, ledgerId);
  const { opening, totals } = await balances(context, ledgerId, page.from, page.to);
  const { rows } = await context.client.query<EntryRow>(
    `WITH entries AS (
       SELECT v.id, v.date,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Dr'), 0)::bigint AS debit,
         coalesce(sum(l.amount) FILTER (WHERE l.side = 'Cr'), 0)::bigint AS credit
       FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id
       WHERE l.company_id = $1 AND l.ledger_id = $2 AND ${countsSql} AND v.date BETWEEN $3 AND $4
       GROUP BY v.id, v.date),
     running AS (SELECT e.*, sum(e.debit - e.credit) OVER (ORDER BY e.date, e.id ROWS UNBOUNDED PRECEDING)::bigint AS movement FROM entries e),
     page AS (SELECT * FROM running r WHERE $5::date IS NULL OR (r.date, r.id) > ($5::date, $6::uuid) ORDER BY r.date, r.id LIMIT $7)
     SELECT p.id AS "voucherId", p.date, t.name AS "voucherTypeName", t.kind, v.number, p.debit, p.credit, p.movement,
       coalesce(o.particulars, '') AS particulars, coalesce(o.others, 0) AS "otherLedgers"
     FROM page p
       JOIN voucher v ON v.company_id = $1 AND v.id = p.id
       JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id
       LEFT JOIN LATERAL (
         SELECT (array_agg(led.name ORDER BY x.line_no))[1] AS particulars, (count(DISTINCT x.ledger_id) - 1)::int AS others
         FROM voucher_line x JOIN ledger led ON led.company_id = x.company_id AND led.id = x.ledger_id
         WHERE x.company_id = $1 AND x.voucher_id = p.id AND x.ledger_id <> $2
           AND x.side = CASE WHEN p.debit >= p.credit THEN 'Cr' ELSE 'Dr' END) o ON true
     ORDER BY p.date, p.id`,
    [context.company.companyId, ledgerId, page.from, page.to, afterDate, afterId, limit + 1]);
  if (all && rows.length > limit) throw exportTooLarge;
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return {
    from: page.from, to: page.to, ledger, opening, totals,
    rows: shown.map(({ movement, ...row }) => ({ ...row, otherLedgers: Math.max(0, row.otherLedgers), balance: addMoney(opening, movement) })),
    next: rows.length > limit && last ? encodeCursor(last.date, last.voucherId) : null,
  };
}
