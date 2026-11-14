import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Integration tests run against a real PostgreSQL 18 with the two roles of D-03 already created (compose and CI do it):
 * DATABASE_URL connects as books_app, MIGRATION_DATABASE_URL as books_migrator, TEST_ADMIN_DATABASE_URL as a superuser
 * that only creates and drops the throwaway database. Each test file gets its own database, owned by the migrator.
 */
const local = new Set(['localhost', '127.0.0.1', '[::1]']);

function required(name: string): URL {
  const value = process.env[name];
  assert.ok(value, `${name} is required for integration tests.`);
  const url = new URL(value);
  assert.ok(local.has(url.hostname), `${name} must point at a local test server; integration tests create and drop databases.`);
  return url;
}

export type TestDatabase = { name: string; adminUrl: string; drop: () => Promise<void> };

/**
 * Creates a fresh database, points this process's DATABASE_URL and MIGRATION_DATABASE_URL at it and applies migrations:
 * all of them, or only `migrations` (a prefix of `migrationFiles`) to prepare a database as an earlier release left it.
 */
export async function freshDatabase(label: string, { migrations }: { migrations?: readonly string[] } = {}): Promise<TestDatabase> {
  const admin = required('TEST_ADMIN_DATABASE_URL'), application = required('DATABASE_URL'), migrator = required('MIGRATION_DATABASE_URL');
  process.env.AUTH_SECRET ??= randomBytes(32).toString('hex');
  const name = `books_${label}_${randomBytes(4).toString('hex')}`;
  const client = new pg.Client({ connectionString: admin.href });
  await client.connect();
  try { await client.query(`CREATE DATABASE ${name} OWNER books_migrator`); } finally { await client.end(); }
  for (const [key, url] of [['DATABASE_URL', application], ['MIGRATION_DATABASE_URL', migrator]] as const) {
    url.pathname = `/${name}`;
    process.env[key] = url.href;
  }
  const scoped = new URL(admin.href); scoped.pathname = `/${name}`;
  const { migrateDatabase } = await import('../../src/server/startup-migrate.ts');
  const { createMigrationLedger } = await import('@ten98/runtime');
  const { migrationLedger, migrationLockKey } = await import('../../src/server/db.ts');
  const ledger = migrations ? createMigrationLedger({ directory: join(process.cwd(), 'migrations'), files: migrations, lockKey: migrationLockKey }) : migrationLedger;
  await migrateDatabase({ ledger, log: () => undefined });
  return {
    name, adminUrl: scoped.href,
    drop: async () => {
      const { closeDatabase } = await import('../../src/server/db.ts');
      await closeDatabase();
      const cleanup = new pg.Client({ connectionString: admin.href });
      await cleanup.connect();
      try { await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await cleanup.end(); }
    },
  };
}

/** A cookie jar over handleApi, so tests drive the real HTTP contract in process. */
export class Browser {
  readonly cookies = new Map<string, string>();
  private readonly handle: (request: Request) => Promise<Response>;
  private readonly appUrl: string;
  constructor(handle: (request: Request) => Promise<Response>, appUrl: string) { this.handle = handle; this.appUrl = appUrl; }

  /** GET without a body, POST with one. `origin` defaults to the application's own; null sends no Origin header. */
  async call(path: string, body?: unknown, origin: string | null = this.appUrl): Promise<{ status: number; body: any }> {
    const headers = new Headers();
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    if (body !== undefined) { headers.set('content-type', 'application/json'); if (origin !== null) headers.set('origin', origin); }
    const response = await this.handle(new Request(new URL(path, this.appUrl), { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index), value = pair.slice(index + 1);
      if (value === '' || /max-age=0/i.test(cookie)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
}
