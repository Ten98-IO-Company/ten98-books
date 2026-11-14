import type { WorkspaceRole } from '@ten98/runtime';
import type pg from 'pg';
import type { PoolClient } from 'pg';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';

/**
 * Company tenancy (D-03). A company is a project of a workspace; every table that holds company data is listed here, has
 * forced row-level security on `current_setting('app.company_ids', true)` and is read and written only inside
 * `withCompany`. Better Auth, team and pg-boss tables stay outside row-level security.
 */
export const accountingTables = ['company', 'account_group', 'ledger', 'voucher_type', 'voucher_counter', 'voucher', 'voucher_line', 'revision_log'] as const;

export type CompanyMode = 'read' | 'write';
export type CompanyAccess = { companyId: string; workspaceId: string; name: string; role: WorkspaceRole };

/** One answer for a missing company and for a company the user may not reach, so ids reveal nothing. */
export const companyNotFound = 'Company not found or unavailable.';
const writers: readonly string[] = ['owner', 'admin', 'editor'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sets, for the rest of the current transaction only, the companies row-level security admits. */
export async function setCompanyScope(client: PoolClient, companyIds: readonly string[]): Promise<void> {
  await client.query("SELECT set_config('app.company_ids', $1, true)", [companyIds.join(',')]);
}

/**
 * Discover's projectAccess check, taken inside the transaction. The project row and the caller's membership row are
 * share-locked until commit (the team controller's caller-membership convention), so a removal or demotion waits for
 * an in-flight company transaction and cannot commit between this check and its writes.
 */
async function companyAccess(client: PoolClient, userId: string, companyId: string, mode: CompanyMode): Promise<CompanyAccess> {
  if (!uuid.test(companyId)) throw new FoundationError(404, companyNotFound);
  const { rows } = await client.query<{ id: string; workspace_id: string; name: string; role: WorkspaceRole }>(
    `SELECT p.id, p.workspace_id, p.name, m.role FROM project p
     JOIN membership m ON m.workspace_id = p.workspace_id AND m.user_id = $2
     WHERE p.id = $1 FOR SHARE OF p, m`, [companyId.toLowerCase(), userId],
  );
  const row = rows[0];
  if (!row || (mode === 'write' && !writers.includes(row.role))) throw new FoundationError(404, companyNotFound);
  return { companyId: row.id, workspaceId: row.workspace_id, name: row.name, role: row.role };
}

/**
 * Authorizes `userId` for `companyId` and runs `run` in one transaction whose row-level security admits that company
 * only. Every company-scoped read and write, HTTP or job, goes through here. `outer` joins a transaction the caller
 * already holds (company creation inserts the project first); the caller then owns commit and rollback.
 */
export async function withCompany<T>(userId: string, companyId: string, mode: CompanyMode, run: (client: PoolClient, access: CompanyAccess) => Promise<T>, outer?: PoolClient): Promise<T> {
  if (outer) {
    const access = await companyAccess(outer, userId, companyId, mode);
    await setCompanyScope(outer, [access.companyId]);
    return run(outer, access);
  }
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const access = await companyAccess(client, userId, companyId, mode);
    await setCompanyScope(client, [access.companyId]);
    const result = await run(client, access);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Operator-safe refusal: names the failed checks, never connection details. */
export class DatabaseRoleError extends Error {
  constructor(problems: readonly string[]) {
    super(`The application database role is unsafe for company data: ${problems.join('; ')}. Connect web and worker with the non-owner application role.`);
    this.name = 'DatabaseRoleError';
  }
}

/**
 * The one company policy every accounting table must carry, as PostgreSQL stores it in pg_policies with whitespace,
 * parentheses and `::text` casts removed (so only deparse formatting is ignored, never the expression):
 *   company_id = ANY (string_to_array(current_setting('app.company_ids', true), ','))
 */
const companyPolicy = "company_id=ANYstring_to_arraycurrent_setting'app.company_ids',true,','";
const deparseNoise = String.raw`[\s()]|::text(\[\])?`;

/**
 * Boot and test assertion (D-03): the connected role is not a superuser, cannot bypass row-level security, neither owns
 * nor is a member of the owner of any application table, and every accounting table forces row-level security with
 * exactly one policy, the company policy, for every command and role (USING and WITH CHECK). Without this the policies
 * are silently inert or could be widened by an extra permissive policy.
 */
export async function assertDatabaseRoles(pool: pg.Pool | PoolClient, tables: readonly string[] = accountingTables): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: string[]; unforced: string[]; unpolicied: string[] }>(
    `SELECT r.rolsuper, r.rolbypassrls,
       ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND pg_has_role(current_user, c.relowner, 'MEMBER') ORDER BY 1) AS owned,
       ARRAY(SELECT t FROM unnest($1::text[]) t WHERE NOT EXISTS (
               SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity) ORDER BY 1) AS unforced,
       ARRAY(SELECT t FROM unnest($1::text[]) t WHERE NOT (
               (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t) = 1
               AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t
                 AND p.cmd = 'ALL' AND p.permissive = 'PERMISSIVE' AND p.roles = '{public}'::name[]
                 AND regexp_replace(p.qual, $2, '', 'g') = $3 AND regexp_replace(p.with_check, $2, '', 'g') = $3)) ORDER BY 1) AS unpolicied
     FROM pg_roles r WHERE r.rolname = current_user`, [tables, deparseNoise, companyPolicy],
  );
  const role = rows[0];
  const problems = !role ? ['the connected role was not found'] : [
    ...role.rolsuper ? ['it is a superuser'] : [],
    ...role.rolbypassrls ? ['it bypasses row-level security'] : [],
    ...role.owned.length ? [`it owns or inherits the owner of ${role.owned.join(', ')}`] : [],
    ...role.unforced.length ? [`row-level security is not enabled and forced on ${role.unforced.join(', ')}`] : [],
    ...role.unpolicied.length ? [`the company policy is missing, altered or accompanied by another policy on ${role.unpolicied.join(', ')}`] : [],
  ];
  if (problems.length) throw new DatabaseRoleError(problems);
}
