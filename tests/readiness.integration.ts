import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { after, before, test } from 'node:test';
import { handleApi, readinessStepMs } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';

/**
 * The readiness probe answers 503 with its fixed body for every failure to reach or use the database, never 500, within
 * its bound (each step `readinessStepMs`: connecting, and each statement), and 200 when the database is there.
 */
let database: TestDatabase;
let silent: Server;
let silentPort = 0;
const original = () => process.env.DATABASE_URL!;
let databaseUrl = '';

before(async () => {
  database = await freshDatabase('readiness');
  databaseUrl = original();
  // A port that accepts connections and never answers.
  silent = createServer(() => undefined);
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
  silentPort = (silent.address() as { port: number }).port;
});
after(async () => { process.env.DATABASE_URL = databaseUrl; silent?.close(); await database?.drop(); });

async function probe(): Promise<{ status: number; body: unknown; ms: number }> {
  const started = performance.now();
  const response = await handleApi(new Request(new URL('/api/health/ready', getConfig().appUrl)));
  return { status: response.status, body: await response.json(), ms: performance.now() - started };
}
const withDatabaseUrl = async (change: (url: URL) => void) => {
  const url = new URL(databaseUrl);
  change(url);
  process.env.DATABASE_URL = url.href;
  try { return await probe(); } finally { process.env.DATABASE_URL = databaseUrl; }
};
const notReady = { error: 'The installation is not ready. Check configuration and database migrations.' };

test('ready while the database is there', async () => {
  assert.deepEqual((await probe()).body, { status: 'ready' });
});

test('503 within the bound for a refused connection, a database that never answers and a refused role, never 500', async () => {
  const bound = 2 * readinessStepMs + 1500;
  const cases: [string, (url: URL) => void][] = [
    ['connection refused', url => { url.hostname = '127.0.0.1'; url.port = '1'; }],
    ['a port that accepts and never answers', url => { url.hostname = '127.0.0.1'; url.port = String(silentPort); }],
    ['the application role refused', url => { url.password = 'not-the-password'; }],
  ];
  for (const [what, change] of cases) {
    const answer = await withDatabaseUrl(change);
    assert.deepEqual([answer.status, answer.body], [503, notReady], what);
    assert.ok(answer.ms < bound, `${what}: ${Math.round(answer.ms)} ms, bound ${bound}`);
  }
  assert.deepEqual((await probe()).body, { status: 'ready' }, 'ready again once the database is back');
});

test('503 within the bound for a database that accepts and then stalls, and for a role that connects but is the wrong one', async () => {
  const bound = 2 * readinessStepMs + 1500;
  const { asAdmin } = await import('./helpers/ledger.ts');
  const pastShare = () => new Promise(resolve => setTimeout(resolve, 1100));
  await pastShare();
  // The connection opens; the ledger read then waits on a lock until the statement budget ends it.
  const stalled = await asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query('LOCK TABLE schema_version IN ACCESS EXCLUSIVE MODE');
    try { return await probe(); } finally { await admin.query('ROLLBACK'); }
  });
  assert.deepEqual([stalled.status, stalled.body], [503, notReady], 'stalled');
  assert.ok(stalled.ms >= readinessStepMs - 100 && stalled.ms < bound, `stalled: ${Math.round(stalled.ms)} ms, bound ${bound}`);
  // The migration owner connects and reads the ledger, but serving as it would make row-level security inert.
  const owner = await withDatabaseUrl(url => { const migrator = new URL(process.env.MIGRATION_DATABASE_URL!); url.username = migrator.username; url.password = migrator.password; });
  assert.deepEqual([owner.status, owner.body], [503, notReady], 'the migration owner as the application role');
  // A failed result is shared for a second after it ends; past that the probe checks again.
  await pastShare();
  assert.deepEqual((await probe()).body, { status: 'ready' }, 'ready again once the lock is gone');
});

test('150 concurrent probes hold at most one probe connection while application requests beside them answer', async () => {
  const { asAdmin } = await import('./helpers/ledger.ts');
  const { setupOwner } = await import('./helpers/ledger.ts');
  const owner = await setupOwner();
  const probes = Array.from({ length: 150 }, () => probe());
  const requests = Array.from({ length: 20 }, () => owner.browser.call('/api/companies'));
  const counted = asAdmin(database.adminUrl, async admin => Number((await admin.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'books-readiness'")).rows[0].count));
  const [answers, appAnswers, probeBackends] = await Promise.all([Promise.all(probes), Promise.all(requests), counted]);
  assert.ok(answers.every(answer => answer.status === 200), answers.map(answer => answer.status).join(','));
  assert.ok(appAnswers.every(answer => answer.status === 200), appAnswers.map(answer => answer.status).join(','));
  assert.ok(probeBackends <= 1, `${probeBackends} probe backends`);
});

test('a probe storm against a database that never answers makes one connection attempt at a time, leaks none, and recovers', async () => {
  let open = 0, most = 0, total = 0;
  const watched = createServer(socket => { total += 1; open += 1; most = Math.max(most, open); socket.on('close', () => { open -= 1; }); socket.on('error', () => undefined); socket.resume(); });
  await new Promise<void>(resolve => watched.listen(0, '127.0.0.1', resolve));
  const port = (watched.address() as { port: number }).port;
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1'; url.port = String(port);
  process.env.DATABASE_URL = url.href;
  try {
    const answers = await Promise.all(Array.from({ length: 150 }, () => probe()));
    assert.ok(answers.every(answer => answer.status === 503), answers.map(answer => answer.status).join(','));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(most, 1, `one connection attempt at a time (most ${most})`);
    assert.equal(open, 0, `no connection left open (${open} open of ${total})`);
  } finally { process.env.DATABASE_URL = databaseUrl; watched.close(); }
  assert.deepEqual((await probe()).body, { status: 'ready' }, 'ready again once the database is back');
});
