import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { getDatabase } from '../src/server/db.ts';
import { Browser, freshDatabase, type TestDatabase } from './helpers/database.ts';

let database: TestDatabase;
let admin: pg.Client;
let a: Browser, b: Browser;
const ids = { a: '', b: '' };
const password = 'correct horse battery staple';
const browser = () => new Browser(handleApi, getConfig().appUrl);

/** The shared Browser sends only GET and POST; the keymap is written with PUT, carrying the same cookies. */
async function put(from: Browser, body: unknown, { path = '/api/account/keymap', origin = getConfig().appUrl as string | null, type = 'application/json', method = 'PUT' } = {}) {
  const headers = new Headers({ 'content-type': type });
  if (origin !== null) headers.set('origin', origin);
  if (from.cookies.size) headers.set('cookie', [...from.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
  const response = await handleApi(new Request(new URL(path, getConfig().appUrl), { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const rows = async () => (await admin.query<{ user_id: string; keymap: string }>('SELECT user_id, keymap FROM user_keymap ORDER BY keymap')).rows;

before(async () => {
  database = await freshDatabase('keymap');
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  a = browser(); b = browser();
  assert.equal((await a.call('/api/auth/setup', { name: 'A', email: `a-${randomUUID()}@books.test`, password, workspaceName: 'W1' })).status, 200);
  ids.a = (await a.call('/api/me')).body.user.id;
  const workspace = (await a.call('/api/me')).body.workspaces[0].id;
  const invite = (await a.call(`/api/workspaces/${workspace}/invitations`, { email: `b-${randomUUID()}@books.test`, role: 'viewer' })).body.inviteUrl as string;
  assert.equal((await b.call('/api/invitations/accept', { token: new URL(invite).hash.replace('#invite=', ''), name: 'B', password })).body.signedIn, true);
  ids.b = (await b.call('/api/me')).body.user.id;
  assert.ok(ids.a && ids.b && ids.a !== ids.b);
});
after(async () => { await admin?.end(); await database?.drop(); });

test('the keymap table is owned by the migrator, and the application role may read, add and change rows only', async () => {
  const owner = (await admin.query("SELECT tableowner FROM pg_tables WHERE tablename='user_keymap'")).rows[0]?.tableowner;
  assert.equal(owner, 'books_migrator');
  const privileges = (await admin.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='user_keymap' AND grantee='books_app' ORDER BY 1")).rows.map(row => row.privilege_type);
  assert.deepEqual(privileges, ['INSERT', 'SELECT', 'UPDATE']);
  const columns = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='user_keymap' ORDER BY ordinal_position")).rows.map(row => row.column_name);
  assert.deepEqual(columns, ['user_id', 'keymap', 'updated_at'], 'an account setting, with no company column');
  await assert.rejects(getDatabase().pool.query('DELETE FROM user_keymap'), /permission denied/);
  await assert.rejects(getDatabase().pool.query("INSERT INTO user_keymap(user_id, keymap) VALUES ($1, 'vim')", [ids.a]), /user_keymap_keymap_check/);
});

test('an unauthenticated request can neither read nor write a keymap', async () => {
  const stranger = browser();
  assert.equal((await stranger.call('/api/account/keymap')).status, 401);
  assert.equal((await put(stranger, { keymap: 'classic' })).status, 401);
  assert.deepEqual(await rows(), []);
});

test('a user without a saved keymap gets web-safe, not yet chosen', async () => {
  assert.deepEqual((await a.call('/api/account/keymap')).body, { keymap: 'web-safe', chosen: false });
});

test('a user saves and reads back their own keymap', async () => {
  assert.deepEqual(await put(a, { keymap: 'classic' }), { status: 200, body: { keymap: 'classic', chosen: true } });
  assert.deepEqual((await a.call('/api/account/keymap')).body, { keymap: 'classic', chosen: true });
  assert.deepEqual(await put(a, { keymap: 'web-safe' }), { status: 200, body: { keymap: 'web-safe', chosen: true } });
  assert.deepEqual(await put(a, { keymap: 'classic' }), { status: 200, body: { keymap: 'classic', chosen: true } });
  assert.deepEqual(await rows(), [{ user_id: ids.a, keymap: 'classic' }]);
});

test("one user can neither read nor write another user's keymap", async () => {
  assert.deepEqual((await b.call('/api/account/keymap')).body, { keymap: 'web-safe', chosen: false }, "B does not see A's choice");
  assert.deepEqual((await b.call(`/api/account/keymap?userId=${ids.a}&user_id=${ids.a}`)).body, { keymap: 'web-safe', chosen: false }, 'a user id in the query is ignored');
  assert.equal((await put(b, { keymap: 'web-safe', userId: ids.a })).status, 400, 'a user id in the body is refused');
  assert.equal((await put(b, { keymap: 'web-safe' }, { path: `/api/account/keymap?userId=${ids.a}` })).status, 200);
  assert.deepEqual(await rows(), [{ user_id: ids.a, keymap: 'classic' }, { user_id: ids.b, keymap: 'web-safe' }], "B's write landed on B's row only");
  assert.deepEqual((await a.call('/api/account/keymap')).body, { keymap: 'classic', chosen: true });
});

test('the endpoint refuses bad input, other methods and cross-origin writes, and changes nothing', async () => {
  const before = await rows();
  for (const body of [{ keymap: 'vim' }, { keymap: 'Classic' }, {}, { keymap: null }, 'not json']) assert.equal((await put(a, body)).status, 400, JSON.stringify(body));
  assert.equal((await put(a, { keymap: 'web-safe' }, { type: 'text/plain' })).status, 415);
  assert.equal((await put(a, { keymap: 'web-safe' }, { origin: null })).status, 403);
  assert.equal((await put(a, { keymap: 'web-safe' }, { origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await put(a, { keymap: 'web-safe' }, { method: 'POST' })).status, 405);
  assert.equal((await put(a, { keymap: 'web-safe' }, { method: 'DELETE' })).status, 405);
  assert.deepEqual(await rows(), before);
});

test("removing a user removes their keymap through the foreign key, as the application role", async () => {
  await getDatabase().pool.query('DELETE FROM "user" WHERE id=$1', [ids.b]);
  assert.deepEqual(await rows(), [{ user_id: ids.a, keymap: 'classic' }]);
});
