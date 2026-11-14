import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addLedger, chart, createCompany, invite, setupOwner, type Chart, type Member } from './helpers/ledger.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';

/**
 * What the masters screens read and rely on, over the real HTTP contract: the opening-balance totals the ledger form
 * shows (from the trial balance), what a viewer may and may not do, and the refusals the forms explain in advance.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let viewer: Member;
let company = '';
let other = '';
let books: Chart;

before(async () => {
  database = await freshDatabase('masters_screens');
  owner = await setupOwner();
  viewer = await invite(owner.browser, owner.workspaceId, 'viewer');
  company = await createCompany(owner.browser, owner.workspaceId, { name: 'Muscat Screens', baseCurrency: 'OMR', booksBeginning: '2026-01-01' });
  other = await createCompany(owner.browser, owner.workspaceId, { name: 'Neighbour Screens' });
  books = await chart(owner.browser, company);
});
after(async () => { await database?.drop(); });

const base = (id = company) => `/api/companies/${id}`;
const openingTotals = async (member: Member = owner) => (await member.browser.call(`${base()}/trial-balance?from=2026-01-01&to=2026-01-01`)).body.trialBalance;

test('the opening totals on the ledger form come from the trial balance at books beginning, in the currency exponent, with the difference and its side', async () => {
  const empty = await openingTotals();
  assert.equal(empty.totals.openingDebit, '0.000');
  assert.equal(empty.openingDifference.side, null);
  await addLedger(owner.browser, company, 'Share Capital', books.group('capital'), { amount: '12000.500', side: 'Cr' });
  await addLedger(owner.browser, company, 'Office Equipment', books.group('fixed_assets'), { amount: '2500.250', side: 'Dr' });
  const after = await openingTotals();
  assert.equal(after.totals.openingDebit, '2500.250');
  assert.equal(after.totals.openingCredit, '12000.500');
  assert.deepEqual(after.openingDifference, { amount: '9500.250', side: 'Cr' });
  // Balancing it clears the difference; the screen shows exactly this and never adds balances itself.
  await addLedger(owner.browser, company, 'Bank Balance', books.group('bank_accounts'), { amount: '9500.250', side: 'Dr' });
  assert.deepEqual((await openingTotals()).openingDifference, { amount: '0.000', side: null });
});

test('a three-decimal company refuses a fourth decimal and a negative opening, so the form can state the limit in advance', async () => {
  const refuse = async (amount: string) => (await owner.browser.call(`${base()}/ledgers`, { name: `Bad ${amount}`, groupId: books.group('capital'), opening: { amount, side: 'Cr' } })).status;
  assert.equal(await refuse('1.2345'), 400);
  assert.equal(await refuse('-5'), 400);
  assert.equal(await refuse('1,250.500'), 400);
});

test('a viewer reads the chart, the totals and a history, and every write is refused', async () => {
  const now = await chart(owner.browser, company);
  assert.equal((await viewer.browser.call(`${base()}/groups`)).status, 200);
  assert.equal((await viewer.browser.call(`${base()}/ledgers`)).status, 200);
  assert.equal((await viewer.browser.call(`${base()}/ledgers/${now.ledger('Share Capital')}/revisions`)).status, 200);
  assert.equal((await openingTotals(viewer)).totals.openingCredit, '12000.500');
  const ledger = (await owner.browser.call(`${base()}/ledgers/${now.ledger('Share Capital')}`)).body.ledger;
  const attempts = [
    viewer.browser.call(`${base()}/groups`, { name: 'Viewer group', parentId: books.group('capital') }),
    viewer.browser.call(`${base()}/ledgers`, { name: 'Viewer ledger', groupId: books.group('capital') }),
    viewer.browser.call(`${base()}/ledgers/${ledger.id}`, { name: 'Renamed', groupId: ledger.groupId, revision: ledger.revision }),
    viewer.browser.call(`${base()}/ledgers/${ledger.id}/delete`, { revision: ledger.revision }),
  ];
  for (const result of await Promise.all(attempts)) assert.equal(result.status, 404);
  assert.equal((await owner.browser.call(`${base()}/ledgers/${ledger.id}`)).body.ledger.name, 'Share Capital');
});

test('the rules the forms explain are refused by the server with the same sentences', async () => {
  const call = (path: string, body: unknown) => owner.browser.call(`${base()}/${path}`, body);
  const cash = (await owner.browser.call(`${base()}/ledgers/${books.ledger('Cash')}`)).body.ledger;
  const cashMove = await call(`ledgers/${cash.id}`, { name: 'Cash', groupId: books.group('fixed_assets'), revision: cash.revision });
  assert.equal(cashMove.status, 400);
  assert.match(cashMove.body.error, /cash ledger must stay/);
  const capital = (await owner.browser.call(`${base()}/groups/${books.group('capital')}`)).body.group;
  const nature = await call(`groups/${capital.id}`, { name: capital.name, parentId: null, nature: 'asset', revision: capital.revision });
  assert.equal(nature.status, 400);
  assert.match(nature.body.error, /keeps its nature/);
  const builtIn = await call(`groups/${capital.id}/delete`, { revision: capital.revision });
  assert.equal(builtIn.status, 409);
  assert.match(builtIn.body.error, /renamed but not deleted/);
  const duplicate = await call('groups', { name: 'Capital', parentId: null, nature: 'liability' });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already exists/);
  const stale = await call(`ledgers/${cash.id}`, { name: 'Cash on hand', groupId: cash.groupId, revision: cash.revision - 1 || 99 });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed by someone else/);
  // Another company's master is "not found", never a different company's data.
  const foreign = await owner.browser.call(`${base(other)}/ledgers/${cash.id}`);
  assert.equal(foreign.status, 404);
});
