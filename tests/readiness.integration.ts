import assert from 'node:assert/strict';
import { connect, createServer, type Server, type Socket } from 'node:net';
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
const pastShare = () => new Promise(resolve => setTimeout(resolve, 1100));
/**
 * Probes until ready, at most three times a share window apart. A check over a new connection can run past its 2-second
 * step on a loaded machine; where a test needs readiness (a warm-up, or a recovery that must come) rather than checks
 * it, one slow check is not a failure. A connection that stays broken still fails every try.
 */
async function readyWithin(tries = 3): Promise<{ status: number; body: unknown; ms: number }> {
  let answer = await probe();
  for (let attempt = 1; attempt < tries && answer.status !== 200; attempt += 1) { await pastShare(); answer = await probe(); }
  return answer;
}

/**
 * A TCP proxy in front of the test database: it counts the queries clients send (simple `Q` and extended `P` messages,
 * after the startup message) and, while `held`, drops what the database sends back, as a network that stalls.
 */
async function databaseProxy() {
  const target = new URL(databaseUrl);
  const state = { queries: 0, held: false, port: 0, url: '', close: () => undefined as void };
  const sockets = new Set<Socket>();
  const server = createServer(client => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => undefined); socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); }); }
    let pending = Buffer.alloc(0), started = false;
    client.on('data', chunk => {
      upstream.write(chunk);
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const header = started ? 5 : 4;
        if (pending.length < header) break;
        const size = started ? 1 + pending.readInt32BE(1) : pending.readInt32BE(0);
        if (pending.length < size) break;
        if (started && (pending[0] === 0x51 || pending[0] === 0x50)) state.queries += 1;
        pending = pending.subarray(size);
        started = true;
      }
    });
    upstream.on('data', chunk => { if (!state.held) client.write(chunk); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as { port: number }).port;
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1'; url.port = String(state.port);
  state.url = url.href;
  state.close = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  return state;
}

test('ready while the database is there', async () => {
  assert.deepEqual((await readyWithin()).body, { status: 'ready' });
});

test('503 within the bound for a refused connection, a database that never answers, a role or database that does not exist, never 500', async () => {
  const bound = 2 * readinessStepMs + 1500;
  const cases: [string, (url: URL) => void][] = [
    ['connection refused', url => { url.hostname = '127.0.0.1'; url.port = '1'; }],
    ['a port that accepts and never answers', url => { url.hostname = '127.0.0.1'; url.port = String(silentPort); }],
    // Refused the same way under password and trust authentication (a wrong password is not: trust lets it in).
    ['a role that does not exist', url => { url.username = 'books_no_such_role'; }],
    ['a database that does not exist', url => { url.pathname = '/books_no_such_database'; }],
  ];
  for (const [what, change] of cases) {
    const answer = await withDatabaseUrl(change);
    assert.deepEqual([answer.status, answer.body], [503, notReady], what);
    assert.ok(answer.ms < bound, `${what}: ${Math.round(answer.ms)} ms, bound ${bound}`);
  }
  assert.deepEqual((await readyWithin()).body, { status: 'ready' }, 'ready again once the database is back');
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
  assert.deepEqual((await readyWithin()).body, { status: 'ready' }, 'ready again once the lock is gone');
});

test('a kept connection cut while the database stays up is replaced: past the share window the probe answers 200', async () => {
  const { asAdmin } = await import('./helpers/ledger.ts');
  await pastShare();
  assert.deepEqual((await readyWithin()).body, { status: 'ready' }, 'ready, with its connection kept');
  const cut = await asAdmin(database.adminUrl, async admin => (await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'books-readiness' AND datname = current_database()")).rowCount);
  assert.equal(cut, 1, 'the one probe connection was cut');
  await pastShare();
  // The first check finds the connection dead (one 503, shared for a second); the check after it connects again.
  await probe();
  await pastShare();
  assert.deepEqual((await readyWithin()).body, { status: 'ready' }, 'a new connection after the failed check');
});

test('while healthy, back-to-back probes inside the share window run no query of their own', async () => {
  const proxy = await databaseProxy();
  process.env.DATABASE_URL = proxy.url;
  try {
    assert.equal((await readyWithin()).status, 200);
    const oneCheck = proxy.queries;
    assert.ok(oneCheck > 0, 'the proxy counts the queries of a check');
    for (let index = 0; index < 20; index += 1) assert.equal((await probe()).status, 200);
    assert.equal(proxy.queries, oneCheck, `20 more probes ran no query (one check is ${oneCheck})`);
  } finally { process.env.DATABASE_URL = databaseUrl; proxy.close(); }
});

test('a kept connection whose network stalls is given up at the statement bound, and the next check connects again', { timeout: 20_000 }, async () => {
  const proxy = await databaseProxy();
  process.env.DATABASE_URL = proxy.url;
  try {
    assert.equal((await readyWithin()).status, 200);
    await pastShare();
    // The server answers; nothing reaches the client. Only the client's own query bound ends the wait.
    proxy.held = true;
    const stalled = await probe();
    assert.deepEqual([stalled.status, stalled.body], [503, notReady], 'stalled');
    assert.ok(stalled.ms >= readinessStepMs - 100 && stalled.ms < readinessStepMs + 1500, `stalled: ${Math.round(stalled.ms)} ms`);
    proxy.held = false;
    await pastShare();
    assert.equal((await readyWithin()).status, 200, 'ready again through a new connection');
  } finally { process.env.DATABASE_URL = databaseUrl; proxy.close(); }
});

test('150 concurrent probes hold at most one probe connection while application requests beside them answer', async () => {
  const { asAdmin } = await import('./helpers/ledger.ts');
  const { setupOwner } = await import('./helpers/ledger.ts');
  const owner = await setupOwner();
  const probes = Array.from({ length: 150 }, () => probe());
  const requests = Array.from({ length: 20 }, () => owner.browser.call('/api/companies'));
  const counted = asAdmin(database.adminUrl, async admin => Number((await admin.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = 'books-readiness' AND datname = current_database()")).rows[0].count));
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
  assert.deepEqual((await readyWithin()).body, { status: 'ready' }, 'ready again once the database is back');
});
