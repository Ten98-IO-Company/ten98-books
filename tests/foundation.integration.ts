import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { Browser, freshDatabase, type TestDatabase } from './helpers/database.ts';

let database: TestDatabase;
let admin: pg.Client;
const owner = { name: 'Owner One', email: `owner-${randomUUID()}@books.test`, password: 'correct horse battery staple', workspaceName: 'Acme Holdings' };
const browser = () => new Browser(handleApi, getConfig().appUrl);
const company = { name: 'Acme Trading LLC', baseCurrency: 'KWD', financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-04-01', timeZone: 'Asia/Kuwait', secondLanguageName: 'أكمي' };

before(async () => {
  database = await freshDatabase('foundation');
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
});
after(async () => { await admin?.end(); await database?.drop(); });

const count = async (sql: string) => Number((await admin.query(sql)).rows[0].count);

test('first-user setup creates the user, workspace and owner membership once and cannot be reopened', async () => {
  const first = browser();
  assert.deepEqual((await first.call('/api/session')).body, { setupRequired: true, user: null });
  const setup = await first.call('/api/auth/setup', owner);
  assert.equal(setup.status, 200);
  assert.deepEqual(setup.body, { ok: true });
  const me = await first.call('/api/me');
  assert.equal(me.status, 200, 'setup signs the owner in');
  assert.equal(me.body.user.email, owner.email);
  assert.equal(me.body.instanceOperator, true);
  assert.deepEqual(me.body.workspaces.map((w: { name: string; role: string }) => [w.name, w.role]), [[owner.workspaceName, 'owner']]);
  assert.equal(await count('SELECT count(*) FROM "user"'), 1);
  assert.equal(await count("SELECT count(*) FROM membership WHERE role = 'owner'"), 1);
  assert.equal(await count("SELECT count(*) FROM installation WHERE claimed"), 1);

  const again = await browser().call('/api/auth/setup', { ...owner, email: `second-${randomUUID()}@books.test` });
  assert.equal(again.status, 409);
  assert.equal(await count('SELECT count(*) FROM "user"'), 1, 'a second setup creates nothing');
  assert.equal(await count('SELECT count(*) FROM workspace'), 1);
  assert.equal((await browser().call('/api/session')).body.setupRequired, false);
});

test('sign-in rejects a wrong password, accepts the right one, and sign-out ends the session', async () => {
  const wrong = browser();
  const refused = await wrong.call('/api/auth/sign-in/email', { email: owner.email, password: 'not the password at all' });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, 'Email or password is incorrect.');
  assert.equal((await wrong.call('/api/me')).status, 401);

  const session = browser();
  const signedIn = await session.call('/api/auth/sign-in/email', { email: owner.email.toUpperCase(), password: owner.password });
  assert.equal(signedIn.status, 200);
  assert.deepEqual(signedIn.body, { ok: true });
  assert.equal((await session.call('/api/me')).status, 200);
  const cookies = new Map(session.cookies);

  assert.equal((await session.call('/api/auth/sign-out', {})).status, 200);
  assert.equal((await session.call('/api/me')).status, 401);
  const replay = browser();
  for (const [name, value] of cookies) replay.cookies.set(name, value);
  assert.equal((await replay.call('/api/me')).status, 401, 'the old session cookie no longer works');
});

test('creating a company persists its books settings; invalid currency, time zone or date is rejected', async () => {
  const session = browser();
  await session.call('/api/auth/sign-in/email', { email: owner.email, password: owner.password });
  const workspaceId = (await session.call('/api/me')).body.workspaces[0].id as string;

  const created = await session.call(`/api/workspaces/${workspaceId}/companies`, company);
  assert.equal(created.status, 201);
  assert.deepEqual({ ...created.body.company, id: undefined }, {
    id: undefined, workspaceId, name: company.name, secondLanguageName: company.secondLanguageName, baseCurrency: 'KWD', currencyMinorUnits: 3,
    financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-04-01', timeZone: 'Asia/Kuwait', lockedThrough: null,
  });
  const read = await session.call(`/api/companies/${created.body.company.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, created.body);
  assert.deepEqual(await session.call(`/api/companies/${created.body.company.id.toUpperCase()}`), read, 'an uppercase id reads the same company');
  assert.deepEqual((await session.call(`/api/workspaces/${workspaceId}/companies`)).body, { companies: [{ id: created.body.company.id, name: company.name }] });

  const projects = await count('SELECT count(*) FROM project');
  for (const [field, value, message] of [
    ['baseCurrency', 'XYZ', 'Check the base currency and try again.'],
    ['baseCurrency', 'kwd', 'Check the base currency and try again.'],
    ['timeZone', 'Mars/Olympus_Mons', 'Check the time zone and try again.'],
    ['booksBeginning', '2026-02-30', 'Check the books beginning date and try again.'],
    ['booksBeginning', '01/04/2026', 'Check the books beginning date and try again.'],
    ['financialYearStart', { month: 2, day: 29 }, 'Check the financial year start and try again.'],
  ] as const) {
    const refused = await session.call(`/api/workspaces/${workspaceId}/companies`, { ...company, [field]: value });
    assert.equal(refused.status, 400, `${field}=${JSON.stringify(value)} must be refused`);
    assert.equal(refused.body.error, message);
  }
  assert.equal(await count('SELECT count(*) FROM project'), projects, 'a refused company leaves no project behind');
});

test('state-changing requests from another origin or without an Origin header are refused before any work', async () => {
  const session = browser();
  await session.call('/api/auth/sign-in/email', { email: owner.email, password: owner.password });
  const workspaceId = (await session.call('/api/me')).body.workspaces[0].id as string;
  const [projects, workspaces, invitations] = [await count('SELECT count(*) FROM project'), await count('SELECT count(*) FROM workspace'), await count('SELECT count(*) FROM workspace_invitation')];
  for (const origin of ['https://attacker.example', 'http://localhost:1', null]) {
    for (const [path, body] of [
      [`/api/workspaces/${workspaceId}/companies`, company],
      ['/api/workspaces', { name: 'Forged workspace' }],
      [`/api/workspaces/${workspaceId}/invitations`, { email: `forged-${randomUUID()}@books.test`, role: 'viewer' }],
      ['/api/invitations/accept', { token: 'a'.repeat(43), name: 'Forged', password: 'correct horse battery staple' }],
      ['/api/auth/sign-in/email', { email: owner.email, password: owner.password }],
      ['/api/auth/sign-out', {}],
    ] as const) {
      const refused = await session.call(path, body, origin);
      assert.equal(refused.status, 403, `${path} from ${origin}`);
      assert.deepEqual(refused.body, { error: 'This action must originate from the application.' });
    }
  }
  assert.equal(await count('SELECT count(*) FROM project'), projects);
  assert.equal(await count('SELECT count(*) FROM workspace'), workspaces);
  assert.equal(await count('SELECT count(*) FROM workspace_invitation'), invitations);
  assert.equal((await session.call('/api/me')).status, 200, 'the forged sign-out did not end the session');
});
