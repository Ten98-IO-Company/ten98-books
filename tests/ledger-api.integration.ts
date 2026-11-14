import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { handleApi } from '../src/server/api.ts';
import { getConfig } from '../src/server/config.ts';
import { runLedger } from '../src/server/ledger/context.ts';
import { companyNotFound } from '../src/server/tenancy.ts';
import { ledgerErrorCodes } from '../src/lib/ledger.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, asAdmin, chart, createCompany, invite, post, setupOwner, voucherBody, type Chart, type Member } from './helpers/ledger.ts';

/**
 * API additions for the masters screens: who made each revision (`actorName`), stable error `code`s, and `inUse` on
 * group and ledger rows. Each is checked together with the shapes that must not change.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let editor: Member;
let companyId = '';
let books: Chart;
const ids = { rent: '', bank: '' };

before(async () => {
  database = await freshDatabase('ledger_api');
  owner = await setupOwner();
  companyId = await createCompany(owner.browser, { name: 'Screen Books' });
  editor = await invite(owner.browser, companyId, 'editor');
  books = await chart(owner.browser, companyId);
  ids.rent = await addLedger(owner.browser, companyId, 'Rent', books.group('indirect_expenses'));
  ids.bank = await addLedger(owner.browser, companyId, 'Bank', books.group('bank_accounts'), { amount: '100', side: 'Dr' });
});
after(async () => { await database?.drop(); });

const base = () => `/api/companies/${companyId}`;
const keys = (value: object) => Object.keys(value).sort();
const revisionKeys = ['action', 'actorId', 'actorName', 'after', 'at', 'before', 'entity', 'entityId', 'id'];
const ledgerKeys = ['cashOrBank', 'groupId', 'groupName', 'id', 'name', 'nature', 'opening', 'revision', 'secondLanguageName', 'systemKey'];
const groupKeys = ['grossProfit', 'id', 'name', 'nature', 'parentId', 'revision', 'secondLanguageName', 'systemKey'];

test('revision rows name the actor inside the company, never by email, and null once the user is gone', async () => {
  const ledger = (await owner.browser.call(`${base()}/ledgers/${ids.rent}`)).body.ledger;
  assert.equal((await editor.browser.call(`${base()}/ledgers/${ids.rent}`, { name: 'Office Rent', groupId: ledger.groupId, revision: ledger.revision })).status, 200);
  const history = (await owner.browser.call(`${base()}/ledgers/${ids.rent}/revisions`)).body.revisions;
  assert.deepEqual(history.map((row: { action: string; actorId: string; actorName: string }) => [row.action, row.actorId, row.actorName]),
    [['create', owner.userId, 'Owner'], ['alter', editor.userId, 'editor']]);
  for (const row of history) assert.deepEqual(keys(row), revisionKeys, 'only actorName is new');
  assert.ok(!JSON.stringify(history).includes('@'), 'no email in the history');

  // The same field on every revisions route.
  const voucher = await post(owner.browser, companyId, books.type('payment'), '2026-01-05', [[ids.rent, 'Dr', '5'], [books.ledger('Cash'), 'Cr', '5']]);
  const type = (await owner.browser.call(`${base()}/voucher-types/${books.type('journal')}`)).body.voucherType;
  assert.equal((await owner.browser.call(`${base()}/voucher-types/${type.id}`, { name: 'Journal Entry', revision: type.revision })).status, 200);
  for (const path of [`vouchers/${voucher.id}`, `voucher-types/${type.id}`, `groups/${books.group('indirect_expenses')}`]) {
    const rows = (await owner.browser.call(`${base()}/${path}/revisions`)).body.revisions;
    assert.ok(rows.every((row: { actorName: string | null }) => 'actorName' in row), path);
  }
  assert.equal((await owner.browser.call(`${base()}/vouchers/${voucher.id}/revisions`)).body.revisions[0].actorName, 'Owner');

  // A user who no longer exists keeps the id on the row; the name becomes null.
  const leaver = await invite(owner.browser, companyId, 'editor');
  const group = (await leaver.browser.call(`${base()}/groups`, { name: 'Leaver Group', nature: 'expense' })).body.group;
  await asAdmin(database.adminUrl, admin => admin.query('DELETE FROM "user" WHERE id = $1', [leaver.userId]));
  const orphan = (await owner.browser.call(`${base()}/groups/${group.id}/revisions`)).body.revisions;
  assert.deepEqual(orphan.map((row: { actorId: string; actorName: string | null }) => [row.actorId, row.actorName]), [[leaver.userId, null]]);

  // Another company's user gets the same answer as for a missing company, with no name in it.
  const other = (await owner.browser.call('/api/workspaces', { name: 'Elsewhere' })).body.workspace.id;
  const intruder = await invite(owner.browser, other, 'admin');
  const foreign = await intruder.browser.call(`${base()}/ledgers/${ids.rent}/revisions`);
  const missing = await intruder.browser.call(`/api/companies/${randomUUID()}/ledgers/${ids.rent}/revisions`);
  assert.deepEqual(foreign, { status: 404, body: { error: companyNotFound, code: 'not_found' } });
  assert.deepEqual(foreign, missing);
});

test('ledger refusals carry a stable code with their status and message unchanged; other areas carry none', async () => {
  const cash = (await owner.browser.call(`${base()}/ledgers/${books.ledger('Cash')}`)).body.ledger;
  const rent = (await owner.browser.call(`${base()}/ledgers/${ids.rent}`)).body.ledger;
  const userAssets = (await owner.browser.call(`${base()}/groups`, { name: 'Other Assets', nature: 'asset' })).body.group;
  const outer = (await owner.browser.call(`${base()}/groups`, { name: 'Outer', nature: 'expense' })).body.group;
  const inner = (await owner.browser.call(`${base()}/groups`, { name: 'Inner', parentId: outer.id })).body.group;
  const cashLine = (amount: string): [string, 'Dr' | 'Cr', string][] => [[ids.rent, 'Dr', amount], [books.ledger('Cash'), 'Cr', amount]];
  const keyed = voucherBody(books.type('payment'), '2026-01-06', cashLine('6'));
  assert.equal((await owner.browser.call(`${base()}/vouchers`, keyed)).status, 201);
  const regular = await post(owner.browser, companyId, books.type('payment'), '2026-01-07', cashLine('7'));
  const cancelled = (await owner.browser.call(`${base()}/vouchers/${regular.id}/cancel`, { revision: regular.revision })).body.voucher;
  await asAdmin(database.adminUrl, admin => admin.query(`UPDATE company SET locked_through = '2026-01-03' WHERE company_id = $1`, [companyId]));
  const cases: [string, unknown, number, string, string | RegExp][] = [
    [`${base()}/ledgers`, { groupId: books.group('capital') }, 400, 'validation', 'Check the ledger name and try again.'],
    [`${base()}/ledgers/${randomUUID()}`, undefined, 404, 'not_found', 'Ledger not found.'],
    [`${base()}/ledgers/${randomUUID()}/balance?from=2026-01-01&to=2026-01-31`, undefined, 404, 'not_found', 'Ledger not found.'],
    [`${base()}/ledgers/${ids.rent}`, { name: 'Rent', groupId: rent.groupId, revision: rent.revision + 5 }, 409, 'stale_revision', 'This ledger was changed by someone else. Reload it and try again.'],
    [`${base()}/ledgers`, { name: 'Bank', groupId: books.group('capital') }, 409, 'duplicate_name', 'A ledger with this name already exists.'],
    [`${base()}/ledgers/${ids.rent}/delete`, { revision: rent.revision }, 409, 'in_use', 'This ledger is used in vouchers and cannot be deleted.'],
    [`${base()}/ledgers/${cash.id}/delete`, { revision: cash.revision }, 409, 'seeded_row', 'Built-in ledgers can be renamed but not deleted.'],
    [`${base()}/ledgers/${cash.id}`, { name: 'Cash', groupId: books.group('capital'), revision: cash.revision }, 400, 'nature_fixed', 'A built-in ledger keeps its nature. Choose a group of the same nature.'],
    [`${base()}/ledgers/${cash.id}`, { name: 'Cash', groupId: userAssets.id, revision: cash.revision }, 400, 'family_rule', 'The cash ledger must stay under a cash or bank group.'],
    [`${base()}/groups/${outer.id}`, { name: 'Outer', parentId: inner.id, revision: outer.revision }, 400, 'cycle', 'A group cannot be placed under one of its own sub-groups.'],
    [`${base()}/vouchers`, voucherBody(books.type('payment'), '2026-01-03', cashLine('1')), 409, 'locked_period', /^The books are locked through 2026-01-03\./],
    [`${base()}/vouchers`, voucherBody(books.type('payment'), '2025-12-31', cashLine('1')), 400, 'before_books_beginning', 'The date 2025-12-31 is before the books begin on 2026-01-01.'],
    [`${base()}/vouchers`, voucherBody(books.type('payment'), '2026-01-08', [[ids.rent, 'Dr', '2'], [books.ledger('Cash'), 'Cr', '1']]), 400, 'unbalanced', 'Debits (2.00) and credits (1.00) must be equal.'],
    [`${base()}/vouchers`, voucherBody(books.type('journal'), '2026-01-08', cashLine('1')), 400, 'posting_rule', /^A journal cannot use a cash or bank ledger/],
    [`${base()}/vouchers/${regular.id}`, { date: '2026-01-07', narration: null, status: 'regular', postDated: false, lines: [], revision: cancelled.revision }, 409, 'voucher_state', 'A cancelled voucher cannot be altered.'],
    [`${base()}/vouchers`, { ...keyed, narration: 'Changed' }, 409, 'idempotency_mismatch', 'This idempotency key was already used for a different voucher. Send a new key for a new voucher.'],
    [`/api/companies/${randomUUID()}/groups`, undefined, 404, 'not_found', companyNotFound],
  ];
  try {
    for (const [path, body, status, code, message] of cases) {
      const response = await owner.browser.call(path, body);
      assert.equal(response.status, status, `${code}: ${JSON.stringify(response.body)}`);
      assert.deepEqual(keys(response.body), ['code', 'error'], code);
      assert.equal(response.body.code, code);
      if (typeof message === 'string') assert.equal(response.body.error, message, code); else assert.match(response.body.error, message, code);
    }
  } finally {
    await asAdmin(database.adminUrl, admin => admin.query('UPDATE company SET locked_through = NULL WHERE company_id = $1', [companyId]));
  }
  // A built-in group cannot change nature.
  const builtIn = (await owner.browser.call(`${base()}/groups/${books.group('indirect_expenses')}`)).body.group;
  const fixed = await owner.browser.call(`${base()}/groups/${builtIn.id}`, { name: builtIn.name, nature: 'income', revision: builtIn.revision });
  assert.deepEqual([fixed.status, fixed.body.code], [400, 'nature_fixed']);

  // The request body itself: a non-JSON body is a validation refusal with its status unchanged.
  const raw = await handleApi(new Request(new URL(`${base()}/ledgers`, getConfig().appUrl), {
    method: 'POST', body: 'name=Rent', headers: { 'content-type': 'text/plain', origin: getConfig().appUrl, cookie: [...owner.browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
  }));
  assert.deepEqual([raw.status, await raw.json()], [415, { error: 'content-type must be application/json', code: 'validation' }]);

  // A deadlock or serialization failure inside a ledger transaction becomes `retry`.
  await assert.rejects(runLedger(owner.userId, companyId, 'write', async () => { throw Object.assign(new Error('deadlock'), { code: '40P01' }); }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409 && (error as { code?: string }).code === 'retry');

  // Non-ledger areas answer exactly as before: no code.
  assert.deepEqual(await owner.browser.call(`/api/companies/${randomUUID()}`), { status: 404, body: { error: companyNotFound } });
  assert.deepEqual(await owner.browser.call(`/api/companies/${randomUUID()}/setup`, { name: 'Nowhere', ...{ baseCurrency: 'AED', financialYearStart: { month: 1, day: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai' } }),
    { status: 404, body: { error: companyNotFound } });
  assert.ok(ledgerErrorCodes.length >= 14);
});

test('group and ledger rows say whether a delete would be refused for use, matching the delete rule', async () => {
  const group = (await owner.browser.call(`${base()}/groups`, { name: 'Usage Group', nature: 'expense' })).body.group;
  assert.deepEqual(keys(group), groupKeys, 'a create answer is the plain group');
  const findGroup = async (id: string) => (await owner.browser.call(`${base()}/groups`)).body.groups.find((row: { id: string }) => row.id === id);
  const listed = await findGroup(group.id);
  assert.deepEqual(keys(listed), [...groupKeys, 'inUse'].sort());
  assert.equal(listed.inUse, false);
  assert.equal((await owner.browser.call(`${base()}/groups/${group.id}`)).body.group.inUse, false);

  const ledgerId = await addLedger(owner.browser, companyId, 'Usage Ledger', group.id);
  assert.equal((await findGroup(group.id)).inUse, true, 'a ledger makes the group in use');
  const child = (await owner.browser.call(`${base()}/groups`, { name: 'Usage Child', parentId: group.id })).body.group;
  assert.equal((await owner.browser.call(`${base()}/groups/${child.id}`)).body.group.inUse, false);

  const findLedger = async () => (await owner.browser.call(`${base()}/ledgers`)).body.ledgers.find((row: { id: string }) => row.id === ledgerId);
  assert.deepEqual(keys(await findLedger()), [...ledgerKeys, 'inUse'].sort());
  assert.equal((await findLedger()).inUse, false);
  const voucher = await post(owner.browser, companyId, books.type('payment'), '2026-01-09', [[ledgerId, 'Dr', '3'], [books.ledger('Cash'), 'Cr', '3']]);
  assert.equal((await findLedger()).inUse, true);
  const cancelled = (await owner.browser.call(`${base()}/vouchers/${voucher.id}/cancel`, { revision: voucher.revision })).body.voucher;
  assert.equal((await owner.browser.call(`${base()}/vouchers/${voucher.id}/delete`, { revision: cancelled.revision })).status, 200);
  const single = (await owner.browser.call(`${base()}/ledgers/${ledgerId}`)).body.ledger;
  assert.equal(single.inUse, true, 'lines of a cancelled, then deleted, voucher still count');
  const refused = await owner.browser.call(`${base()}/ledgers/${ledgerId}/delete`, { revision: single.revision });
  assert.deepEqual([refused.status, refused.body.code], [409, 'in_use'], 'and the delete is refused, as inUse said');

  // An unused ledger deletes, as inUse false said; write answers and revision snapshots stay the plain master.
  const spare = await owner.browser.call(`${base()}/ledgers`, { name: 'Spare', groupId: child.id });
  assert.deepEqual(keys(spare.body.ledger), ledgerKeys);
  assert.equal((await owner.browser.call(`${base()}/ledgers/${spare.body.ledger.id}`)).body.ledger.inUse, false);
  assert.equal((await owner.browser.call(`${base()}/ledgers/${spare.body.ledger.id}/delete`, { revision: 1 })).status, 200);
  const snapshot = (await owner.browser.call(`${base()}/ledgers/${spare.body.ledger.id}/revisions`)).body.revisions[0].after;
  assert.deepEqual(keys(snapshot), ledgerKeys);
});
