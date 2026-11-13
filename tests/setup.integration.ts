import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { Browser, freshDatabase, type TestDatabase } from './helpers/database.ts';

// Its own database: setup admits at most two unresolved-client attempts per 15 minutes, and both are spent on the race.
let database: TestDatabase;
let admin: pg.Client;
const owner = (label: string) => ({ name: `Owner ${label}`, email: `${label}-${randomUUID()}@books.test`, password: 'correct horse battery staple', workspaceName: `Workspace ${label}` });
const count = async (sql: string) => Number((await admin.query(sql)).rows[0].count);

before(async () => {
  database = await freshDatabase('setup');
  admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
});
after(async () => { await admin?.end(); await database?.drop(); });

test('first-user setup from another origin or without an Origin header is refused and claims nothing', async () => {
  const browser = new Browser(handleApi, getConfig().appUrl);
  for (const origin of ['https://attacker.example', null]) {
    const refused = await browser.call('/api/auth/setup', owner('forged'), origin);
    assert.equal(refused.status, 403, `origin ${origin}`);
    assert.deepEqual(refused.body, { error: 'This action must originate from the application.' });
  }
  assert.equal(await count('SELECT count(*) FROM "user"'), 0);
  assert.equal((await browser.call('/api/session')).body.setupRequired, true);
});

test('two concurrent first-user setups yield exactly one owner', async () => {
  const [first, second] = [new Browser(handleApi, getConfig().appUrl), new Browser(handleApi, getConfig().appUrl)];
  const results = await Promise.all([first.call('/api/auth/setup', owner('one')), second.call('/api/auth/setup', owner('two'))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(await count('SELECT count(*) FROM "user"'), 1);
  assert.equal(await count('SELECT count(*) FROM workspace'), 1);
  assert.equal(await count("SELECT count(*) FROM membership WHERE role = 'owner'"), 1);
  assert.equal(await count('SELECT count(*) FROM instance_operator'), 1);
});
