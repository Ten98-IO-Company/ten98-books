import type pg from 'pg';
import { migrateOnStart as migrateOnStartSetting } from '@ten98/runtime';
import { getConfig } from './config.ts';
import { createPool, getDatabase, migrationLedger } from './db.ts';
import { assertDatabaseRoles, DatabaseRoleError } from './tenancy.ts';

// Web and worker apply pending migrations themselves before serving or working (MIGRATE_ON_START, default on), through the
// migrator role. The shared runner holds the database's one advisory lock, so only one process migrates at a time; the
// others wait for the lock and then find nothing pending. No external request is made here.

/** Bound for the connect, the lock wait plus the migration, and for the opt-out schema wait. */
export const startupMigrationTimeoutMs = 5 * 60_000;

/** Startup failures carry operator-safe text only: never SQL, parameters, connection strings or credentials. */
export class StartupError extends Error {}

type Ledger = Pick<typeof migrationLedger, 'migrateWithDeadline' | 'waitForCurrent'>;
type Log = (message: string) => void;
export type MigrationOptions = { pool?: pg.Pool; ledger?: Ledger; timeoutMs?: number; log?: Log };

/** MIGRATE_ON_START: unset, empty, `true` or `1` migrates at startup; `false` or `0` waits for an operator migration. */
export function migrateOnStart(env: NodeJS.ProcessEnv = process.env): boolean {
  try { return migrateOnStartSetting(env.MIGRATE_ON_START); }
  catch { throw new StartupError('MIGRATE_ON_START must be true or false.'); }
}

const fixCause = 'Fix the cause, then restart or run the migrate command.';

/** Maps a runner failure to operator-safe text; anything unrecognised (such as a connection error) becomes `generic`. */
function startupError(error: unknown, generic: string): unknown {
  const { code, sqlState } = (error ?? {}) as { code?: unknown; sqlState?: unknown };
  if (code === 'SCHEMA_MISMATCH') return error;
  if (code === 'MIGRATION_TIMEOUT') return new StartupError((error as Error).message);
  if (code === 'MIGRATION_FAILED') {
    const state = typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? ` (PostgreSQL error ${sqlState})` : '';
    return new StartupError(`Database migration failed${state} and was rolled back; nothing was applied. ${fixCause}`);
  }
  return new StartupError(generic);
}

/**
 * Applies pending migrations in the ledger's single transaction, connected as the migrator (MIGRATION_DATABASE_URL).
 * `cli.ts migrate` and both startup paths use this one routine.
 */
export async function migrateDatabase({ pool, ledger = migrationLedger, timeoutMs = startupMigrationTimeoutMs, log = console.log }: MigrationOptions = {}): Promise<readonly string[]> {
  const url = getConfig().migrationDatabaseUrl;
  if (!pool && !url) throw new StartupError('MIGRATION_DATABASE_URL is required to apply migrations; it connects as the migrator role that owns the tables.');
  const migrator = pool ?? createPool(url!, { max: 2 });
  try {
    return await ledger.migrateWithDeadline(migrator, { timeoutMs, log });
  } catch (error) { throw startupError(error, `Database migration failed and was rolled back; nothing was applied. ${fixCause}`); }
  finally { if (!pool) await migrator.end().catch(() => undefined); }
}

/** Opt-out path: polls the schema check (no writes) until it is current, or fails at the deadline. */
export async function waitForCurrentSchema({ pool = getDatabase().pool, ledger = migrationLedger, timeoutMs = startupMigrationTimeoutMs, log = console.log, intervalMs = 2_000 }: MigrationOptions & { intervalMs?: number } = {}): Promise<void> {
  try { await ledger.waitForCurrent(pool, { timeoutMs, intervalMs, log }); }
  catch (error) { throw startupError(error, 'The database schema could not be checked. Run the migrate command, or leave MIGRATE_ON_START enabled.'); }
}

/** D-03 boot gate on the application pool: refuses to start as an owner, superuser or BYPASSRLS role. */
export async function assertApplicationRole(pool: pg.Pool = getDatabase().pool): Promise<void> {
  try { await assertDatabaseRoles(pool); }
  catch (error) { throw error instanceof DatabaseRoleError ? new StartupError(error.message) : new StartupError('The application database role could not be checked. Check DATABASE_URL and database availability.'); }
}

export type StartupRole = 'web' | 'worker';
export type StartupDependencies = { env?: NodeJS.ProcessEnv; migrate?: () => Promise<readonly string[]>; waitForSchema?: () => Promise<void>; assertRole?: () => Promise<void>; log?: Log };

/** Brings the schema current (or waits for it), checks the application role, then starts. A rejection means `start` never ran. */
export async function startWhenDatabaseReady(role: StartupRole, start: () => Promise<void>, { env = process.env, migrate = migrateDatabase, waitForSchema = waitForCurrentSchema, assertRole = assertApplicationRole, log = console.log }: StartupDependencies = {}): Promise<void> {
  if (migrateOnStart(env)) {
    const applied = await migrate();
    log(applied.length ? `Database migrations applied before ${role} start: ${applied.join(', ')}.` : `Database schema is current; ${role} starting.`);
  } else {
    await waitForSchema();
  }
  await assertRole();
  await start();
}
