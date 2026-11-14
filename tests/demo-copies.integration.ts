import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { compareDataset } from '../src/server/demo/compare.ts';
import { demoRoot, DemoError, loadDataset, type Dataset } from '../src/server/demo/dataset.ts';
import { formatSeedReport, namedCreationKey, seedDataset, seedDemo } from '../src/server/demo/seed.ts';
import { listLedgers } from '../src/server/ledger/masters.ts';
import { listVouchers } from '../src/server/ledger/vouchers.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { inCompany, invite, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * Named copies of a dataset's masters (`seed:demo --masters-only --as "<name>"`): one owner holds the dataset's own company
 * and any number of separately named masters-only copies, each found again by its own key, none disturbing the others.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let starter: Dataset;

before(async () => {
  database = await freshDatabase('demo_copies');
  owner = await setupOwner();
  starter = await loadDataset(join(demoRoot, 'starter-trading'));
});
after(async () => { await database?.drop(); });

const emailOf = async (member: Member) => (await member.browser.call('/api/me')).body.user.email as string;
/** The companies the member sees except the owner's own workspace they were invited to, which is not the seeder's. */
const companiesOf = async (member: Member) => ((await member.browser.call('/api/companies')).body.companies as { id: string; name: string }[]).filter(company => company.id !== owner.workspaceId);
const voucherCount = (userId: string, companyId: string) => inCompany(userId, companyId, async context =>
  (await listVouchers(context, { from: '2000-01-01', to: '2100-01-01', limit: 500 })).vouchers.length);

test('two named copies and the dataset\'s own company coexist for one owner, and a rerun of each changes nothing', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const walkA = await seedDataset(user.userId, starter, true, 'Keymap walk A');
  const walkB = await seedDataset(user.userId, starter, true, 'Keymap walk B');
  const own = await seedDataset(user.userId, starter);
  assert.deepEqual([walkA.companyCreated, walkB.companyCreated, own.companyCreated], [true, true, true]);
  assert.equal(new Set([walkA.companyId, walkB.companyId, own.companyId]).size, 3, 'three separate companies');
  assert.deepEqual([walkA.companyName, walkB.companyName, own.companyName], ['Keymap walk A', 'Keymap walk B', starter.company.name]);
  assert.deepEqual((await companiesOf(user)).map(company => company.name).sort(), ['Keymap walk A', 'Keymap walk B', starter.company.name].sort());

  // The copies hold the masters and no vouchers; the same ledgers as the dataset's own company, with the openings.
  assert.deepEqual([walkA.vouchers.created, walkA.ledgers.created > 0, walkA.mastersOnly], [0, true, true]);
  assert.equal(await voucherCount(user.userId, walkA.companyId), 0);
  assert.equal(await voucherCount(user.userId, walkB.companyId), 0);
  assert.ok(await voucherCount(user.userId, own.companyId) > 0);
  const names = async (id: string) => (await inCompany(user.userId, id, context => listLedgers(context))).map(ledger => `${ledger.name} ${ledger.opening.amount} ${ledger.opening.side}`).sort();
  assert.deepEqual(await names(walkA.companyId), await names(own.companyId));

  // A rerun of each finds the same company and changes nothing.
  for (const [report, copy] of [[walkA, 'Keymap walk A'], [walkB, 'Keymap walk B']] as const) {
    const again = await seedDataset(user.userId, starter, true, copy);
    assert.deepEqual([again.companyCreated, again.companyId, again.groups.created, again.ledgers.created, again.ledgers.openingsSet], [false, report.companyId, 0, 0, 0]);
    assert.equal(formatSeedReport(again)[0], `${copy} (starter-trading): already present, nothing changed`);
  }
  const ownAgain = await seedDataset(user.userId, starter);
  assert.deepEqual([ownAgain.companyCreated, ownAgain.companyId, ownAgain.vouchers.created], [false, own.companyId, 0]);
  assert.equal((await companiesOf(user)).length, 3, 'no further company was made');
});

test('the full seed still lands in the unnamed company, also when a named copy was seeded first', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const copy = await seedDataset(user.userId, starter, true, 'Copy first');
  const full = await seedDataset(user.userId, starter);
  assert.equal(full.companyCreated, true, 'the copy is not the dataset\'s own company, so the full seed makes it');
  assert.notEqual(full.companyId, copy.companyId);
  assert.equal(full.companyName, starter.company.name);
  assert.equal(await voucherCount(user.userId, copy.companyId), 0, 'nothing of the full seed reached the copy');
  assert.ok(await voucherCount(user.userId, full.companyId) > 0);
});

test('the dataset comparison reads the dataset\'s own company only and ignores named copies', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  await seedDataset(user.userId, starter, true, 'Only a copy');
  // With a copy alone the dataset has not been seeded as far as the comparison is concerned (the copy has no vouchers to compare).
  await assert.rejects(compareDataset(user.userId, starter), (error: unknown) => error instanceof DemoError && /has not been seeded for this user/.test(error.message));
  const own = await seedDataset(user.userId, starter);
  const result = await compareDataset(user.userId, starter);
  assert.equal(result.companyId, own.companyId);
  assert.deepEqual(result.lines.filter(item => !item.ok && !item.reason), []);
});

test('the name is validated like a company name, may not be the dataset\'s own name, and a copy is masters only', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  await assert.rejects(seedDataset(user.userId, starter, true, '   '), /--as: Enter the company name/);
  await assert.rejects(seedDataset(user.userId, starter, true, 'x'.repeat(121)), /--as:/);
  await assert.rejects(seedDataset(user.userId, starter, true, `Bad\u0007name`), /--as:/);
  await assert.rejects(seedDataset(user.userId, starter, true, starter.company.name.toUpperCase()), /the name of the dataset's own company/);
  await assert.rejects(seedDataset(user.userId, starter, false, 'Full with a name'), /add --masters-only/);
  assert.equal((await companiesOf(user)).length, 0, 'a refused name made no company');
  // Surrounding spaces are trimmed as company creation trims them, and the trimmed name is the copy's name and key.
  const spaced = await seedDataset(user.userId, starter, true, '  Spaced name  ');
  assert.equal(spaced.companyName, 'Spaced name');
  assert.equal((await seedDataset(user.userId, starter, true, 'Spaced name')).companyId, spaced.companyId);
});

test('the command refuses --as with the full seed, with --all and without --company', async () => {
  const email = await emailOf(owner);
  await assert.rejects(seedDemo({ email, company: 'starter-trading', as: 'Copy', yes: true }), /add --masters-only/);
  await assert.rejects(seedDemo({ email, all: true, mastersOnly: true, as: 'Copy', yes: true }), /--company <slug> and not --all/);
  await assert.rejects(seedDemo({ email, mastersOnly: true, as: 'Copy', yes: true }), /--company <slug> and not --all/);
  const printed: string[] = [];
  await seedDemo({ email, company: 'starter-trading', mastersOnly: true, as: 'Command copy', yes: true }, line => printed.push(line));
  assert.match(printed[0], /^Command copy \(starter-trading\): seeded$/);
  assert.ok((await companiesOf(owner)).some(company => company.name === 'Command copy'));
});

test('the copy\'s key is derived from dataset, owner and name, and differs from the unnamed key', () => {
  const key = namedCreationKey('starter-trading', 'user-1', 'Keymap walk A');
  assert.match(key, /^demo:starter-trading:user-1:as:[0-9a-f]{16}$/);
  assert.notEqual(key, namedCreationKey('starter-trading', 'user-1', 'Keymap walk B'));
  assert.notEqual(key, namedCreationKey('starter-trading', 'user-2', 'Keymap walk A'));
  assert.ok(key.length <= 100);
});
