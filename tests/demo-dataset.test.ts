import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { notComparable } from '../src/server/demo/compare.ts';
import { DatasetError, listDatasetFolders, loadDataset, parseDataset, demoRoot, toMinor, type RawDataset } from '../src/server/demo/dataset.ts';
import { unmodelled } from '../src/server/demo/seed.ts';

/** A small valid dataset; each test breaks one thing in a copy of it. */
const good = (): RawDataset & { company: any; groups: any[]; ledgers: any[]; vouchers: any[]; expected: any } => ({
  company: { slug: 'sample-shop', name: 'Sample Shop', country: 'AE', baseCurrency: 'AED', minorUnits: 2, financialYearStart: { month: 1, day: 1 }, booksBeginning: '2026-01-01', timeZone: 'Asia/Dubai', features: ['accounting'] },
  groups: [{ key: 'promotion-costs', name: 'Promotion Costs', under: 'indirect_expenses' }],
  ledgers: [
    { key: 'cash', name: 'Cash', group: 'cash_in_hand', standard: 'cash', opening: { amount: '100.00', side: 'Dr' } },
    { key: 'capital', name: 'Capital', group: 'capital', opening: { amount: '100.00', side: 'Cr' } },
    { key: 'promotion', name: 'Promotion', group: 'promotion-costs' },
  ],
  vouchers: [
    { key: 'pay-1', type: 'payment', date: '2026-01-05', status: 'regular', postDated: false, narration: 'Flyers', lines: [{ ledger: 'promotion', side: 'Dr', amount: '40.00' }, { ledger: 'cash', side: 'Cr', amount: '40.00' }] },
  ],
  expected: {
    period: { from: '2026-01-01', to: '2026-01-31' }, voucherCount: 1, vouchersByType: { payment: 1 },
    trialBalance: { totalDebit: '100.00', totalCredit: '100.00', ledgers: { cash: { closing: '60.00', side: 'Dr' } } },
    profitAndLoss: { grossProfit: '0.00', netProfit: '-40.00' }, balanceSheet: { total: '100.00' },
  },
});

/** The problems parseDataset reports for `raw`, or none. */
const problems = (raw: RawDataset): string[] => {
  try { parseDataset(raw, 'demo/sample-shop'); return []; }
  catch (error) { assert.ok(error instanceof DatasetError, String(error)); return error.issues; }
};
const mentions = (found: string[], ...parts: string[]) => assert.ok(found.some(issue => parts.every(part => issue.includes(part))), `expected an issue naming ${parts.join(' and ')}; got:\n${found.join('\n')}`);

test('a valid dataset parses and keeps extras, inventory and further feature files untouched', () => {
  const raw = good();
  raw.company.extras = { registration: 'x-1' };
  raw.ledgers[2].extras = { creditDays: 30 };
  raw.vouchers[0].extras = { reference: 'FL-9' };
  raw.vouchers[0].inventory = [{ item: 'flyer', quantity: '500' }];
  raw.expected.cashFlow = { net: '1.00' };
  raw.extraFiles = { 'items.json': [{ key: 'flyer' }] };
  const dataset = parseDataset(raw, 'demo/sample-shop');
  assert.deepEqual(dataset.vouchers[0].inventory, [{ item: 'flyer', quantity: '500' }]);
  assert.deepEqual(dataset.ledgers[2].extras, { creditDays: 30 });
  assert.deepEqual(dataset.company.extras, { registration: 'x-1' });
  assert.deepEqual(dataset.expected.cashFlow, { net: '1.00' });
  assert.deepEqual(dataset.extraFiles, { 'items.json': [{ key: 'flyer' }] });
  assert.deepEqual(problems(raw), []);
});

test('files are strict: an unknown key is refused with the file and the key', () => {
  const raw = good();
  raw.vouchers[0].colour = 'red';
  raw.company.currencyName = 'dirham';
  const found = problems(raw);
  mentions(found, 'vouchers.json', '"pay-1"', 'colour');
  mentions(found, 'company.json', 'currencyName');
});

test('keys are lowercase slugs and unique inside their file', () => {
  const raw = good();
  raw.ledgers[1].key = 'Capital Account';
  raw.vouchers.push({ ...raw.vouchers[0] });
  const found = problems(raw);
  mentions(found, 'ledgers.json', '"Capital Account"', 'slug');
  assert.deepEqual(problems({ ...good(), vouchers: [good().vouchers[0], good().vouchers[0]] }).filter(issue => issue.includes('more than once')).length, 1);
});

test('every group "under" resolves to a dataset group or a seeded system key; cycles and seeded keys are refused', () => {
  const raw = good();
  raw.groups = [{ key: 'a', name: 'A', under: 'nowhere' }, { key: 'b', name: 'B', under: 'c' }, { key: 'c', name: 'C', under: 'b' }, { key: 'sales', name: 'Sales again', under: 'indirect_income' }];
  const found = problems(raw);
  mentions(found, 'groups.json', '"a"', 'nowhere');
  mentions(found, 'groups.json', 'cycle');
  mentions(found, 'groups.json', '"sales"', 'seeded');
  assert.deepEqual(problems({ ...good(), groups: [{ key: 'a', name: 'A', under: 'promotion-costs' }, { key: 'promotion-costs', name: 'Promotion Costs', under: 'indirect_expenses' }] }), [], 'a group may sit under a later group of the file');
});

test('every ledger group resolves; a group is required unless the ledger is standard; a standard ledger appears once', () => {
  const raw = good();
  raw.ledgers[1].group = 'missing-group';
  raw.ledgers[2] = { key: 'floating', name: 'Floating' };
  raw.ledgers.push({ key: 'second-cash', name: 'Second Cash', standard: 'cash' });
  const found = problems(raw);
  mentions(found, 'ledgers.json', '"capital"', 'missing-group');
  mentions(found, 'ledgers.json', '"floating"', 'group is required');
  mentions(found, 'ledgers.json', 'standard ledger', 'more than once');
  assert.deepEqual(problems({ ...good(), ledgers: [...good().ledgers, { key: 'profit-and-loss', name: 'Profit and Loss', standard: 'profit_and_loss' }] }), []);
});

test('every voucher type and ledger reference resolves', () => {
  const raw = good();
  raw.vouchers[0].type = 'petty_cash';
  raw.vouchers[0].lines[0].ledger = 'ghost';
  const found = problems(raw);
  mentions(found, 'vouchers.json', '"pay-1"', 'petty_cash');
  mentions(found, 'vouchers.json', '"pay-1"', 'lines[0]', 'ghost');
});

test('amounts are plain decimal strings that fit the company minor units', () => {
  for (const amount of ['1,000.00', '1e3', '-5.00', ' 5.00', '5.', '.5']) {
    const raw = good();
    raw.vouchers[0].lines[0].amount = amount;
    mentions(problems(raw), 'vouchers.json', 'lines[0]', 'plain decimal string');
  }
  const raw = good();
  raw.vouchers[0].lines[1].amount = '40.001';
  raw.ledgers[1].opening.amount = '100.005';
  const found = problems(raw);
  mentions(found, 'vouchers.json', 'lines[1]', '"40.001"', '2 decimal places');
  mentions(found, 'ledgers.json', '"capital"', '"100.005"', '2 decimal places');
  raw.company.minorUnits = 3;
  assert.deepEqual(problems(raw).filter(issue => issue.includes('decimal places')), [], 'three decimals fit a three-decimal currency');
  const zero = good();
  zero.vouchers[0].lines[0].amount = '0.00';
  mentions(problems(zero), 'lines[0]', 'more than zero');
  assert.equal(toMinor('40.5', 2), 4050n);
  assert.throws(() => toMinor('40.555', 2), RangeError);
});

test('a regular voucher must balance; a cancelled or optional one is checked when it is posted', () => {
  const raw = good();
  raw.vouchers[0].lines[1].amount = '39.99';
  mentions(problems(raw), 'vouchers.json', '"pay-1"', 'must balance');
  raw.vouchers[0].status = 'cancelled';
  assert.deepEqual(problems(raw), []);
  raw.vouchers[0].status = 'optional';
  assert.deepEqual(problems(raw), []);
});

test('no voucher is dated before the books begin', () => {
  const raw = good();
  raw.vouchers[0].date = '2025-12-31';
  mentions(problems(raw), 'vouchers.json', '"pay-1"', '2025-12-31', 'before the books begin on 2026-01-01');
  raw.vouchers[0].date = '2026-02-30';
  mentions(problems(raw), 'vouchers.json', '"pay-1"', 'real date');
});

test('expected.json references resolve and its counts agree', () => {
  const raw = good();
  raw.expected.trialBalance.ledgers.ghost = { closing: '1.00', side: 'Dr' };
  raw.expected.vouchersByType = { payment: 1, petty_cash: 2 };
  const found = problems(raw);
  mentions(found, 'expected.json', 'trialBalance.ledgers "ghost"');
  mentions(found, 'expected.json', 'vouchersByType "petty_cash"');
  mentions(found, 'expected.json', 'add up to 3 but voucherCount is 1');
  const wrongPeriod = good();
  wrongPeriod.expected.period = { from: '2026-02-01', to: '2026-01-01' };
  mentions(problems(wrongPeriod), 'expected.json', 'period', 'from must not be after to');
});

test('the company file checks its own fields and a missing required file is one clear message', () => {
  const raw = good();
  raw.company.minorUnits = 4;
  raw.company.financialYearStart = { month: 2, day: 30 };
  const found = problems(raw);
  mentions(found, 'company.json', 'minorUnits');
  mentions(found, 'company.json', 'financialYearStart', 'day that exists');
  const missing = good() as Partial<RawDataset>;
  delete missing.vouchers;
  mentions(problems(missing as RawDataset), 'vouchers.json');
});

test('loading a folder reports invalid JSON and a missing file by name, and the slug must equal the folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-dataset-'));
  try {
    const folder = join(root, 'sample-shop');
    await mkdir(folder);
    const raw = good();
    for (const name of ['company', 'groups', 'ledgers', 'vouchers', 'expected'] as const) await writeFile(join(folder, `${name}.json`), JSON.stringify(raw[name]));
    await writeFile(join(folder, 'items.json'), '[{"key":"flyer"}]');
    await writeFile(join(folder, 'README.md'), 'notes');
    const loaded = await loadDataset(folder);
    assert.deepEqual(loaded.extraFiles, { 'items.json': [{ key: 'flyer' }] });

    await writeFile(join(folder, 'ledgers.json'), '[ { "key": ');
    await assert.rejects(loadDataset(folder), /demo\/sample-shop\/ledgers\.json: not valid JSON/);
    await writeFile(join(folder, 'ledgers.json'), JSON.stringify(raw.ledgers));
    await rm(join(folder, 'expected.json'));
    await assert.rejects(loadDataset(folder), /demo\/sample-shop\/expected\.json: the file is missing/);

    const other = join(root, 'other-name');
    await mkdir(other);
    for (const name of ['company', 'groups', 'ledgers', 'vouchers', 'expected'] as const) await writeFile(join(other, `${name}.json`), JSON.stringify(raw[name]));
    await assert.rejects(loadDataset(other), /slug "sample-shop" must equal the folder name "other-name"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the skipped-feature summary names every kind of content ten98-books does not model', () => {
  const raw = good();
  raw.company.features = ['accounting', 'inventory', 'payroll'];
  raw.ledgers[2].extras = { creditDays: 30 };
  raw.vouchers[0].extras = { reference: 'FL-9' };
  raw.vouchers[0].lines[0].extras = { costCentre: 'north' };
  raw.vouchers[0].inventory = [{ item: 'flyer' }, { item: 'poster' }];
  raw.extraFiles = { 'employees.json': [] };
  const lines = unmodelled(parseDataset(raw, 'demo/sample-shop'));
  assert.deepEqual(lines, [
    'company.json: feature "inventory" is not modelled', 'company.json: feature "payroll" is not modelled',
    'ledgers.json: extras on 1 ledger(s) (creditDays)', 'vouchers.json: extras on 1 voucher(s) (reference)', 'vouchers.json: extras on 1 voucher line(s) (costCentre)',
    'vouchers.json: inventory on 1 voucher(s), 2 item line(s) (stock is not modelled)', 'employees.json: feature file not modelled (kept as is)',
  ]);
  assert.deepEqual(unmodelled(parseDataset(good(), 'demo/sample-shop')), []);
  assert.deepEqual(notComparable({ ...good().expected, payroll: {}, balanceSheet: { total: '1.00', ratios: {} } }), ['payroll (a feature block ten98-books cannot compute yet)', 'balanceSheet.ratios (not computed yet)']);
});

test('every dataset folder under demo/ validates and its slug is its folder name', async () => {
  const folders = await listDatasetFolders();
  assert.ok(folders.includes('starter-trading'));
  for (const folder of folders) assert.equal((await loadDataset(join(demoRoot, folder))).slug, folder);
});

test('starter-trading carries the golden fixture: 12 ledgers beyond the standard two, 18 vouchers in eight types', async () => {
  const dataset = await loadDataset(join(demoRoot, 'starter-trading'));
  assert.equal(dataset.ledgers.filter(ledger => !ledger.standard).length, 12);
  assert.equal(dataset.vouchers.length, 18);
  assert.equal(new Set(dataset.vouchers.map(voucher => voucher.type)).size, 8);
  assert.equal(dataset.expected.trialBalance?.totalDebit, '53625.00');
  assert.equal(dataset.expected.profitAndLoss?.netProfit, '-7400.00');
});
