import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from './config.ts';
import { assertSchema, closeDatabase, getDatabase } from './db.ts';
import { assertApplicationRole, migrateDatabase, StartupError, startWhenDatabaseReady } from './startup-migrate.ts';
import { startWorker, stopJobs } from './jobs.ts';

class CliError extends Error {}

async function setup() {
  const secret = () => randomBytes(32).toString('hex');
  const [admin, migrator, application] = [secret(), secret(), secret()];
  const contents = [
    '# Keep this file private. Never commit it or paste it into support requests.',
    'APP_URL=http://localhost:3410', 'APP_PORT=3410', 'POSTGRES_PORT=55432',
    `POSTGRES_PASSWORD=${admin}`,
    `BOOKS_MIGRATOR_PASSWORD=${migrator}`,
    `BOOKS_APP_PASSWORD=${application}`,
    '# Host-run web and worker (pnpm dev, the built server) reach the Compose database on its loopback port.',
    `DATABASE_URL=postgres://books_app:${application}@localhost:55432/books`,
    `MIGRATION_DATABASE_URL=postgres://books_migrator:${migrator}@localhost:55432/books`,
    '# Integration tests only: creates and drops throwaway databases on this local server.',
    `TEST_ADMIN_DATABASE_URL=postgres://books_admin:${admin}@localhost:55432/postgres`,
    `AUTH_SECRET=${secret()}`, '',
  ].join('\n');
  try {
    await writeFile(join(process.cwd(), '.env'), contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('Setup stopped: .env already exists and was not changed.');
    throw new CliError('Setup could not create .env. Check directory permissions.');
  }
  console.log('Created .env with fresh credentials. No database was changed. Open the app and create the first account; it becomes the owner.');
}

async function migrate() {
  const applied = await migrateDatabase();
  console.log(applied.length ? `Database migrations applied: ${applied.join(', ')}.` : 'Database migrations already applied; all checksums verified.');
}

async function diagnose(checkWorker: boolean) {
  getConfig();
  console.log('Configuration: valid (credentials redacted).');
  const checks: [string, () => Promise<unknown>][] = [
    ['Database connection', () => getDatabase().pool.query('SELECT 1')],
    ['Database schema', assertSchema],
    ['Application role and row-level security', () => assertApplicationRole()],
  ];
  if (checkWorker) checks.push(['Worker heartbeat', async () => {
    const result = await getDatabase().pool.query(
      `SELECT 1 FROM worker_heartbeat WHERE id = 'foundation-worker'
       AND last_seen_at > now() - interval '30 seconds' AND last_seen_at <= now()`,
    );
    if (result.rows.length !== 1) throw new CliError('Worker has no recent heartbeat.');
  }]);
  for (const [label, check] of checks) {
    try {
      await check();
      console.log(`${label}: ready.`);
    } catch {
      console.error(`${label}: unavailable. Check configuration, permissions and service health.`);
      process.exitCode = 1;
    }
  }
}

async function worker() {
  await startWhenDatabaseReady('worker', async () => {
    await assertSchema();
    await startWorker();
  });
  console.log('Foundation worker ready.');
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
}

// Set once the built server has loaded: it then owns the process-wide pool, which this command must not close on return.
// A server that fails to load leaves the flag unset, so the pool is still closed and the process can exit.
let serving = false;

/** The container's web command: the schema is current and the role checked before the built server is loaded. */
async function startWeb() {
  await startWhenDatabaseReady('web', async () => {
    // Start the built server with a fresh pool; this one was only for the startup checks.
    await closeDatabase();
    await import(new URL('../../.output/server/index.mjs', import.meta.url).href);
    serving = true;
  });
}

try {
  const [command, option, ...extra] = process.argv.slice(2);
  const usage = 'Usage: cli.ts setup | migrate | start-web | worker | diagnose [worker]';
  if (extra.length || (option && !(command === 'diagnose' && option === 'worker'))) throw new CliError(usage);
  switch (command) {
    case 'setup': await setup(); break;
    case 'migrate': await migrate(); break;
    case 'start-web': await startWeb(); break;
    case 'worker': await worker(); break;
    case 'diagnose': await diagnose(option === 'worker'); break;
    default: throw new CliError(usage);
  }
} catch (error) {
  console.error(error instanceof CliError || error instanceof StartupError ? error.message
    : (error as { code?: string })?.code === 'SCHEMA_MISMATCH' ? 'Database schema is incompatible with this application. Use the matching image and migrations.'
    : 'Command failed. Check configuration, database availability and schema; credentials have been redacted.');
  process.exitCode = 1;
} finally {
  await stopJobs().catch(() => { console.error('Job shutdown failed.'); process.exitCode = 1; });
  if (!serving) await closeDatabase().catch(() => { console.error('Database shutdown failed.'); process.exitCode = 1; });
}
