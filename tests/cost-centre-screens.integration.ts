import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chart, createCompany, invite, setupOwner, type Chart, type Member } from './helpers/ledger.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';

/**
 * What the cost category and cost centre screens read and rely on, over the real HTTP contract: the rows the list shows
 * (`inUse`, the category name of a centre), the codes the forms branch on, the company switch by role, the ledger
 * setting's default by group, and the two placement rules the parent lookup mirrors. Rules and routes: docs/LEDGER.md.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let admin: Member, editor: Member, viewer: Member;
let company = '';
let other = '';
let books: Chart;

before(async () => {
  database = await freshDatabase('cost_centre_screens');
  owner = await setupOwner();
  company = await createCompany(owner.browser, { name: 'Cost Screens' });
  other = await createCompany(owner.browser, { name: 'Neighbour Costs' });
  [admin, editor, viewer] = [await invite(owner.browser, company, 'admin'), await invite(owner.browser, company, 'editor'), await invite(owner.browser, company, 'viewer')];
  books = await chart(owner.browser, company);
});
after(async () => { await database?.drop(); });

const base = (id = company) => `/api/companies/${id}`;
const call = (path: string, body?: unknown, member: Member = owner, id = company) => member.browser.call(`${base(id)}/${path}`, body);
const category = async (name: string, extra: Record<string, unknown> = {}) => { const made = await call('cost-categories', { name, ...extra }); assert.equal(made.status, 201, JSON.stringify(made.body)); return made.body.costCategory; };
const centre = async (name: string, categoryId: string, parentId: string | null = null) => { const made = await call('cost-centres', { name, categoryId, parentId }); assert.equal(made.status, 201, JSON.stringify(made.body)); return made.body.costCentre; };

test('the list rows carry what the screen shows: the built-in category allocating both kinds, in-use flags, and each centre with its category name', async () => {
  const listed = (await call('cost-categories')).body.costCategories;
  assert.deepEqual(listed.map((row: any) => [row.name, row.systemKey, row.allocateRevenue, row.allocateNonRevenue, row.inUse]), [['General', 'primary', true, true, false]]);
  const projects = await category('Projects');
  assert.deepEqual([projects.allocateRevenue, projects.allocateNonRevenue], [true, false], 'a new category allocates revenue items and not others');
  const flags = await category('Branches', { allocateRevenue: false, allocateNonRevenue: true });
  assert.deepEqual([flags.allocateRevenue, flags.allocateNonRevenue], [false, true]);
  const north = await centre('North', projects.id);
  const harbour = await centre('Harbour', projects.id, north.id);
  const rows = (await call('cost-centres')).body.costCentres;
  const read = (name: string) => rows.find((row: any) => row.name === name);
  assert.deepEqual([read('Harbour').categoryName, read('Harbour').parentId, read('North').inUse, read('Harbour').inUse], ['Projects', north.id, true, false]);
  assert.equal((await call('cost-categories')).body.costCategories.find((row: any) => row.name === 'Projects').inUse, true, 'a category holding a centre is in use');
  assert.equal(harbour.revision, 1);
});

test('the codes and sentences the forms and the list branch on', async () => {
  const projects = (await call('cost-categories')).body.costCategories.find((row: any) => row.name === 'Projects');
  const general = (await call('cost-categories')).body.costCategories.find((row: any) => row.systemKey === 'primary');
  const north = (await call('cost-centres')).body.costCentres.find((row: any) => row.name === 'North');
  const harbour = (await call('cost-centres')).body.costCentres.find((row: any) => row.name === 'Harbour');
  const refused = async (result: Promise<{ status: number; body: any }>, status: number, code: string, message: RegExp) => {
    const answer = await result;
    assert.equal(answer.status, status, JSON.stringify(answer.body));
    assert.equal(answer.body.code, code);
    assert.match(answer.body.error, message);
  };
  await refused(call('cost-categories', { name: 'projects' }), 409, 'duplicate_name', /already exists/);
  await refused(call('cost-centres', { name: 'NORTH', categoryId: general.id }), 409, 'duplicate_name', /shared by all categories/);
  await refused(call(`cost-categories/${general.id}/delete`, { revision: general.revision }), 409, 'seeded_row', /renamed but not deleted/);
  await refused(call(`cost-categories/${projects.id}/delete`, { revision: projects.revision }), 409, 'in_use', /holds cost centres or is used/);
  await refused(call(`cost-centres/${north.id}/delete`, { revision: north.revision }), 409, 'in_use', /holds sub-centres or is used/);
  await refused(call(`cost-centres/${north.id}`, { name: 'North', categoryId: projects.id, parentId: harbour.id, revision: north.revision }), 400, 'cycle', /own sub-centres/);
  await refused(call(`cost-centres/${harbour.id}`, { name: 'Harbour', categoryId: projects.id, parentId: north.id, revision: harbour.revision - 1 || 99 }), 409, 'stale_revision', /changed by someone else/);
  // The built-in category can be renamed; the form offers that and its settings.
  const renamed = await call(`cost-categories/${general.id}`, { name: 'Main', allocateRevenue: true, allocateNonRevenue: true, revision: general.revision });
  assert.equal(renamed.status, 200);
  assert.deepEqual([renamed.body.costCategory.name, renamed.body.costCategory.systemKey, renamed.body.costCategory.allocateNonRevenue], ['Main', 'primary', true]);
});

test('the placement rules the Under lookup mirrors: a parent goes in its own category, and a moved centre may keep a parent left behind', async () => {
  const projects = (await call('cost-categories')).body.costCategories.find((row: any) => row.name === 'Projects');
  const branches = (await call('cost-categories')).body.costCategories.find((row: any) => row.name === 'Branches');
  const north = (await call('cost-centres')).body.costCentres.find((row: any) => row.name === 'North');
  const harbour = (await call('cost-centres')).body.costCentres.find((row: any) => row.name === 'Harbour');
  // A new centre under a parent in another category is refused (the form changes the category to the parent's instead).
  const wrong = await call('cost-centres', { name: 'Elsewhere', categoryId: branches.id, parentId: north.id });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'validation');
  assert.match(wrong.body.error, /goes in the category of that cost centre/);
  // A centre that changes category and keeps its parent is accepted, and the list then shows it in its own category.
  const moved = await call(`cost-centres/${harbour.id}`, { name: 'Harbour', categoryId: branches.id, parentId: north.id, revision: harbour.revision });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.costCentre.categoryName, moved.body.costCentre.parentId], ['Branches', north.id]);
  // Moving it to the top level of another category is a plain alteration.
  const top = await call(`cost-centres/${harbour.id}`, { name: 'Harbour', categoryId: projects.id, parentId: null, revision: moved.body.costCentre.revision });
  assert.equal(top.status, 200);
  assert.deepEqual([top.body.costCentre.categoryName, top.body.costCentre.parentId], ['Projects', null]);
});

test('the history entries carry what the screen words: the actor, the category name of a centre and its parent id', async () => {
  const harbour = (await call('cost-centres')).body.costCentres.find((row: any) => row.name === 'Harbour');
  const history = (await call(`cost-centres/${harbour.id}/revisions`)).body.revisions;
  assert.deepEqual(history.map((row: any) => row.action), ['create', 'alter', 'alter']);
  assert.equal(history[0].actorName, 'Owner');
  assert.deepEqual([history[0].after.categoryName, history[0].after.parentId === null], ['Projects', false]);
  assert.deepEqual([history[1].after.categoryName, history[1].before.categoryName], ['Branches', 'Projects']);
  const categories = (await call('cost-categories')).body.costCategories;
  const general = categories.find((row: any) => row.systemKey === 'primary');
  const named = (await call(`cost-categories/${general.id}/revisions`)).body.revisions;
  assert.deepEqual(named.map((row: any) => row.action), ['alter'], 'the seeded row has no create entry; its rename is logged');
  assert.deepEqual([named[0].before.name, named[0].after.name, named[0].after.allocateNonRevenue], ['General', 'Main', true]);
});

test('the company switch is off at first, read by every member, and changed by an owner or admin only', async () => {
  assert.deepEqual((await call('cost-centres-setting')).body, { costCentres: { enabled: false } });
  for (const member of [viewer, editor, admin]) assert.equal((await call('cost-centres-setting', undefined, member)).status, 200);
  for (const member of [viewer, editor]) {
    const refused = await call('cost-centres-setting', { enabled: true }, member);
    assert.equal(refused.status, 404, 'the screen words a refused write as not found');
    assert.equal(refused.body.code, 'not_found');
  }
  assert.equal((await call('cost-centres-setting')).body.costCentres.enabled, false);
  assert.equal((await call('cost-centres-setting', { enabled: true }, admin)).body.costCentres.enabled, true);
  assert.equal((await call('cost-centres-setting', { enabled: false }, owner)).body.costCentres.enabled, false);
  assert.equal((await call('cost-centres-setting', { enabled: true }, owner)).body.costCentres.enabled, true);
  // Another company keeps its own setting.
  assert.equal((await call('cost-centres-setting', undefined, owner, other)).body.costCentres.enabled, false);
});

test('a viewer reads categories, centres and their history, and every write is refused; an editor writes masters but not the switch', async () => {
  const centres = (await call('cost-centres', undefined, viewer)).body.costCentres;
  assert.ok(centres.length >= 2);
  assert.equal((await call('cost-categories', undefined, viewer)).status, 200);
  assert.equal((await call(`cost-centres/${centres[0].id}/revisions`, undefined, viewer)).status, 200);
  const general = (await call('cost-categories')).body.costCategories[0];
  const attempts = await Promise.all([
    call('cost-categories', { name: 'Viewer category' }, viewer),
    call('cost-centres', { name: 'Viewer centre', categoryId: general.id }, viewer),
    call(`cost-centres/${centres[0].id}`, { name: 'Renamed', categoryId: centres[0].categoryId, parentId: null, revision: centres[0].revision }, viewer),
    call(`cost-centres/${centres[0].id}/delete`, { revision: centres[0].revision }, viewer),
  ]);
  for (const answer of attempts) assert.equal(answer.status, 404);
  assert.equal((await call('cost-centres', { name: 'Editor centre', categoryId: general.id }, editor)).status, 201);
  // Another company's centre is "not found", never its data.
  assert.equal((await call(`cost-centres/${centres[0].id}`, undefined, owner, other)).status, 404);
  assert.deepEqual((await call('cost-centres', undefined, owner, other)).body.costCentres, []);
});

test('a ledger takes cost centres by its group unless told, the profit and loss ledger takes none, and the setting is in its history', async () => {
  const income = await call('ledgers', { name: 'Consulting', groupId: books.group('direct_income') });
  const expense = await call('ledgers', { name: 'Fuel', groupId: books.group('indirect_expenses') });
  const asset = await call('ledgers', { name: 'Equipment', groupId: books.group('fixed_assets') });
  assert.deepEqual([income, expense, asset].map(answer => answer.body.ledger.costCentres), [true, true, false]);
  const asked = await call('ledgers', { name: 'Fuel Cards', groupId: books.group('indirect_expenses'), costCentres: false });
  const forced = await call('ledgers', { name: 'Prepayments', groupId: books.group('current_assets'), costCentres: true });
  assert.deepEqual([asked.body.ledger.costCentres, forced.body.ledger.costCentres], [false, true]);
  const fuel = expense.body.ledger;
  const off = await call(`ledgers/${fuel.id}`, { name: 'Fuel', groupId: fuel.groupId, opening: { amount: '0.00', side: 'Dr' }, costCentres: false, revision: fuel.revision });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const history = (await call(`ledgers/${fuel.id}/revisions`)).body.revisions;
  assert.deepEqual(history.map((row: any) => row.after.costCentres), [true, false]);
  const profit = (await call('ledgers')).body.ledgers.find((row: any) => row.systemKey === 'profit_and_loss');
  assert.equal(profit.costCentres, false);
  const refused = await call(`ledgers/${profit.id}`, { name: profit.name, groupId: null, opening: { amount: '0.00', side: 'Cr' }, costCentres: true, revision: profit.revision });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'family_rule');
});

test('a centre used in a voucher cannot be deleted, with the same sentence as for a centre holding sub-centres', async () => {
  const now = await chart(owner.browser, company);
  const online = await centre('Online', (await call('cost-categories')).body.costCategories.find((row: any) => row.name === 'Projects').id);
  const answer = await call('vouchers', {
    idempotencyKey: 'screens-cost-1', voucherTypeId: now.type('journal'), date: '2026-02-01',
    lines: [{ ledgerId: now.ledger('Cash'), side: 'Dr', amount: '100.00' }, { ledgerId: now.ledger('Consulting'), side: 'Cr', amount: '100.00', costAllocations: [{ costCentreId: online.id, amount: '100.00' }] }],
  });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const listed = (await call('cost-centres')).body.costCentres.find((row: any) => row.id === online.id);
  assert.equal(listed.inUse, true, 'the list says so before a delete is tried');
  const refused = await call(`cost-centres/${online.id}/delete`, { revision: listed.revision });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'in_use');
  assert.match(refused.body.error, /holds sub-centres or is used in vouchers and cannot be deleted/);
  // A centre with nothing against it is deleted, and its history keeps the delete.
  const spare = await centre('Spare', listed.categoryId);
  assert.equal((await call(`cost-centres/${spare.id}/delete`, { revision: spare.revision })).status, 200);
  assert.deepEqual((await call(`cost-centres/${spare.id}/revisions`)).body.revisions.map((row: any) => row.action), ['create', 'delete']);
});
