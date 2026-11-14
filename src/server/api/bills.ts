import type { MoneyExponent } from '@ten98/runtime';
import { readLedgerBody, runLedger, type LedgerContext } from '../ledger/context.ts';
import {
  ageingReport, billDetailReport, billPicker, billsOutstandingReport, creditCheck, partyBillsReport, readAgeingBuckets, saveAgeingBuckets,
} from '../reports/bills.ts';
import { ageingCsv, billDetailCsv, billsOutstandingCsv, csvDocument, partyBillsCsv } from '../reports/csv.ts';
import { json, limit, type SignedInArea } from './http.ts';
import { csvResponse, exportsPerMinute, queryOf } from './reports.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const company = `^/api/companies/(${uuid})`;
const listRoute = new RegExp(`${company}/reports/(bills-outstanding|ageing)(/export)?$`, 'i');
const subjectRoute = new RegExp(`${company}/reports/(party-bills|bill)/(${uuid})(/export)?$`, 'i');
const ledgerRoute = new RegExp(`${company}/ledgers/(${uuid})/(bills|credit-check)$`, 'i');
const bucketsRoute = new RegExp(`${company}/ageing-buckets$`, 'i');
const notAllowed = (allow: string) => json({ error: 'Method not allowed.' }, 405, { allow });

type Report = {
  keys: readonly string[];
  read: (context: LedgerContext, subject: string | null, query: Record<string, string>, all: boolean) => Promise<unknown>;
  csv: (report: never, exponent: MoneyExponent) => string[][];
};
const reports: Record<string, Report> = {
  'bills-outstanding': { keys: ['side', 'groupId', 'asOf', 'limit', 'after'], read: (context, _subject, query, all) => billsOutstandingReport(context, query, all), csv: billsOutstandingCsv },
  ageing: { keys: ['side', 'groupId', 'asOf', 'basis'], read: (context, _subject, query) => ageingReport(context, query), csv: ageingCsv },
  'party-bills': { keys: ['asOf'], read: (context, subject, query) => partyBillsReport(context, subject!, query), csv: partyBillsCsv },
  bill: { keys: ['asOf'], read: (context, subject, query) => billDetailReport(context, subject!, query), csv: billDetailCsv },
};

/**
 * Bill-wise reads and the ageing columns (M2a slice 1). Every route runs through withCompany via runLedger: viewers read,
 * editors and above change the ageing columns (POST, covered by the central origin gate). Reports answer GET under
 * `reports/` with a CSV export beside each, rate-limited like the M1 exports; unknown or repeated query parameters are
 * refused by the report's schema.
 */
export const billsApi: SignedInArea = async ({ request, url, path, user }) => {
  let match = path.match(listRoute) ?? path.match(subjectRoute);
  if (match) {
    if (request.method !== 'GET') return notAllowed('GET');
    const subjectless = path.match(listRoute) !== null;
    const name = match[2].toLowerCase(), subject = subjectless ? null : match[3].toLowerCase(), exported = subjectless ? match[3] : match[4];
    const report = reports[name];
    const query = queryOf(url, report.keys);
    if (!exported) return json({ report: await runLedger(user.id, match[1], 'read', context => report.read(context, subject, query, false)) });
    await limit(`reports-export:${user.id}`, exportsPerMinute);
    const body = await runLedger(user.id, match[1], 'read', async context =>
      csvDocument(report.csv(await report.read(context, subject, query, true) as never, context.company.exponent)));
    return csvResponse(`${name}-${query.asOf ?? 'report'}.csv`, body);
  }
  match = path.match(ledgerRoute);
  if (match) {
    if (request.method !== 'GET') return notAllowed('GET');
    const ledgerId = match[2].toLowerCase();
    if (match[3].toLowerCase() === 'bills') {
      const query = queryOf(url, ['asOf', 'scope', 'sort', 'direction']);
      return json({ bills: await runLedger(user.id, match[1], 'read', context => billPicker(context, ledgerId, query)) });
    }
    const query = queryOf(url, ['date']);
    return json({ creditCheck: await runLedger(user.id, match[1], 'read', context => creditCheck(context, ledgerId, query)) });
  }
  match = path.match(bucketsRoute);
  if (!match) return null;
  if (request.method === 'GET') return json({ buckets: await runLedger(user.id, match[1], 'read', readAgeingBuckets) });
  if (request.method !== 'POST') return notAllowed('GET, POST');
  await limit(`masters:${user.id}`, 120);
  const body = await readLedgerBody(request);
  return json({ buckets: await runLedger(user.id, match[1], 'write', context => saveAgeingBuckets(context, body)) });
};
