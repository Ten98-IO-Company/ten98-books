import type { MoneyExponent } from '@ten98/runtime';
import { reportNames, type ReportName } from '../../lib/reports.ts';
import { runLedger, type LedgerContext } from '../ledger/context.ts';
import { balanceSheetCsv, csvDocument, dayBookCsv, groupSummaryCsv, ledgerMonthlyCsv, ledgerVouchersCsv, profitAndLossCsv, trialBalanceCsv } from '../reports/csv.ts';
import { dayBookReport, reportDefaults } from '../reports/day-book.ts';
import { ledgerMonthlyReport, ledgerVouchersReport } from '../reports/ledger.ts';
import { balanceSheetReport, groupSummaryReport, profitAndLossReport, trialBalanceReport } from '../reports/statements.ts';
import { json, type SignedInArea } from './http.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const route = new RegExp(`^/api/companies/(${uuid})/reports/(defaults|${reportNames.join('|')})(?:/(${uuid}))?(/export)?$`, 'i');
const notAllowed = () => json({ error: 'Method not allowed.' }, 405, { allow: 'GET' });

type Report = {
  /** Whether the path names a group or ledger: required, optional or refused. */
  subject: 'required' | 'optional' | 'none';
  /** Query parameters the report reads; any other parameter is refused by its schema. */
  keys: readonly string[];
  read: (context: LedgerContext, subject: string | null, query: Record<string, string>, all: boolean) => Promise<unknown>;
  csv: (report: never, exponent: MoneyExponent) => string[][];
};
const period = ['from', 'to'] as const, paged = ['from', 'to', 'limit', 'after'] as const;
const reports: Record<ReportName, Report> = {
  'day-book': { subject: 'none', keys: paged, read: (context, _subject, query, all) => dayBookReport(context, query, all), csv: dayBookCsv },
  'trial-balance': { subject: 'none', keys: period, read: (context, _subject, query) => trialBalanceReport(context, query), csv: trialBalanceCsv },
  'profit-and-loss': { subject: 'none', keys: period, read: (context, _subject, query) => profitAndLossReport(context, query), csv: profitAndLossCsv },
  'balance-sheet': { subject: 'none', keys: ['date'], read: (context, _subject, query) => balanceSheetReport(context, query), csv: balanceSheetCsv },
  'group-summary': { subject: 'optional', keys: period, read: (context, subject, query) => groupSummaryReport(context, subject, query), csv: groupSummaryCsv },
  'ledger-monthly': { subject: 'required', keys: period, read: (context, subject, query) => ledgerMonthlyReport(context, subject!, query), csv: ledgerMonthlyCsv },
  'ledger-vouchers': { subject: 'required', keys: paged, read: (context, subject, query, all) => ledgerVouchersReport(context, subject!, query, all), csv: ledgerVouchersCsv },
};

/** Every parameter of the URL as given, so an unknown or repeated one reaches the schema and is refused there. */
function queryOf(url: URL, keys: readonly string[]): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key) || !keys.includes(key)) query[`unexpected ${key}`] = value;
    else query[key] = value;
  }
  return query;
}

function csvResponse(name: string, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * The M1 reports (D-09), read-only: GET /api/companies/<id>/reports/<report>[/<group or ledger id>][/export]. Every
 * route runs through withCompany in read mode via runLedger, so viewers read and a company the user cannot reach
 * answers "not found", the export included. Queries are checked by zod in the report modules; amounts are decimal
 * strings in JSON and plain decimals in CSV.
 */
export const reportsApi: SignedInArea = async ({ request, url, path, user }) => {
  const match = path.match(route);
  if (!match) return null;
  const [, companyId, rawName, rawSubject, exported] = match as unknown as [string, string, string, string | undefined, string | undefined];
  const name = rawName.toLowerCase() as ReportName | 'defaults';
  const subject = rawSubject?.toLowerCase() ?? null;
  if (request.method !== 'GET') return notAllowed();

  if (name === 'defaults') {
    if (subject || exported) return null;
    return json({ defaults: await runLedger(user.id, companyId, 'read', reportDefaults) });
  }
  const report = reports[name];
  if ((report.subject === 'required' && !subject) || (report.subject === 'none' && subject)) return null;
  const query = queryOf(url, report.keys);
  if (!exported) return json({ report: await runLedger(user.id, companyId, 'read', context => report.read(context, subject, query, false)) });
  const body = await runLedger(user.id, companyId, 'read', async context =>
    csvDocument(report.csv(await report.read(context, subject, query, true) as never, context.company.exponent)));
  const dates = [query.from ?? query.date, query.to].filter(Boolean).join('-to-');
  return csvResponse(`${name}${dates ? `-${dates}` : ''}.csv`, body);
};
