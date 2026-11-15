import type { Revision } from '../../lib/ledger.ts';
import { readLedgerBody, runLedger, type LedgerContext } from '../ledger/context.ts';
import { masterHistory } from '../ledger/revisions.ts';
import {
  alterItem, alterTree, alterUnit, createItem, createTree, createUnit, deleteItem, deleteTree, deleteUnit, getTree, getUnit,
  listItems, listTree, listUnits, readInventorySetting, readItem, saveInventorySetting, treeKinds, type TreeKindName,
} from '../ledger/stock-masters.ts';
import { json, methodNotAllowed, limit, type SignedInArea } from './http.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const company = `^/api/companies/(${uuid})`;
/**
 * Stock master bodies: an item carries at most 500 opening rows (`openings`, src/lib/stock.ts). A row at its bounds is under
 * 256 bytes (a location id and three 40-character numbers), plus 4 KiB for the item's own fields.
 */
export const stockBodyBytes = 500 * 256 + 4096;
const mastersRoute = new RegExp(`${company}/(stock-units|stock-groups|stock-categories|stock-locations|stock-items)(?:/(${uuid})(?:/(delete|revisions))?)?$`, 'i');
const settingRoute = new RegExp(`${company}/inventory-setting$`, 'i');

type Handler = {
  list: (context: LedgerContext) => Promise<unknown>;
  read: (context: LedgerContext, id: string) => Promise<unknown>;
  create: (context: LedgerContext, body: unknown) => Promise<unknown>;
  alter: (context: LedgerContext, id: string, body: unknown) => Promise<unknown>;
  remove: (context: LedgerContext, id: string, body: unknown) => Promise<void>;
  entity: Revision['entity']; key: string; plural: string;
};
const treeHandler = (kind: TreeKindName, entity: Revision['entity'], key: string, plural: string): Handler => ({
  list: context => listTree(context, kind), read: (context, id) => getTree(context, kind, id), create: (context, body) => createTree(context, kind, body),
  alter: (context, id, body) => alterTree(context, kind, id, body), remove: (context, id, body) => deleteTree(context, kind, id, body), entity, key, plural,
});
const handlers: Record<string, Handler> = {
  'stock-units': { list: listUnits, read: getUnit, create: createUnit, alter: alterUnit, remove: deleteUnit, entity: 'stock_unit', key: 'stockUnit', plural: 'stockUnits' },
  'stock-groups': treeHandler('stock-groups', 'stock_group', 'stockGroup', 'stockGroups'),
  'stock-categories': treeHandler('stock-categories', 'stock_category', 'stockCategory', 'stockCategories'),
  'stock-locations': treeHandler('stock-locations', 'stock_location', 'stockLocation', 'stockLocations'),
  'stock-items': { list: listItems, read: (context, id) => readItem(context, id), create: createItem, alter: alterItem, remove: deleteItem, entity: 'stock_item', key: 'stockItem', plural: 'stockItems' },
};
if (treeKinds.some(kind => !handlers[kind])) throw new Error('Every stock master tree needs a route.');

/**
 * Stock masters (M2b slice a), shaped like the other masters routes: viewers read, owners, admins and editors write;
 * the company's inventory switch is read by members and changed by owners and admins. Every route runs through
 * withCompany via runLedger, so a company the user cannot reach answers "not found".
 */
export const stockMastersApi: SignedInArea = async ({ request, path, user }) => {
  const write = async (companyId: string, run: (context: LedgerContext, body: unknown) => Promise<unknown>) => {
    await limit(`masters:${user.id}`, 120);
    const body = await readLedgerBody(request, stockBodyBytes);
    return runLedger(user.id, companyId, 'write', context => run(context, body));
  };

  const match = path.match(mastersRoute);
  if (match) {
    const [, companyId, rawKind, rawId, rawAction] = match as unknown as [string, string, string, string | undefined, string | undefined];
    const handler = handlers[rawKind.toLowerCase()];
    const itemId = rawId?.toLowerCase(), action = rawAction?.toLowerCase();
    if (!itemId) {
      if (request.method === 'GET') return json({ [handler.plural]: await runLedger(user.id, companyId, 'read', handler.list) });
      if (request.method === 'POST') return json({ [handler.key]: await write(companyId, handler.create) }, 201);
      return methodNotAllowed('GET, POST');
    }
    if (action === 'revisions') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      return json({ revisions: await runLedger(user.id, companyId, 'read', context => masterHistory(context, handler.entity, itemId, handler.read)) });
    }
    if (action === 'delete') {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      await write(companyId, (context, body) => handler.remove(context, itemId, body));
      return json({ deleted: true });
    }
    if (request.method === 'GET') return json({ [handler.key]: await runLedger(user.id, companyId, 'read', context => handler.read(context, itemId)) });
    if (request.method === 'POST') return json({ [handler.key]: await write(companyId, (context, body) => handler.alter(context, itemId, body)) });
    return methodNotAllowed('GET, POST');
  }
  const setting = path.match(settingRoute);
  if (!setting) return null;
  if (request.method === 'GET') return json({ inventory: await runLedger(user.id, setting[1], 'read', readInventorySetting) });
  if (request.method === 'POST') return json({ inventory: await write(setting[1], saveInventorySetting) });
  return methodNotAllowed('GET, POST');
};
