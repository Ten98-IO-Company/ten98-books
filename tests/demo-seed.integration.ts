import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { demoRoot, DemoError, loadDataset, parseDataset, seededGroupKeys, type Dataset } from '../src/server/demo/dataset.ts';
import { compareDataset, compareDemo, formatCompareResult } from '../src/server/demo/compare.ts';
import { findUserId, formatSeedReport, seedDataset, seedDemo } from '../src/server/demo/seed.ts';
import { alterLedger, listGroups, listLedgers } from '../src/server/ledger/masters.ts';
import { listVouchers, readVoucher } from '../src/server/ledger/vouchers.ts';
import { companyNotFound } from '../src/server/tenancy.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { goldenCompany } from './helpers/golden.ts';
import { addLedger, chart, createCompany, inCompany, invite, rowCount, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The demo seeder and comparison against real PostgreSQL as books_app: starter-trading seeds, compares with zero
 * differences, seeds again without change, stays isolated per user, and is never written by a non-owner.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
let starter: Dataset;
let edge: Dataset;
let companyId = '';

/** A second dataset with what starter-trading lacks: a cancelled and an optional voucher, extras, a wrong expectation. */
const edgeDataset = (): Dataset => parseDataset({
  company: { slug: 'edge-check', name: 'Edge Check', country: 'AE', baseCurrency: 'KWD', minorUnits: 3, financialYearStart: { month: 4, day: 1 }, booksBeginning: '2026-04-01', timeZone: 'Asia/Kuwait', features: ['accounting', 'inventory'] },
  ledgers: [
    { key: 'cash', name: 'Cash', group: 'cash_in_hand', standard: 'cash', opening: { amount: '50.500', side: 'Dr' } },
    { key: 'capital', name: 'Capital', group: 'capital', opening: { amount: '50.500', side: 'Cr' }, extras: { shareClass: 'A' } },
    { key: 'rent', name: 'Rent', group: 'indirect_expenses' },
  ],
  vouchers: [
    { key: 'rent-april', type: 'payment', date: '2026-04-02', status: 'regular', postDated: false, narration: 'April rent', expectedNumber: 1,
      lines: [{ ledger: 'rent', side: 'Dr', amount: '10.250' }, { ledger: 'cash', side: 'Cr', amount: '10.250' }], inventory: [{ item: 'none' }] },
    { key: 'rent-wrong', type: 'payment', date: '2026-04-03', status: 'cancelled', postDated: false, narration: 'Entered twice', expectedNumber: 5,
      lines: [{ ledger: 'rent', side: 'Dr', amount: '10.250' }, { ledger: 'cash', side: 'Cr', amount: '10.250' }] },
    { key: 'rent-draft', type: 'payment', date: '2026-04-04', status: 'optional', postDated: false, narration: 'Draft',
      lines: [{ ledger: 'rent', side: 'Dr', amount: '1.000' }, { ledger: 'cash', side: 'Cr', amount: '1.000' }] },
    { key: 'rent-later', type: 'payment', date: '2026-05-01', status: 'regular', postDated: true, narration: 'May rent, post-dated',
      lines: [{ ledger: 'rent', side: 'Dr', amount: '10.250' }, { ledger: 'cash', side: 'Cr', amount: '10.250' }] },
  ],
  expected: {
    period: { from: '2026-04-01', to: '2026-05-31' }, voucherCount: 4, vouchersByType: { payment: 4 },
    // Deliberately wrong in two places (cash really closes at 30.000 Dr, the balance sheet at 30.000) to show the comparison reports them.
    trialBalance: { totalDebit: '50.500', totalCredit: '50.500', ledgers: { cash: { closing: '20.000', side: 'Dr' }, capital: { closing: '50.500', side: 'Cr' }, rent: { closing: '20.500', side: 'Dr' } } },
    profitAndLoss: { grossProfit: '0.000', netProfit: '-20.500' }, balanceSheet: { total: '31.000' }, payroll: { net: '0.000' },
  },
}, 'demo/edge-check');

before(async () => {
  database = await freshDatabase('demo_seed');
  owner = await setupOwner();
  starter = await loadDataset(join(demoRoot, 'starter-trading'));
  edge = edgeDataset();
});
after(async () => { await database?.drop(); });

const emailOf = async (member: Member) => (await member.browser.call('/api/me')).body.user.email as string;

const numbers = (userId: string, id: string, to: string) => inCompany(userId, id, async context => {
  const page = await listVouchers(context, { from: '2000-01-01', to, limit: 500 });
  return page.vouchers.map(voucher => `${voucher.kind} ${voucher.number}`);
});

test('the seeded group keys are exactly the system keys a new company is seeded with', async () => {
  const id = await createCompany(owner.browser, { name: 'Chart check' });
  const keys = (await inCompany(owner.userId, id, context => listGroups(context))).flatMap(group => group.systemKey ? [group.systemKey] : []);
  assert.deepEqual([...keys].sort(), [...seededGroupKeys].sort());
});

test('seeding starter-trading creates the company, masters and 18 vouchers numbered as expected', async () => {
  const report = await seedDataset(owner.userId, starter);
  companyId = report.companyId;
  assert.equal(report.companyCreated, true);
  assert.deepEqual(report.groups, { created: 1, present: 0 });
  assert.deepEqual(report.ledgers, { created: 12, present: 2, openingsSet: 3 });
  assert.deepEqual(report.vouchers, { created: 18, present: 0, cancelled: 0 });
  assert.deepEqual(report.numberDifferences, [], 'every expectedNumber matched');
  assert.deepEqual(report.skipped, []);
  assert.match(formatSeedReport(report)[0], /Starter Trading \(starter-trading\): seeded/);
  const me = (await owner.browser.call('/api/companies')).body.companies.find((company: { id: string }) => company.id === companyId);
  assert.equal(me.role, 'owner', 'the user became the owner');
  assert.equal(me.name, 'Starter Trading');
});

test('the comparison finds zero differences against expected.json', async () => {
  const result = await compareDataset(owner.userId, starter);
  assert.equal(result.differences, 0, formatCompareResult(result).join('\n'));
  assert.deepEqual(result.notComparable, []);
  const labels = result.lines.map(line => line.label);
  for (const label of ['Voucher count', 'Vouchers of type credit_note', 'Total debit', 'Total credit', 'Closing balance of Harbour Bank', 'Gross profit', 'Net profit', 'Total assets']) assert.ok(labels.includes(label), label);
  const net = result.lines.find(line => line.label === 'Net profit')!;
  assert.deepEqual([net.expected, net.actual, net.difference], ['-7400.00', '-7400.00', '0.00']);
  const printed: string[] = [];
  assert.equal(await compareDemo({ email: await emailOf(owner), company: 'starter-trading' }, line => printed.push(line)), 0);
  assert.ok(printed.some(line => line.includes('Closing balance of Supplier South') && line.includes('10075.00 Cr')));
});

test('running the seed again changes nothing: same vouchers, same numbers, reported as already present', async () => {
  const before = await numbers(owner.userId, companyId, '2026-12-31');
  const rowsBefore = await Promise.all(['account_group', 'ledger', 'voucher', 'voucher_line', 'revision_log'].map(table => rowCount(database.adminUrl, table, companyId)));
  const report = await seedDataset(owner.userId, starter);
  assert.equal(report.companyId, companyId);
  assert.equal(report.companyCreated, false);
  assert.deepEqual(report.groups, { created: 0, present: 1 });
  assert.deepEqual(report.ledgers, { created: 0, present: 14, openingsSet: 0 });
  assert.deepEqual(report.vouchers, { created: 0, present: 18, cancelled: 0 });
  assert.match(formatSeedReport(report)[0], /already present, nothing changed/);
  assert.deepEqual(await numbers(owner.userId, companyId, '2026-12-31'), before);
  assert.deepEqual(await Promise.all(['account_group', 'ledger', 'voucher', 'voucher_line', 'revision_log'].map(table => rowCount(database.adminUrl, table, companyId))), rowsBefore, 'no row was added');
  assert.equal(await rowCount(database.adminUrl, 'voucher', companyId), 18);
  assert.equal((await compareDataset(owner.userId, starter)).differences, 0);
});

test('a run that stopped halfway resumes: the missing vouchers are posted and the rest are left alone', async () => {
  // A prefix of starter-trading, as an earlier run stopped by an error would have left it.
  const partial: Dataset = { ...starter, vouchers: starter.vouchers.slice(0, 5), expected: { period: starter.expected.period } };
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const first = await seedDataset(user.userId, partial);
  assert.deepEqual(first.vouchers, { created: 5, present: 0, cancelled: 0 });
  const resumed = await seedDataset(user.userId, starter);
  assert.equal(resumed.companyId, first.companyId);
  assert.deepEqual(resumed.vouchers, { created: 13, present: 5, cancelled: 0 });
  assert.equal((await compareDataset(user.userId, starter)).differences, 0, 'identical to a single full run');
  assert.deepEqual(await numbers(user.userId, resumed.companyId, '2026-12-31'), await numbers(owner.userId, companyId, '2026-12-31'));
});

test('a second user gets a separate company with the same figures, and neither can reach the other', async () => {
  const second = await invite(owner.browser, owner.workspaceId, 'viewer');
  const report = await seedDataset(second.userId, starter);
  assert.equal(report.companyCreated, true);
  assert.notEqual(report.companyId, companyId);
  assert.equal((await compareDataset(second.userId, starter)).differences, 0);
  assert.equal(await rowCount(database.adminUrl, 'voucher', report.companyId), 18);
  assert.equal(await rowCount(database.adminUrl, 'voucher', companyId), 18, 'the first user\'s books did not change');
  await assert.rejects(inCompany(second.userId, companyId, () => Promise.resolve(), 'read'), { message: companyNotFound });
  await assert.rejects(inCompany(owner.userId, report.companyId, () => Promise.resolve(), 'read'), { message: companyNotFound });
});

test('a member who does not own the company never writes to it: seeding gives them a company of their own, beside the one they belong to', async () => {
  for (const role of ['viewer', 'editor', 'admin'] as const) {
    const member = await invite(owner.browser, companyId, role);
    const before = await rowCount(database.adminUrl, 'revision_log', companyId);
    const report = await seedDataset(member.userId, starter);
    assert.equal(report.companyCreated, true, role);
    assert.notEqual(report.companyId, companyId, `${role} did not write into the owner's company`);
    assert.equal(await rowCount(database.adminUrl, 'revision_log', companyId), before, `${role} wrote nothing into it`);
    // Owning one copy and belonging to another is not ambiguous: a second run finds their own, and compare says which it read.
    assert.equal((await seedDataset(member.userId, starter)).companyCreated, false);
    const compared = await compareDataset(member.userId, starter);
    assert.deepEqual([compared.companyId, compared.role, compared.differences], [report.companyId, 'owner', 0]);
    assert.ok(formatCompareResult(compared)[0].includes(`company ${report.companyId} (owner)`));
  }
  const viewer = await invite(owner.browser, companyId, 'viewer');
  await assert.rejects(inCompany(viewer.userId, companyId, () => Promise.resolve(), 'write'), { message: companyNotFound });
  const compared = await compareDataset(viewer.userId, starter);
  assert.deepEqual([compared.companyId, compared.role, compared.differences], [companyId, 'viewer', 0], 'a member who owns no copy can still read and compare the one they belong to');
});

test('two seeds at once for one user and dataset create one company, not two', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const reports = await Promise.all([seedDataset(user.userId, starter), seedDataset(user.userId, starter), seedDataset(user.userId, starter)]);
  assert.equal(new Set(reports.map(report => report.companyId)).size, 1);
  assert.equal(reports.filter(report => report.companyCreated).length, 1);
  assert.equal(reports.reduce((sum, report) => sum + report.vouchers.created, 0), 18);
  const named = (await user.browser.call('/api/companies')).body.companies.filter((company: { name: string }) => company.name === 'Starter Trading');
  assert.equal(named.length, 1);
  assert.equal((await compareDataset(user.userId, starter)).differences, 0, 'seed and compare still run');
});

test('a same-named company of the user that does not hold this dataset is never written to', async () => {
  const stranger = await invite(owner.browser, owner.workspaceId, 'viewer');
  const own = await createCompany(stranger.browser, { name: 'Starter Trading' });
  const book = await chart(stranger.browser, own);
  await addLedger(stranger.browser, own, 'Mine Alone', book.group('indirect_expenses'));
  await assert.rejects(seedDataset(stranger.userId, starter), (error: unknown) => error instanceof DemoError && /does not hold this demo data/.test(error.message));
  assert.equal(await rowCount(database.adminUrl, 'voucher', own), 0);
  await assert.rejects(compareDataset(stranger.userId, starter), /does not hold this demo data/);
});

test('cancelled and optional vouchers, extras and a wrong expectation: reported, not hidden or forced', async () => {
  const report = await seedDataset(owner.userId, edge);
  assert.deepEqual(report.vouchers, { created: 4, present: 0, cancelled: 1 });
  assert.deepEqual(report.ledgers, { created: 2, present: 1, openingsSet: 2 });
  assert.deepEqual(report.numberDifferences, ['voucher "rent-wrong" (payment): expected number 5, ten98-books assigned 2'], 'the number is reported, never forced');
  assert.deepEqual(report.skipped, [
    'company.json: feature "inventory" is not modelled', 'ledgers.json: extras on 1 ledger(s) (shareClass)',
    'vouchers.json: inventory on 1 voucher(s), 1 item line(s) (stock is not modelled)',
  ]);
  const statuses = await inCompany(owner.userId, report.companyId, async context => (await listVouchers(context, { from: '2000-01-01', to: '2030-12-31' })).vouchers.map(voucher => `${voucher.status}${voucher.postDated ? '+post-dated' : ''} ${voucher.number ?? 'no number'}`));
  assert.deepEqual(statuses, ['regular 1', 'cancelled 2', 'optional no number', 'regular+post-dated 3']);
  assert.equal(report.companyName, 'Edge Check');

  const result = await compareDataset(owner.userId, edge);
  assert.deepEqual(result.notComparable, ['payroll (a feature block ten98-books cannot compute yet)',
    'trialBalance: 1 ledger(s) not listed in expected.json close at zero and were not compared (Profit and Loss)']);
  const differing = result.lines.filter(line => !line.ok).map(line => line.label);
  assert.deepEqual(differing, ['Closing balance of Cash', 'Total capital and liabilities', 'Total assets']);
  const cash = result.lines.find(line => line.label === 'Closing balance of Cash')!;
  assert.deepEqual([cash.expected, cash.actual, cash.difference], ['20.000 Dr', '30.000 Dr', '10.000 Dr'], 'exact on three-decimal minor units');
  assert.equal(result.differences, 3, 'the count a non-zero exit code is based on');
  const printed = formatCompareResult(result).join('\n');
  assert.ok(printed.includes('DIFFERS') && printed.includes('Not yet comparable:') && printed.includes('payroll'));
  assert.deepEqual((await seedDataset(owner.userId, edge)).vouchers, { created: 0, present: 4, cancelled: 0 });
});

test('the first error stops the seed and names the file and key; a changed voucher is not silently replaced', async () => {
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const broken: Dataset = { ...starter, vouchers: starter.vouchers.map((voucher, index) => index === 3 ? { ...voucher, type: 'receipt' } : voucher) };
  await assert.rejects(seedDataset(user.userId, broken), (error: unknown) => error instanceof DemoError
    && error.message.startsWith('demo/starter-trading/vouchers.json: voucher "payment-02":') && /cash or bank/.test(error.message));
  const created = (await seedDataset(user.userId, { ...starter, vouchers: starter.vouchers.slice(0, 3) }));
  assert.equal(created.vouchers.created, 0, 'the three posted before the error stay and are present on resume');
  const edited: Dataset = { ...starter, vouchers: starter.vouchers.map((voucher, index) => index === 0 ? { ...voucher, narration: 'Changed after seeding' } : voucher) };
  await assert.rejects(seedDataset(user.userId, edited), /voucher "payment-01": .*different voucher/);
});

test('the command guards: --yes is required, a user must exist and a dataset folder must exist', async () => {
  await assert.rejects(seedDemo({ email: await emailOf(owner), all: true, yes: false }), /Add --yes/);
  await assert.rejects(findUserId('nobody@books.test'), DemoError);
  await assert.rejects(seedDemo({ email: await emailOf(owner), company: 'no-such-folder', yes: true }), /There is no dataset folder demo\/no-such-folder/);
  await assert.rejects(seedDemo({ email: await emailOf(owner), company: 'starter-trading', all: true, yes: true }), /either --company/);
  const printed: string[] = [];
  await seedDemo({ email: await emailOf(owner), company: 'starter-trading', yes: true }, line => printed.push(line));
  assert.match(printed[0], /already present, nothing changed/);
  assert.ok(!printed.join('\n').includes(owner.userId), 'no identifiers beyond the plain report');
});

test('the dataset company settings are applied: currency, financial year, books beginning and time zone', async () => {
  const settings = (await owner.browser.call('/api/companies')).body.companies.find((company: { name: string }) => company.name === 'Edge Check').company;
  assert.deepEqual([settings.baseCurrency, settings.currencyMinorUnits, settings.financialYearStart, settings.booksBeginning, settings.timeZone],
    ['KWD', 3, { month: 4, day: 1 }, '2026-04-01', 'Asia/Kuwait']);
});

/** The comparison reads the whole trial balance, not only the ledgers expected.json names. */
const withLedgers = (dataset: Dataset, ledgers: NonNullable<Dataset['expected']['trialBalance']>['ledgers']): Dataset =>
  ({ ...dataset, expected: { ...dataset.expected, trialBalance: { ...dataset.expected.trialBalance!, ledgers } } });

test('a ledger with a balance that expected.json leaves out is a difference; one that closes at zero is named, not skipped', async () => {
  const { wages: _wages, 'profit-and-loss': _profit, ...rest } = starter.expected.trialBalance!.ledgers;
  const result = await compareDataset(owner.userId, withLedgers(starter, rest));
  const missing = result.lines.filter(line => !line.ok);
  assert.deepEqual(missing.map(line => [line.label, line.expected, line.actual]), [['Closing balance of Wages', 'not in expected.json', '6000.00 Dr']]);
  assert.equal(result.differences, 1);
  assert.deepEqual(result.notComparable, ['trialBalance: 1 ledger(s) not listed in expected.json close at zero and were not compared (Profit and Loss)']);
});

test('a ledger expected.json names that the app does not have is a difference, and so is the app ledger left unmatched', async () => {
  const renamed: Dataset = { ...starter, ledgers: starter.ledgers.map(ledger => ledger.key === 'wages' ? { ...ledger, name: 'Salaries' } : ledger) };
  const result = await compareDataset(owner.userId, renamed);
  assert.deepEqual(result.lines.filter(line => !line.ok).map(line => [line.label, line.actual]),
    [['Closing balance of Salaries', 'ledger missing'], ['Closing balance of Wages (not in the dataset)', '6000.00 Dr']]);
  const absent: Dataset = { ...starter, ledgers: [...starter.ledgers, { key: 'petty', name: 'Petty Float', group: 'cash_in_hand' }] };
  assert.deepEqual((await compareDataset(owner.userId, absent)).lines.filter(line => !line.ok).map(line => [line.label, line.actual]), [['Ledger Petty Float', 'ledger missing']]);
});

test('a period that spans two financial years is listed as not compared for profit and loss; any other failure stops the comparison', async () => {
  const spanning: Dataset = { ...starter, expected: { ...starter.expected, period: { from: '2026-01-01', to: '2027-03-01' } } };
  const result = await compareDataset(owner.userId, spanning);
  assert.ok(result.notComparable.some(line => line.startsWith('profitAndLoss (the period spans more than one financial year')));
  assert.ok(!result.lines.some(line => line.block === 'Profit and loss'));
  assert.ok(result.lines.some(line => line.block === 'Balance sheet'));
  const tooLong: Dataset = { ...starter, expected: { ...starter.expected, period: { from: '2026-01-01', to: '2037-01-02' } } };
  await assert.rejects(compareDataset(owner.userId, tooLong), /demo\/starter-trading\/expected\.json: the reports refused the period 2026-01-01 to 2037-01-02: Check the end date/);
});

test('a standard ledger the dataset names differently is listed in the seed report, and one moved out of its group stops the seed', async () => {
  const named: Dataset = { ...starter, ledgers: starter.ledgers.map(ledger => ledger.key === 'cash' ? { ...ledger, name: 'Kasse' } : ledger) };
  const user = await invite(owner.browser, owner.workspaceId, 'viewer');
  const report = await seedDataset(user.userId, named);
  assert.equal(report.nameDifferences.length, 1);
  assert.match(report.nameDifferences[0], /ledger "cash": the dataset calls it "Kasse", ten98-books calls it "Cash"/);
  assert.ok(formatSeedReport(report).some(line => line.includes('standard ledger names that differ')));
  assert.equal((await compareDataset(user.userId, starter)).differences, 0, 'the seeded name is kept, so the books still agree');

  await inCompany(user.userId, report.companyId, async context => {
    const cash = (await listLedgers(context)).find(ledger => ledger.systemKey === 'cash')!;
    const bank = (await listGroups(context)).find(group => group.systemKey === 'bank_accounts')!;
    await alterLedger(context, cash.id, { name: cash.name, secondLanguageName: cash.secondLanguageName, groupId: bank.id, opening: { amount: '0.00', side: 'Dr' }, revision: cash.revision });
  }, 'write');
  await assert.rejects(seedDataset(user.userId, starter), (error: unknown) => error instanceof DemoError
    && error.message.startsWith('demo/starter-trading/ledgers.json: ledger "cash": group "cash_in_hand" is not the group the cash ledger is in (Bank Accounts)'));
});

test('starter-trading equals the golden fixture field by field: groups, ledgers with openings, and every voucher with its lines and number', async () => {
  const golden = await goldenCompany(owner.browser);
  const byName = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
  const describe = (userId: string, id: string) => inCompany(userId, id, async context => {
    const groups = await listGroups(context);
    const parent = new Map(groups.map(group => [group.id, group.name]));
    const ledgers = (await listLedgers(context)).map(ledger => [ledger.name, ledger.groupName, ledger.opening.amount.toString(), ledger.opening.side, ledger.systemKey]);
    const vouchers = [];
    for (const summary of (await listVouchers(context, { from: '2000-01-01', to: '2030-12-31', limit: 500 })).vouchers) {
      const voucher = await readVoucher(context, summary.id);
      vouchers.push([voucher.kind, voucher.number, voucher.date, voucher.status, voucher.postDated, voucher.lines.map(line => [line.ledgerName, line.side, line.amount.toString()])]);
    }
    return {
      groups: groups.map(group => [group.name, group.parentId ? parent.get(group.parentId) : null, group.nature, group.grossProfit, group.systemKey]).sort(byName),
      ledgers: ledgers.sort(byName), vouchers,
    };
  });
  const fixture = await describe(owner.userId, golden.companyId);
  assert.equal(fixture.vouchers.length, 18);
  assert.deepEqual(await describe(owner.userId, companyId), fixture, 'narrations differ by design; everything else must match');
});
