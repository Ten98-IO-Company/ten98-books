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
    `SELECT r.id, r.entity, r.entity_id AS "entityId", r.action, r.actor_id AS "actorId", u.name AS "actorName",
       to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, r.before, r.after
     FROM revision_log r LEFT JOIN "user" u ON u.id = r.actor_id
     WHERE r.company_id = $1 AND r.entity = $2 AND r.entity_id = $3 ORDER BY r.id`,
    [context.company.companyId, entity, entityId]);
  return rows;
}
