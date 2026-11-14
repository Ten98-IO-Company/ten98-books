import { join } from 'node:path';
import pg from 'pg';
import { createMigrationLedger } from '@ten98/runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import { getConfig } from './config.ts';
import { registerResourceCleanup } from './resource-cleanup.ts';

/**
 * D-07: PostgreSQL int8 (BIGINT, money in minor units) reads as `bigint`, never as a lossy number or a string. D-09: DATE
 * is a calendar date and stays its YYYY-MM-DD text, never a time-zone-shifted Date. Scoped to this application's pools,
 * so libraries with their own connections (pg-boss) keep their own parsing.
 */
export const pgTypes = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => format === 'binary' ? pg.types.getTypeParser(oid, format)
    : oid === pg.types.builtins.INT8 ? (value: string) => BigInt(value)
    : oid === pg.types.builtins.DATE ? (value: string) => value
    : pg.types.getTypeParser(oid, 'text')) as typeof pg.types.getTypeParser,
};

export function createPool(connectionString: string, options: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000, types: pgTypes, ...options });
  pool.on('error', () => console.error('Database connection failed; check database availability.'));
  return pool;
}

type Database = { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> };
// Nitro's entry and TanStack Start's SSR routes are separate bundles, each with its own copy of this module.
// The process-wide slot keeps one pool per process instead of one per bundle.
const key = Symbol.for('ten98-books.database');
const shared = globalThis as typeof globalThis & { [key]?: Database };
/** The application-role pool (DATABASE_URL), used by web and worker for every request and job. */
export function getDatabase() {
  if (!shared[key]) {
    const pool = createPool(getConfig().databaseUrl);
    shared[key] = { pool, db: drizzle(pool, { schema }) };
    // Any bundle's closure ends the shared pool; one registered by another bundle later finds it already closed.
    registerResourceCleanup('database', closeDatabase);
  }
  return shared[key];
}
export async function closeDatabase() {
  // Release the slot before ending, so a concurrent close from another bundle never ends the same pool twice.
  const database = shared[key];
  shared[key] = undefined;
  if (database) await database.pool.end();
}

export const migrationFiles = ['0001_foundation.sql', '0002_company.sql', '0004_ledger.sql'] as const;
/**
 * The one PostgreSQL advisory lock (two-integer form, scoped to this database) that serialises every migration:
 * the ledger takes it per transaction, and startup migration holds it at session level while it waits and applies.
 */
export const migrationLockKey = [109863, 1] as const;
/** First key of the shared team controller's per-email account-creation lock. */
export const emailLockKey = 109864;
export const migrationLedger = createMigrationLedger({ directory: join(process.cwd(), 'migrations'), files: migrationFiles, lockKey: migrationLockKey });

export const assertSchema = () => migrationLedger.assertCurrent(getDatabase().pool);
