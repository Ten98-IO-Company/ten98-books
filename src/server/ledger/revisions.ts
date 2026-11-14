import type { Revision } from '../../lib/ledger.ts';
import { toJson } from '../api/http.ts';
import type { LedgerContext } from './context.ts';

/**
 * The append-only revision log (D-04): every create, alter, cancel and delete of a master or voucher writes one row in
 * the same transaction as the change, with who, when and the before and after snapshots. Snapshots are the domain
 * objects the API returns, with amounts kept as exact minor-unit strings.
 */
export async function logRevision(context: LedgerContext, entity: Revision['entity'], entityId: string, action: Revision['action'], before: unknown, after: unknown): Promise<void> {
  await context.client.query(
    `INSERT INTO revision_log (company_id, entity, entity_id, action, actor_id, before, after) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [context.company.companyId, entity, entityId, action, context.userId, before == null ? null : toJson(before), after == null ? null : toJson(after)]);
}

/** The history of one master or voucher, oldest first. */
export async function listRevisions(context: LedgerContext, entity: Revision['entity'], entityId: string): Promise<Revision[]> {
  const { rows } = await context.client.query<Revision>(
    `SELECT id, entity, entity_id AS "entityId", action, actor_id AS "actorId", to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, before, after
     FROM revision_log WHERE company_id = $1 AND entity = $2 AND entity_id = $3 ORDER BY id`,
    [context.company.companyId, entity, entityId]);
  return rows;
}
