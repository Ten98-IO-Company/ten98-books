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
