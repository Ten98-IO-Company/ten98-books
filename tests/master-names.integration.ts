import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getDatabase } from '../src/server/db.ts';
import { assertDatabaseRoles } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, setupOwner, type Chart, type Member } from './helpers/ledger.ts';

/**
 * Master names under the name match key (migration 0010): for groups, ledgers, voucher types, cost categories and cost
 * centres, two names equal apart from case, spaces and the ignored punctuation are one name (observed on the creation
 * screens), refused with duplicate_name on create and on rename; an underscore keeps names apart; another company may
 * use the same name; the seeded names stay distinct under the key.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('master_names');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

async function books(name: string) {
  const companyId = await createCompany(owner.browser, { name });
  const accounts: Chart = await chart(owner.browser, companyId);
  const call = (path: string, body?: unknown) => owner.browser.call(`/api/companies/${companyId}${path}`, body);
  return { companyId, accounts, call };
}
const code = (answer: { status: number; body: any }) => [answer.status, answer.body.code ?? null];

test('groups, ledgers, cost categories and cost centres: a name equal under the key is a duplicate on create and on rename; an underscore is not', async () => {
  const b = await books('Master Names'), other = await books('Master Names Elsewhere');
  const category = (await b.call('/cost-categories', { name: 'Area-North' })).body.costCategory;
  const kinds = [
    { path: '/groups', key: 'group', body: (name: string) => ({ name, parentId: b.accounts.group('indirect_expenses') }), otherBody: (name: string) => ({ name, parentId: other.accounts.group('indirect_expenses') }) },
    { path: '/ledgers', key: 'ledger', body: (name: string) => ({ name, groupId: b.accounts.group('indirect_expenses') }), otherBody: (name: string) => ({ name, groupId: other.accounts.group('indirect_expenses') }) },
    { path: '/cost-categories', key: 'costCategory', body: (name: string) => ({ name }), otherBody: (name: string) => ({ name }) },
    { path: '/cost-centres', key: 'costCentre', body: (name: string) => ({ name, categoryId: category.id, parentId: null }), otherBody: null },
  ];
  for (const kind of kinds) {
    const created = await b.call(kind.path, kind.body('Rent-Office'));
    assert.equal(created.status, 201, `${kind.path}: ${JSON.stringify(created.body)}`);
    for (const twin of ['RentOffice', 'rent office', 'RENT.OFFICE', ' (Rent) Office ']) {
      assert.deepEqual(code(await b.call(kind.path, kind.body(twin))), [409, 'duplicate_name'], `${kind.path} ${twin}`);
    }
    const apart = await b.call(kind.path, kind.body('Rent_Office'));
    assert.equal(apart.status, 201, `${kind.path}: an underscore keeps names apart`);
    const row = apart.body[kind.key];
    const renamed = await b.call(`${kind.path}/${row.id}`, { ...kind.body('rent-office '), revision: row.revision });
    assert.deepEqual(code(renamed), [409, 'duplicate_name'], `${kind.path}: rename onto an equal name`);
    if (kind.otherBody) assert.equal((await other.call(kind.path, kind.otherBody('RentOffice'))).status, 201, `${kind.path}: another company`);
  }
  // A cost category and a cost centre may share a name (separate name spaces).
  assert.equal((await b.call('/cost-centres', { name: 'Area North', categoryId: category.id, parentId: null })).status, 201);
});

test('voucher types: a rename equal under the key to another type is a duplicate; an underscore is not', async () => {
  const b = await books('Type Names');
  const types = (await b.call('/voucher-types')).body.voucherTypes as { id: string; kind: string; name: string; revision: number }[];
  const contra = types.find(type => type.kind === 'contra')!, payment = types.find(type => type.kind === 'payment')!;
  const twin = `${payment.name.slice(0, 2)}-${payment.name.slice(2).toUpperCase()}`;
  assert.deepEqual(code(await b.call(`/voucher-types/${contra.id}`, { name: twin, revision: contra.revision })), [409, 'duplicate_name'], twin);
  assert.equal((await b.call(`/voucher-types/${contra.id}`, { name: `${payment.name}_2`, revision: contra.revision })).status, 200);
});

test('the seeded names stay distinct under the key in each name space, and seeding again finds its rows by system key', async () => {
  const b = await books('Seeded Names');
  const clashes = await asAdmin(database.adminUrl, admin => admin.query(`
    SELECT kind, name_match_key(name) AS key, count(*)::int AS n FROM (
      SELECT 'group' AS kind, name FROM account_group WHERE company_id = $1 UNION ALL SELECT 'ledger', name FROM ledger WHERE company_id = $1
      UNION ALL SELECT 'voucher type', name FROM voucher_type WHERE company_id = $1 UNION ALL SELECT 'cost category', name FROM cost_category WHERE company_id = $1) seeded
    GROUP BY kind, name_match_key(name) HAVING count(*) > 1`, [b.companyId]));
  assert.deepEqual(clashes.rows, [], 'company creation cannot trip over its own seeded names');
  // A seeded ledger renamed, and a user ledger given the seeded name: seeding again adds nothing and refuses nothing.
  const ledgers = (await b.call('/ledgers')).body.ledgers as { id: string; name: string; systemKey: string | null; groupId: string | null; revision: number }[];
  const cash = ledgers.find(ledger => ledger.systemKey === 'cash')!;
  assert.equal((await b.call(`/ledgers/${cash.id}`, { name: 'Till', groupId: cash.groupId, revision: cash.revision })).status, 200);
  assert.equal((await b.call('/ledgers', { name: cash.name, groupId: b.accounts.group('indirect_expenses') })).status, 201);
  const counts = async () => (await asAdmin(database.adminUrl, admin => admin.query(
    `SELECT (SELECT count(*) FROM account_group WHERE company_id = $1)::int AS groups, (SELECT count(*) FROM ledger WHERE company_id = $1)::int AS ledgers,
       (SELECT count(*) FROM voucher_type WHERE company_id = $1)::int AS types, (SELECT count(*) FROM cost_category WHERE company_id = $1)::int AS categories`, [b.companyId]))).rows[0];
  const before = await counts();
  await asAdmin(database.adminUrl, async admin => {
    await admin.query('BEGIN');
    await admin.query("SELECT set_config('app.company_ids', $1, true)", [b.companyId]);
    await admin.query('SELECT ledger_seed_company($1)', [b.companyId]);
    await admin.query('COMMIT');
  });
  assert.deepEqual(await counts(), before);
});

test('the five name indexes keep their names, use the key in plain-text order, and the role and policies are unchanged', async () => {
  const indexes = (await asAdmin(database.adminUrl, admin => admin.query(`SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS definition FROM pg_index
    WHERE indexrelid::regclass::text = ANY($1) ORDER BY 1`, [['account_group_name_idx', 'ledger_name_idx', 'voucher_type_name_idx', 'cost_category_name_idx', 'cost_centre_name_idx']]))).rows;
  assert.equal(indexes.length, 5);
  for (const index of indexes) assert.match(index.definition, /UNIQUE INDEX .* \(company_id, name_match_key\(name\) COLLATE "C"\)$/, index.name);
  await assert.doesNotReject(assertDatabaseRoles(getDatabase().pool));
});
