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

/** Per voucher: its first line (ledger name and side) and its amount (the sum of its debit lines). */
const voucherFacts = `
  CROSS JOIN LATERAL (
    SELECT led.name, l.side FROM voucher_line l JOIN ledger led ON led.company_id = l.company_id AND led.id = l.ledger_id
    WHERE l.company_id = v.company_id AND l.voucher_id = v.id ORDER BY l.line_no LIMIT 1) f
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(x.amount), 0)::bigint AS total FROM voucher_line x
    WHERE x.company_id = v.company_id AND x.voucher_id = v.id AND x.side = 'Dr') s`;

export async function dayBookReport(context: LedgerContext, query: unknown, all = false): Promise<DayBookReport> {
  const page = parseInput(reportPageQuery, query, pageFields);
  const [afterDate, afterId] = all ? [null, null] : decodeCursor(page.after);
  const limit = all ? exportLimit : page.limit;
  const { client, company } = context;
  await reportBudget(context, budgetSeconds);
  const { rows } = await client.query<DayBookRow>(
    `SELECT v.id AS "voucherId", v.date, t.name AS "voucherTypeName", t.kind, v.number, v.status, v.post_dated AS "postDated",
       v.narration, f.name AS particulars, f.side, s.total AS amount
     FROM voucher v JOIN voucher_type t ON t.company_id = v.company_id AND t.id = v.voucher_type_id ${voucherFacts}
     WHERE v.company_id = $1 AND v.deleted_at IS NULL AND v.date BETWEEN $2 AND $3
       AND ($4::date IS NULL OR (v.date, v.id) > ($4::date, $5::uuid))
     ORDER BY v.date, v.id LIMIT $6`,
    [company.companyId, page.from, page.to, afterDate, afterId, limit + 1]);
  if (all && rows.length > limit) throw exportTooLarge;
  const { rows: [totals] } = await client.query<DayBookReport['totals']>(
    `SELECT coalesce(sum(s.total) FILTER (WHERE f.side = 'Dr'), 0)::bigint AS debit,
       coalesce(sum(s.total) FILTER (WHERE f.side = 'Cr'), 0)::bigint AS credit, count(*)::int AS vouchers
     FROM voucher v ${voucherFacts}
     WHERE v.company_id = $1 AND ${countsSql} AND v.date BETWEEN $2 AND $3`,
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
