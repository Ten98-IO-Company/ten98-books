import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, chart, createCompany, invite, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * Stock masters over the HTTP contract (M2b slice a): units and their decimals, names per kind under the name match key,
 * the three trees, the main location, opening stock by rate or by value, the inventory switch, the revision log, roles
 * and the wrong-company answer of every route. The database's own guards are in stock-masters-guards.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let viewer: Member, editor: Member;
let companyId = '', other = '';

const call = (path: string, body?: unknown, company = companyId, member: Member = owner) => member.browser.call(`/api/companies/${company}${path}`, body);
const made = async (path: string, body: unknown, key: string, company = companyId) => {
  const answer = await call(path, body, company);
  assert.equal(answer.status, 201, `${path}: ${JSON.stringify(answer.body)}`);
  return answer.body[key];
};
const refused = async (answer: Promise<{ status: number; body: any }>, status: number, code: string, what: string) => {
  const { status: actual, body } = await answer;
  assert.deepEqual([actual, body?.code], [status, code], `${what}: ${JSON.stringify(body)}`);
};
const mainLocation = async (company = companyId) => ((await call('/stock-locations', undefined, company)).body.stockLocations as any[]).find(row => row.systemKey === 'main');

before(async () => {
  database = await freshDatabase('stock_masters');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Stock Masters' });
  other = await createCompany(owner.browser, { name: 'Neighbour Stock' });
  viewer = await invite(owner.browser, companyId, 'viewer');
  editor = await invite(owner.browser, companyId, 'editor');
});
after(async () => { await database?.drop(); });

test('units take 0 to 4 decimal places; lowering them is refused while opening stock uses the unit, raising them is not', async () => {
  for (const decimals of [0, 1, 2, 3, 4]) assert.equal((await made('/stock-units', { symbol: `U${decimals}`, decimals }, 'stockUnit')).decimals, decimals);
  await refused(call('/stock-units', { symbol: 'U5', decimals: 5 }), 400, 'validation', 'five places');
  assert.equal((await made('/stock-units', { symbol: 'Box' }, 'stockUnit')).decimals, 0, 'no decimals by default');

  const kg = await made('/stock-units', { symbol: 'Kgs', formalName: 'Kilograms', decimals: 2 }, 'stockUnit');
  const item = await made('/stock-items', { name: 'Sugar', unitId: kg.id, openings: [{ locationId: (await mainLocation()).id, quantity: '10.25', rate: '3.00' }] }, 'stockItem');
  assert.deepEqual(item.openings.map((row: any) => [row.quantity, row.value]), [['10.25', '30.75']]);
  await refused(call(`/stock-units/${kg.id}`, { symbol: 'Kgs', formalName: 'Kilograms', decimals: 1, revision: kg.revision }), 409, 'in_use', 'lowering a used unit');
  const raised = await call(`/stock-units/${kg.id}`, { symbol: 'Kgs', formalName: 'Kilograms', decimals: 3, revision: kg.revision });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.equal(raised.body.stockUnit.decimals, 3);
  await refused(call('/stock-items', { name: 'Flour', unitId: (await made('/stock-units', { symbol: 'Bag', decimals: 1 }, 'stockUnit')).id,
    openings: [{ locationId: (await mainLocation()).id, quantity: '2.25', rate: '1.00' }] }), 400, 'validation', 'a quantity with more places than its unit');
  const unused = await made('/stock-units', { symbol: 'Ctn', decimals: 2 }, 'stockUnit');
  assert.equal((await call(`/stock-units/${unused.id}`, { symbol: 'Ctn', decimals: 0, revision: unused.revision })).status, 200, 'an unused unit may lower its decimals');
  await refused(call(`/stock-units/${kg.id}/delete`, { revision: raised.body.stockUnit.revision }), 409, 'in_use', 'deleting a used unit');
});

test('names are one per kind under the name match key; kinds are separate name spaces, and a matching create changes nothing', async () => {
  const unit = await made('/stock-units', { symbol: 'Nos' }, 'stockUnit');
  await refused(call('/stock-units', { symbol: 'n-os' }), 409, 'duplicate_name', 'a unit symbol equal under the key');
  const item = await made('/stock-items', { name: 'ZNM.1', unitId: unit.id }, 'stockItem');
  await refused(call('/stock-items', { name: 'z-nm 1', unitId: unit.id, standardSellingRate: '5.00' }), 409, 'duplicate_name', 'an item equal under the key');
  assert.deepEqual((await call(`/stock-items/${item.id}`)).body.stockItem, item, 'the existing item is not altered by a matching create');
  assert.equal((await call('/stock-items', { name: 'ZNM_1', unitId: unit.id })).status, 201, 'an underscore makes another name');
  await made('/stock-locations', { name: 'Back Store' }, 'stockLocation');
  await refused(call('/stock-locations', { name: 'back-store' }), 409, 'duplicate_name', 'a location equal under the key');
  await made('/stock-groups', { name: 'Shared Name' }, 'stockGroup');
  await refused(call('/stock-groups', { name: 'shared name' }), 409, 'duplicate_name', 'a stock group equal under the key');
  await made('/stock-categories', { name: 'Shared Name' }, 'stockCategory');
  await made('/stock-locations', { name: 'Shared Name' }, 'stockLocation');
  const books = await chart(owner.browser, companyId);
  assert.equal((await call('/ledgers', { name: 'Shared Name', groupId: books.group('indirect_expenses') })).status, 201);
  assert.equal((await call('/stock-items', { name: 'Shared Name', unitId: unit.id })).status, 201, 'an item shares its name with a group, a category, a location and a ledger');
});

test('groups, categories and locations are trees: a master under its own sub-master is refused', async () => {
  for (const [path, key] of [['/stock-groups', 'stockGroup'], ['/stock-categories', 'stockCategory'], ['/stock-locations', 'stockLocation']] as const) {
    const top = await made(path, { name: `Top ${key}` }, key);
    const middle = await made(path, { name: `Middle ${key}`, parentId: top.id }, key);
    const bottom = await made(path, { name: `Bottom ${key}`, parentId: middle.id }, key);
    await refused(call(`${path}/${top.id}`, { name: top.name, parentId: bottom.id, revision: top.revision }), 400, 'cycle', `${key} under its grandchild`);
    await refused(call(`${path}/${top.id}`, { name: top.name, parentId: top.id, revision: top.revision }), 400, 'cycle', `${key} under itself`);
    await refused(call(`${path}/${middle.id}/delete`, { revision: middle.revision }), 409, 'in_use', `${key} holding a sub-master`);
    assert.equal((await call(`${path}/${bottom.id}/delete`, { revision: bottom.revision })).status, 200);
  }
});

test('the main location is seeded for a new company; it can be renamed but not deleted', async () => {
  const main = await mainLocation(other);
  assert.equal(main.name, 'Main Store');
  const renamed = await call(`/stock-locations/${main.id}`, { name: 'Depot', parentId: null, revision: main.revision }, other);
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual([renamed.body.stockLocation.name, renamed.body.stockLocation.systemKey], ['Depot', 'main']);
  await refused(call(`/stock-locations/${main.id}/delete`, { revision: renamed.body.stockLocation.revision }, other), 409, 'seeded_row', 'deleting the main location');
});

test('opening stock by rate or by value: rounding, a derived rate, zero cost, rows replaced as a set, a fixed unit and the period lock', async () => {
  const kg = await made('/stock-units', { symbol: 'Kg', decimals: 1 }, 'stockUnit');
  const nos = await made('/stock-units', { symbol: 'Pcs' }, 'stockUnit');
  const main = await mainLocation();
  const yard = await made('/stock-locations', { name: 'Yard' }, 'stockLocation');
  const sheet = await made('/stock-items', { name: 'Sheet', unitId: kg.id, openings: [{ locationId: main.id, quantity: '4000', rate: '4.20' }] }, 'stockItem');
  assert.deepEqual(sheet.openings.map((row: any) => [row.quantity, row.rate, row.value]), [['4000.0', '4.20', '16800.00']]);
  assert.equal(sheet.openingValue, '16800.00');
  const half = await made('/stock-items', { name: 'Rounded', unitId: kg.id, openings: [{ locationId: main.id, quantity: '0.5', rate: '0.05' }] }, 'stockItem');
  assert.equal(half.openings[0].value, '0.03', '0.025 rounds half-up');
  const box = await made('/stock-items', { name: 'Box set', unitId: nos.id, openings: [{ locationId: main.id, quantity: '3', value: '100.00' }, { locationId: yard.id, quantity: '2', value: '0.00' }] }, 'stockItem');
  assert.deepEqual(box.openings.map((row: any) => [row.locationName, row.quantity, row.rate, row.value]), [['Main Store', '3', '33.333333', '100.00'], ['Yard', '2', '0.00', '0.00']]);

  for (const [row, what] of [
    [{ locationId: main.id, quantity: '0', rate: '1.00' }, 'a zero quantity'],
    [{ locationId: main.id, quantity: '-1', rate: '1.00' }, 'a negative quantity'],
    [{ locationId: main.id, quantity: '1', rate: '1.005' }, 'a rate with more places than the currency'],
    [{ locationId: main.id, quantity: '1', rate: '1.00', value: '1.00' }, 'both a rate and a value'],
    [{ locationId: main.id, quantity: '1' }, 'neither a rate nor a value'],
  ] as const) await refused(call('/stock-items', { name: `Refused ${what}`, unitId: nos.id, openings: [row] }), 400, 'validation', what);
  // A value whose derived rate would not fit the rate column (below 10^14), with a large value or a tiny quantity.
  const fine = await made('/stock-units', { symbol: 'Mg', decimals: 4 }, 'stockUnit');
  for (const [row, what] of [
    [{ locationId: main.id, quantity: '1', value: '100000000000000.00' }, 'a value of 10^14 for one unit'],
    [{ locationId: main.id, quantity: '0.0001', value: '10000000000.00' }, 'a value of 10^10 for a ten-thousandth'],
  ] as const) {
    const answer = await call('/stock-items', { name: `Refused ${what}`, unitId: fine.id, openings: [row] });
    assert.deepEqual([answer.status, answer.body.code], [400, 'validation'], `${what}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, /^The value of opening row 1 is too large for its quantity/, what);
  }
  const largest = await call('/stock-items', { name: 'Largest rate', unitId: nos.id, openings: [{ locationId: main.id, quantity: '1', value: '99999999999999.99' }] });
  assert.equal(largest.body.stockItem?.openings[0].rate, '99999999999999.99', 'the largest rate that fits is kept');
  await call(`/stock-items/${largest.body.stockItem.id}/delete`, { revision: largest.body.stockItem.revision });
  // The API names the row and the unit; the database's own refusal of the same quantity (stock-masters-guards) cannot.
  const places = await call('/stock-items', { name: 'Too fine', unitId: kg.id, openings: [{ locationId: yard.id, quantity: '1', rate: '1.00' }, { locationId: main.id, quantity: '1.25', rate: '1.00' }] });
  assert.deepEqual([places.status, places.body.code, places.body.error], [400, 'validation', 'The quantity of opening row 2 has more decimal places than the unit Kg allows (1).']);
  await refused(call('/stock-items', { name: 'Twice', unitId: nos.id, openings: [{ locationId: main.id, quantity: '1', rate: '1.00' }, { locationId: main.id, quantity: '1', rate: '1.00' }] }), 400, 'validation', 'one location twice');
  await refused(call('/stock-items', { name: 'Elsewhere', unitId: nos.id, openings: [{ locationId: (await mainLocation(other)).id, quantity: '1', rate: '1.00' }] }), 400, 'not_found', 'another company\'s location');

  const replaced = await call(`/stock-items/${box.id}`, { name: 'Box set', unitId: nos.id, openings: [{ locationId: yard.id, quantity: '5', rate: '2.00' }], revision: box.revision });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.deepEqual(replaced.body.stockItem.openings.map((row: any) => [row.locationName, row.value]), [['Yard', '10.00']], 'the list replaces the rows');
  const kept = await call(`/stock-items/${box.id}`, { name: 'Box set renamed', unitId: nos.id, revision: replaced.body.stockItem.revision });
  assert.deepEqual(kept.body.stockItem.openings.map((row: any) => row.value), ['10.00'], 'left out, the rows stay');
  await refused(call(`/stock-items/${box.id}`, { name: 'Box set renamed', unitId: kg.id, revision: kept.body.stockItem.revision }), 409, 'in_use', 'changing the unit of an item with stock');
  const emptied = await call(`/stock-items/${box.id}`, { name: 'Box set renamed', unitId: kg.id, openings: [], revision: kept.body.stockItem.revision });
  assert.equal(emptied.status, 200, 'an item without rows may change its unit');

  // A rate sent is compared with the stored one: another spelling is no change, a new rate with the same value is one.
  const rated = await made('/stock-items', { name: 'Rated', unitId: kg.id, openings: [{ locationId: main.id, quantity: '0.5', rate: '2.01' }] }, 'stockItem');
  assert.equal(rated.openings[0].value, '1.01');
  const spelled = await call(`/stock-items/${rated.id}`, { name: 'Rated', unitId: kg.id, openings: [{ locationId: main.id, quantity: '00.5', rate: '02.01' }], revision: rated.revision });
  assert.deepEqual(spelled.body.stockItem.openings.map((row: any) => [row.rate, row.value]), [['2.01', '1.01']], 'the same rate in another spelling');
  const rerated = await call(`/stock-items/${rated.id}`, { name: 'Rated', unitId: kg.id, openings: [{ locationId: main.id, quantity: '0.5', rate: '2.02' }], revision: spelled.body.stockItem.revision });
  assert.deepEqual(rerated.body.stockItem.openings.map((row: any) => [row.rate, row.value]), [['2.02', '1.01']], 'a new rate with the same value is written');

  await asAdmin(database.adminUrl, admin => admin.query("UPDATE company SET locked_through = '2026-01-31' WHERE company_id = $1", [companyId]));
  try {
    await refused(call(`/stock-items/${rated.id}`, { name: 'Rated', unitId: kg.id, openings: [{ locationId: main.id, quantity: '0.5', rate: '2.03' }], revision: rerated.body.stockItem.revision }), 409, 'locked_period', 'a new rate with the same value under the lock');
    assert.equal((await call(`/stock-items/${rated.id}`, { name: 'Rated', unitId: kg.id, openings: [{ locationId: main.id, quantity: '0.5', rate: '2.02' }], revision: rerated.body.stockItem.revision })).status, 200, 'the same rate re-sent under the lock');
    await refused(call('/stock-items', { name: 'Locked', unitId: nos.id, openings: [{ locationId: main.id, quantity: '1', rate: '1.00' }] }), 409, 'locked_period', 'new opening rows under the lock');
    const current = (await call(`/stock-items/${sheet.id}`)).body.stockItem;
    await refused(call(`/stock-items/${sheet.id}`, { name: 'Sheet', unitId: kg.id, openings: [{ locationId: main.id, quantity: '4001', rate: '4.20' }], revision: current.revision }), 409, 'locked_period', 'changed rows under the lock');
    const same = await call(`/stock-items/${sheet.id}`, { name: 'Sheet steel', unitId: kg.id, openings: [{ locationId: main.id, quantity: '4000.0', rate: '4.20' }], revision: current.revision });
    assert.equal(same.status, 200, 'the same rows re-sent are no change');
    await refused(call(`/stock-items/${sheet.id}/delete`, { revision: same.body.stockItem.revision }), 409, 'locked_period', 'deleting an item with opening stock under the lock');
    assert.equal((await call('/stock-items', { name: 'No stock', unitId: nos.id })).status, 201, 'an item without opening stock is not locked');
  } finally {
    await asAdmin(database.adminUrl, admin => admin.query('UPDATE company SET locked_through = NULL WHERE company_id = $1', [companyId]));
  }
});

test('inventory is on for a new company; owners and admins switch it, and it stays on while the company has items', async () => {
  const fresh = await createCompany(owner.browser, { name: 'Switching Stock' });
  assert.deepEqual((await call('/inventory-setting', undefined, fresh)).body.inventory, { enabled: true });
  const unit = await made('/stock-units', { symbol: 'Nos' }, 'stockUnit', fresh);
  const item = await made('/stock-items', { name: 'Widget', unitId: unit.id }, 'stockItem', fresh);
  await refused(call('/inventory-setting', { enabled: false }, fresh), 409, 'in_use', 'off with an item');
  assert.equal((await call(`/stock-items/${item.id}/delete`, { revision: item.revision }, fresh)).status, 200);
  assert.deepEqual((await call('/inventory-setting', { enabled: false }, fresh)).body.inventory, { enabled: false }, 'off with no items');
  await refused(call('/stock-items', { name: 'Widget', unitId: unit.id }, fresh), 409, 'feature_off', 'an item while inventory is off');
  assert.deepEqual((await call('/inventory-setting', { enabled: true }, fresh)).body.inventory, { enabled: true });

  await refused(call('/inventory-setting', { enabled: false }, companyId, editor), 404, 'not_found', 'an editor');
  await refused(call('/inventory-setting', { enabled: false }, companyId, viewer), 404, 'not_found', 'a viewer');
  assert.deepEqual((await call('/inventory-setting', undefined, companyId, viewer)).body.inventory, { enabled: true }, 'members read it');
});

test('every create, alter and delete of a stock master writes one revision entry with its before and after', async () => {
  const kinds = [
    ['/stock-units', 'stockUnit', 'stock_unit', { symbol: 'Logged' }, { symbol: 'Logged 2' }],
    ['/stock-groups', 'stockGroup', 'stock_group', { name: 'Logged group' }, { name: 'Logged group 2', addQuantities: true }],
    ['/stock-categories', 'stockCategory', 'stock_category', { name: 'Logged category' }, { name: 'Logged category 2' }],
    ['/stock-locations', 'stockLocation', 'stock_location', { name: 'Logged location' }, { name: 'Logged location 2' }],
  ] as const;
  const unit = await made('/stock-units', { symbol: 'Log unit' }, 'stockUnit');
  const all = [...kinds, ['/stock-items', 'stockItem', 'stock_item', { name: 'Logged item', unitId: unit.id }, { name: 'Logged item 2', unitId: unit.id, openings: [{ locationId: (await mainLocation()).id, quantity: '2', rate: '1.50' }] }]] as const;
  for (const [path, key, entity, create, change] of all) {
    const created = await made(path, create, key);
    const altered = await call(`${path}/${created.id}`, { ...change, revision: created.revision });
    assert.equal(altered.status, 200, JSON.stringify(altered.body));
    assert.equal((await call(`${path}/${created.id}/delete`, { revision: altered.body[key].revision })).status, 200);
    const revisions = (await call(`${path}/${created.id}/revisions`)).body.revisions as any[];
    assert.deepEqual(revisions.map(row => [row.entity, row.action]), [[entity, 'create'], [entity, 'alter'], [entity, 'delete']], entity);
    assert.deepEqual([revisions[0].before, revisions[0].after.id, revisions[1].before.revision, revisions[1].after.revision, revisions[2].after], [null, created.id, 1, 2, null], entity);
  }
  const itemLog = (await asAdmin(database.adminUrl, admin => admin.query("SELECT after FROM revision_log WHERE entity = 'stock_item' AND action = 'alter' AND after->>'name' = 'Logged item 2'"))).rows[0].after;
  assert.deepEqual(itemLog.openings.map((row: any) => row.value), ['300'], 'the snapshot keeps opening values as exact minor units');
});

test('viewers read and cannot write; every route of another company answers not found', async () => {
  const unit = await made('/stock-units', { symbol: 'Seen' }, 'stockUnit');
  const mine: Record<string, { id: string; revision: number }> = {
    '/stock-units': unit,
    '/stock-groups': await made('/stock-groups', { name: 'Seen' }, 'stockGroup'),
    '/stock-categories': await made('/stock-categories', { name: 'Seen' }, 'stockCategory'),
    '/stock-locations': await made('/stock-locations', { name: 'Seen' }, 'stockLocation'),
    '/stock-items': await made('/stock-items', { name: 'Seen', unitId: unit.id }, 'stockItem'),
  };
  const writes: [string, unknown][] = [['/inventory-setting', { enabled: false }]];
  for (const [path, row] of Object.entries(mine)) {
    const body = { name: 'Viewer', symbol: 'Viewer', unitId: unit.id, revision: row.revision };
    writes.push([path, body], [`${path}/${row.id}`, body], [`${path}/${row.id}/delete`, { revision: row.revision }]);
  }
  for (const [path] of Object.entries(mine)) assert.equal((await call(path, undefined, companyId, viewer)).status, 200, `a viewer reads ${path}`);
  for (const [path, body] of writes) await refused(call(path, body, companyId, viewer), 404, 'not_found', `a viewer writing ${path}`);
  for (const [path, row] of Object.entries(mine)) {
    const now = Object.values((await call(`${path}/${row.id}`)).body)[0] as { revision: number; name?: string; symbol?: string };
    assert.deepEqual([now.revision, now.name ?? now.symbol], [row.revision, 'Seen'], `${path} unchanged`);
  }
  assert.equal((await call('/inventory-setting')).body.inventory.enabled, true, 'the switch unchanged');
  assert.equal((await call('/stock-units', { symbol: 'Editor unit' }, companyId, editor)).status, 201, 'editors write masters');

  const stranger = await setupStranger();
  const theirs = {
    unit: await made('/stock-units', { symbol: 'Theirs' }, 'stockUnit', other),
    group: await made('/stock-groups', { name: 'Theirs' }, 'stockGroup', other),
    category: await made('/stock-categories', { name: 'Theirs' }, 'stockCategory', other),
    location: await made('/stock-locations', { name: 'Theirs' }, 'stockLocation', other),
  };
  const item = await made('/stock-items', { name: 'Theirs', unitId: theirs.unit.id }, 'stockItem', other);
  const routes: [string, unknown][] = [['/inventory-setting', undefined], ['/inventory-setting', { enabled: false }]];
  for (const [path, id] of [['/stock-units', theirs.unit.id], ['/stock-groups', theirs.group.id], ['/stock-categories', theirs.category.id], ['/stock-locations', theirs.location.id], ['/stock-items', item.id]]) {
    routes.push([path, undefined], [path, { name: 'Intruder', symbol: 'Intruder' }], [`${path}/${id}`, undefined], [`${path}/${id}`, { name: 'Intruder', revision: 1 }],
      [`${path}/${id}/delete`, { revision: 1 }], [`${path}/${id}/revisions`, undefined]);
  }
  for (const [path, body] of routes) await refused(call(path, body, other, stranger), 404, 'not_found', `${body === undefined ? 'GET' : 'POST'} ${path}`);
  // The same ids reached through a company the caller can open are not found there either.
  for (const [path, id] of [['/stock-units', theirs.unit.id], ['/stock-items', item.id], ['/stock-locations', theirs.location.id]]) {
    await refused(call(`${path}/${id}`, undefined, companyId), 404, 'not_found', `another company's ${path} through this one`);
  }
  assert.equal((await call(`/stock-items/${item.id}`, undefined, other)).body.stockItem.name, 'Theirs', 'unchanged');
});

/** A signed-in user of another installation workspace who is no member of `other`. */
async function setupStranger(): Promise<Member> {
  const elsewhere = await createCompany(owner.browser, { name: 'Stranger Home' });
  return invite(owner.browser, elsewhere, 'admin');
}
