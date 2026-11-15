import type { CostCategorySummary, CostCentreBreakup } from '../../lib/cost-centres.ts';
import type { Revision } from '../../lib/ledger.ts';
import { readLedgerBody, runLedger, type LedgerContext } from '../ledger/context.ts';
import {
  alterCostCategory, alterCostCentre, costDefault, createCostCategory, createCostCentre, deleteCostCategory, deleteCostCentre,
  getCostCategory, getCostCentre, listCostCategories, listCostCentres, readCostCentresSetting, saveCostCentresSetting,
} from '../ledger/cost-centres.ts';
import { masterHistory } from '../ledger/revisions.ts';
import { costCategorySummary, costCentreBreakup } from '../reports/cost-centres.ts';
import { costCategorySummaryCsv, costCentreBreakupCsv, csvDocument } from '../reports/csv.ts';
import { json, limit, type SignedInArea } from './http.ts';
import { csvResponse, exportsPerMinute, queryOf } from './reports.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const company = `^/api/companies/(${uuid})`;
const mastersRoute = new RegExp(`${company}/(cost-categories|cost-centres)(?:/(${uuid})(?:/(delete|revisions))?)?$`, 'i');
const defaultRoute = new RegExp(`${company}/ledgers/(${uuid})/cost-default$`, 'i');
const settingRoute = new RegExp(`${company}/cost-centres-setting$`, 'i');
const summaryRoute = new RegExp(`${company}/reports/cost-category-summary(/export)?$`, 'i');
const breakupRoute = new RegExp(`${company}/reports/cost-centre-breakup/(${uuid})(/export)?$`, 'i');
const notAllowed = (allow: string) => json({ error: 'Method not allowed.' }, 405, { allow });

type Handler = {
  list: (context: LedgerContext) => Promise<unknown>;
  read: (context: LedgerContext, id: string) => Promise<unknown>;
  create: (context: LedgerContext, body: unknown) => Promise<unknown>;
  alter: (context: LedgerContext, id: string, body: unknown) => Promise<unknown>;
  remove: (context: LedgerContext, id: string, body: unknown) => Promise<void>;
  entity: Revision['entity']; key: string; plural: string;
};
const handlers: Record<string, Handler> = {
  'cost-categories': { list: listCostCategories, read: getCostCategory, create: createCostCategory, alter: alterCostCategory, remove: deleteCostCategory, entity: 'cost_category', key: 'costCategory', plural: 'costCategories' },
  'cost-centres': { list: listCostCentres, read: getCostCentre, create: createCostCentre, alter: alterCostCentre, remove: deleteCostCentre, entity: 'cost_centre', key: 'costCentre', plural: 'costCentres' },
};

/**
 * Cost categories and cost centres (M2a slice 2), shaped like the masters routes: viewers read, owners, admins and
 * editors write; the company's cost centres setting is read by members and changed by owners and admins. The entry
 * prefill and the two reports are reads; each report has a CSV export, rate-limited like the others. Every route runs
 * through withCompany via runLedger, so a company the user cannot reach answers "not found".
 */
export const costCentresApi: SignedInArea = async ({ request, url, path, user }) => {
  const write = async (companyId: string, run: (context: LedgerContext, body: unknown) => Promise<unknown>) => {
    await limit(`masters:${user.id}`, 120);
    const body = await readLedgerBody(request);
    return runLedger(user.id, companyId, 'write', context => run(context, body));
  };

  let match = path.match(mastersRoute);
  if (match) {
    const [, companyId, rawKind, rawId, rawAction] = match as unknown as [string, string, string, string | undefined, string | undefined];
    const handler = handlers[rawKind.toLowerCase()];
    const itemId = rawId?.toLowerCase(), action = rawAction?.toLowerCase();
    if (!itemId) {
      if (request.method === 'GET') return json({ [handler.plural]: await runLedger(user.id, companyId, 'read', handler.list) });
      if (request.method === 'POST') return json({ [handler.key]: await write(companyId, handler.create) }, 201);
      return notAllowed('GET, POST');
    }
    if (action === 'revisions') {
      if (request.method !== 'GET') return notAllowed('GET');
      return json({ revisions: await runLedger(user.id, companyId, 'read', context => masterHistory(context, handler.entity, itemId, handler.read)) });
    }
    if (action === 'delete') {
      if (request.method !== 'POST') return notAllowed('POST');
      await write(companyId, (context, body) => handler.remove(context, itemId, body));
      return json({ deleted: true });
    }
    if (request.method === 'GET') return json({ [handler.key]: await runLedger(user.id, companyId, 'read', context => handler.read(context, itemId)) });
    if (request.method === 'POST') return json({ [handler.key]: await write(companyId, (context, body) => handler.alter(context, itemId, body)) });
    return notAllowed('GET, POST');
  }
  match = path.match(defaultRoute);
  if (match) {
    if (request.method !== 'GET') return notAllowed('GET');
    const ledgerId = match[2].toLowerCase();
    return json({ costDefault: await runLedger(user.id, match[1], 'read', context => costDefault(context, ledgerId)) });
  }
  match = path.match(settingRoute);
  if (match) {
    if (request.method === 'GET') return json({ costCentres: await runLedger(user.id, match[1], 'read', readCostCentresSetting) });
    if (request.method === 'POST') return json({ costCentres: await write(match[1], saveCostCentresSetting) });
    return notAllowed('GET, POST');
  }
  const summary = path.match(summaryRoute), breakup = summary ? null : path.match(breakupRoute);
  if (!summary && !breakup) return null;
  if (request.method !== 'GET') return notAllowed('GET');
  const companyId = (summary ?? breakup)![1];
  const centreId = breakup?.[2].toLowerCase();
  const exported = summary ? summary[2] : breakup![3];
  const query = queryOf(url, summary ? ['from', 'to', 'categoryId'] : ['from', 'to']);
  const read = (context: LedgerContext): Promise<CostCategorySummary | CostCentreBreakup> => centreId ? costCentreBreakup(context, centreId, query) : costCategorySummary(context, query);
  if (!exported) return json({ report: await runLedger(user.id, companyId, 'read', read) });
  await limit(`reports-export:${user.id}`, exportsPerMinute);
  const body = await runLedger(user.id, companyId, 'read', async context => {
    const report = await read(context);
    return csvDocument('centre' in report ? costCentreBreakupCsv(report, context.company.exponent) : costCategorySummaryCsv(report, context.company.exponent));
  });
  return csvResponse(`${summary ? 'cost-category-summary' : 'cost-centre-breakup'}-${query.from ?? ''}-to-${query.to ?? ''}.csv`, body);
};
