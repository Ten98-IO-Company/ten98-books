import { runLedger } from '../ledger/context.ts';
import { readLastRate, readStockQuantity } from '../ledger/item-lines.ts';
import { json, type SignedInArea } from './http.ts';
import { queryOf } from './reports.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const readRoute = new RegExp(`^/api/companies/(${uuid})/stock-items/(${uuid})/(stock|last-rate)$`, 'i');

/**
 * Stock reads (M2b slice b2): an item's quantity at a date, and its last sale rate. Reads only: members of any role,
 * through withCompany via runLedger, so a company the user cannot reach, or an item of another company, answers
 * "not found".
 */
export const stockReadsApi: SignedInArea = async ({ request, url, path, user }) => {
  const match = path.match(readRoute);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, { allow: 'GET' });
  const [, companyId, rawItem, read] = match as unknown as [string, string, string, string];
  const itemId = rawItem.toLowerCase();
  if (read.toLowerCase() === 'stock') {
    return json({ stock: await runLedger(user.id, companyId, 'read', context => readStockQuantity(context, itemId, queryOf(url, ['date', 'locationId']))) });
  }
  return json({ lastRate: await runLedger(user.id, companyId, 'read', context => readLastRate(context, itemId, queryOf(url, ['date']))) });
};
