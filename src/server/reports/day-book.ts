import { defaultPeriod, reportPageQuery, type DayBookReport, type DayBookRow, type ReportDefaults } from '../../lib/reports.ts';
import { parseInput, type LedgerContext } from '../ledger/context.ts';
import { countsSql, reportBudget } from '../ledger/reports.ts';
import { decodeCursor, encodeCursor, exportLimit, exportTooLarge } from './cursor.ts';

/**
 * The day book: every undeleted voucher dated in the period, in date and entry order, keyset-paged. Particulars are the
 * first line's ledger and the voucher amount stands in that line's column. Cancelled and optional vouchers are listed
 * with their status and left out of the totals; a post-dated voucher is listed and counted on its own date. 15 seconds.
 */

const budgetSeconds = 15;
const pageFields = (path: readonly PropertyKey[]) => ({ from: 'the start date', to: 'the end date', limit: 'the page size', after: 'the page cursor' } as Record<string, string>)[String(path[0])] ?? 'the period';

export async function dayBookReport(context: LedgerContext, query: unknown, all = false): Promise<DayBookReport> {
  const page = parseInput(reportPageQuery, query, pageFields);
  const [afterDate, afterId] = all ? [null, null] : decodeCursor(page.after);
  const limit = all ? exportLimit : page.limit;
  const { client, company } = context;
  await reportBudget(context, budgetSeconds);
  // The page is chosen first; only its vouchers then look up their first line and amount.
  const { rows } = await client.query<DayBookRow>(
    `WITH page AS (
       SELECT v.id, v.date, v.voucher_type_id, v.number, v.status, v.post_dated, v.narration FROM voucher v
       WHERE v.company_id = $1 AND v.deleted_at IS NULL AND v.date BETWEEN $2 AND $3
         AND ($4::date IS NULL OR (v.date, v.id) > ($4::date, $5::uuid))
       ORDER BY v.date, v.id LIMIT $6)
     SELECT p.id AS "voucherId", p.date, t.name AS "voucherTypeName", t.kind, p.number, p.status, p.post_dated AS "postDated",
       p.narration, f.name AS particulars, f.side, s.total AS amount
     FROM page p JOIN voucher_type t ON t.company_id = $1 AND t.id = p.voucher_type_id
       CROSS JOIN LATERAL (
         SELECT led.name, l.side FROM voucher_line l JOIN ledger led ON led.company_id = l.company_id AND led.id = l.ledger_id
         WHERE l.company_id = $1 AND l.voucher_id = p.id ORDER BY l.line_no LIMIT 1) f
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(x.amount), 0)::bigint AS total FROM voucher_line x
         WHERE x.company_id = $1 AND x.voucher_id = p.id AND x.side = 'Dr') s
     ORDER BY p.date, p.id`,
    [company.companyId, page.from, page.to, afterDate, afterId, limit + 1]);
  if (all && rows.length > limit) throw exportTooLarge;
  // Totals of the whole period in one grouped pass over the lines: each voucher's amount and its first line's side.
  const { rows: [totals] } = await client.query<DayBookReport['totals']>(
    `SELECT coalesce(sum(x.total) FILTER (WHERE x.side = 'Dr'), 0)::bigint AS debit,
       coalesce(sum(x.total) FILTER (WHERE x.side = 'Cr'), 0)::bigint AS credit, count(*)::int AS vouchers
     FROM (
       SELECT coalesce(sum(l.amount) FILTER (WHERE l.side = 'Dr'), 0) AS total, (array_agg(l.side ORDER BY l.line_no))[1] AS side
       FROM voucher_line l JOIN voucher v ON v.company_id = l.company_id AND v.id = l.voucher_id
       WHERE l.company_id = $1 AND ${countsSql} AND v.date BETWEEN $2 AND $3
       GROUP BY l.voucher_id) x`,
    [company.companyId, page.from, page.to]);
  const shown = rows.slice(0, limit);
  const last = shown[shown.length - 1];
  return { from: page.from, to: page.to, rows: shown, totals, next: rows.length > limit && last ? encodeCursor(last.date, last.voucherId) : null };
}

/**
 * Where reports open: the last date of a regular, undeleted voucher that is not post-dated (optional and post-dated
 * vouchers do not move it), or the books-beginning date while there is none.
 */
export async function reportDefaults(context: LedgerContext): Promise<ReportDefaults> {
  const { company } = context;
  await reportBudget(context, budgetSeconds);
  const { rows } = await context.client.query<{ last: string | null }>(
    `SELECT max(v.date)::text AS last FROM voucher v WHERE v.company_id = $1 AND ${countsSql} AND NOT v.post_dated`, [company.companyId]);
  const last = rows[0]?.last ?? null;
  const anchor = last ?? company.booksBeginning;
  return { lastVoucherDate: last, period: defaultPeriod(company.financialYearStart, anchor), dayBookDate: anchor, booksBeginning: company.booksBeginning };
}
