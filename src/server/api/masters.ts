import type { Revision } from '../../lib/ledger.ts';
import { readLedgerBody, runLedger, type LedgerContext } from '../ledger/context.ts';
import {
  alterGroup, alterLedger, alterVoucherType, createGroup, createLedger, deleteGroup, deleteLedger,
  getGroup, getLedger, listGroups, listLedgers, listVoucherTypes, readVoucherType,
} from '../ledger/masters.ts';
import { listRevisions } from '../ledger/revisions.ts';
import { json, limit, type SignedInArea } from './http.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const route = new RegExp(`^/api/companies/(${uuid})/(groups|ledgers|voucher-types)(?:/(${uuid})(?:/(delete|revisions))?)?$`, 'i');
const notAllowed = (allow: string) => json({ error: 'Method not allowed.' }, 405, { allow });

type Kind = 'groups' | 'ledgers' | 'voucher-types';
type Handler = {
  list: (context: LedgerContext) => Promise<unknown>;
  read: (context: LedgerContext, id: string) => Promise<unknown>;
  create?: (context: LedgerContext, body: unknown) => Promise<unknown>;
  alter: (context: LedgerContext, id: string, body: unknown) => Promise<unknown>;
  remove?: (context: LedgerContext, id: string, body: unknown) => Promise<void>;
  entity: Revision['entity']; key: string;
};
const handlers: Record<Kind, Handler> = {
  groups: { list: listGroups, read: getGroup, create: createGroup, alter: alterGroup, remove: deleteGroup, entity: 'group', key: 'group' },
  ledgers: { list: listLedgers, read: getLedger, create: createLedger, alter: alterLedger, remove: deleteLedger, entity: 'ledger', key: 'ledger' },
  // M1 voucher types are the eight seeded ones: renamed, never created or deleted.
  'voucher-types': { list: listVoucherTypes, read: readVoucherType, alter: alterVoucherType, entity: 'voucher_type', key: 'voucherType' },
};

/**
 * Masters (groups, ledgers, voucher types) of one company. Every route runs through withCompany via runLedger: viewers
 * read, owners, admins and editors write; a company the user cannot reach answers "not found". State changes are POST,
 * so the central origin gate in api.ts covers them; the body is read before the company transaction opens.
 */
export const mastersApi: SignedInArea = async ({ request, path, user }) => {
  const match = path.match(route);
  if (!match) return null;
  const [, companyId, rawKind, rawId, rawAction] = match as unknown as [string, string, string, string | undefined, string | undefined];
  const kind = rawKind.toLowerCase() as Kind, action = rawAction?.toLowerCase();
  const handler = handlers[kind];
  const itemId = rawId?.toLowerCase();
  const write = async (run: (context: LedgerContext, body: unknown) => Promise<unknown>) => {
    await limit(`masters:${user.id}`, 120);
    const body = await readLedgerBody(request);
    return runLedger(user.id, companyId, 'write', context => run(context, body));
  };

  if (!itemId) {
    if (request.method === 'GET') return json({ [kind === 'voucher-types' ? 'voucherTypes' : kind]: await runLedger(user.id, companyId, 'read', handler.list) });
    const create = handler.create;
    if (request.method === 'POST' && create) return json({ [handler.key]: await write(create) }, 201);
    return notAllowed(create ? 'GET, POST' : 'GET');
  }
  if (action === 'revisions') {
    if (request.method !== 'GET') return notAllowed('GET');
    // History outlives the master: a deleted group or ledger keeps its log, so this does not require the row to exist.
    return json({ revisions: await runLedger(user.id, companyId, 'read', context => listRevisions(context, handler.entity, itemId)) });
  }
  if (action === 'delete') {
    const remove = handler.remove;
    if (!remove) return null;
    if (request.method !== 'POST') return notAllowed('POST');
    await write((context, body) => remove(context, itemId, body));
    return json({ deleted: true });
  }
  if (request.method === 'GET') return json({ [handler.key]: await runLedger(user.id, companyId, 'read', context => handler.read(context, itemId)) });
  if (request.method === 'POST') return json({ [handler.key]: await write((context, body) => handler.alter(context, itemId, body)) });
  return notAllowed('GET, POST');
};
