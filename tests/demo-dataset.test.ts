import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDueDate, readLedgerBills, readLineBills } from '../src/server/demo/bill-rows.ts';
import { planBills } from '../src/server/demo/bills.ts';
import { readLedgerCostSetting, readLineCosts } from '../src/server/demo/cost-rows.ts';
import { notComparable } from '../src/server/demo/compare.ts';
import { checkNumbers, DatasetError, describeNumberDifference, dispositionOf, numbersKind, duplicateKeys, listDatasetFolders, loadDataset, openingStockValue, parseDataset, demoRoot, toMinor, type ItemsFile, type RawDataset } from '../src/server/demo/dataset.ts';
import { unmodelled } from '../src/server/demo/seed.ts';
import { goldenVouchers } from './helpers/golden.ts';

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
  raw.extraFiles = { 'suppliers.json': [{ key: 'flyer' }] };
  const dataset = parseDataset(raw, 'demo/sample-shop');
  assert.deepEqual(dataset.vouchers[0].inventory, [{ item: 'flyer', quantity: '500' }]);
  assert.deepEqual(dataset.ledgers[2].extras, { creditDays: 30 });
  assert.deepEqual(dataset.company.extras, { registration: 'x-1' });
  assert.deepEqual(dataset.expected.cashFlow, { net: '1.00' });
  assert.deepEqual(dataset.extraFiles, { 'suppliers.json': [{ key: 'flyer' }] });
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

test('a voucher type is a slug (types ten98-books lacks are allowed) and every ledger reference resolves', () => {
  const raw = good();
  raw.vouchers[0].lines[0].ledger = 'ghost';
  mentions(problems(raw), 'vouchers.json', '"pay-1"', 'lines[0]', 'ghost');
  raw.vouchers[0].type = 'Petty Cash';
  mentions(problems(raw), 'vouchers.json', '"pay-1"', 'type', 'slug');
  raw.vouchers[0].type = 'petty_cash';
  raw.vouchers[0].lines[0].ledger = 'promotion';
  assert.deepEqual(problems(raw), [], 'an unsupported type is valid; the seeder skips and counts it');
  assert.equal(dispositionOf(parseDataset(raw, 'demo/sample-shop').vouchers[0]), 'unsupported-type');
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
    await writeFile(join(folder, 'suppliers.json'), '[{"key":"flyer"}]');
    await writeFile(join(folder, 'README.md'), 'notes');
    const loaded = await loadDataset(folder);
    assert.deepEqual(loaded.extraFiles, { 'suppliers.json': [{ key: 'flyer' }] });

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
  raw.ledgers[2].extras = { address: ['Dubai'], creditDays: 30 };
  raw.vouchers[0].extras = { reference: 'FL-9' };
  raw.vouchers[0].lines[0].extras = { costCentre: 'north' };
  raw.vouchers[0].inventory = [{ item: 'flyer' }, { item: 'poster' }];
  raw.extraFiles = { 'employees.json': [] };
  const lines = unmodelled(parseDataset(raw, 'demo/sample-shop'));
  assert.deepEqual(lines, [
    'company.json: feature "inventory" is not modelled', 'company.json: feature "payroll" is not modelled',
    'ledgers.json: extras on 1 ledger(s) (address)', 'vouchers.json: extras on 1 voucher(s) (reference)', 'vouchers.json: extras on 1 voucher line(s) (costCentre)',
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

test('a standard ledger keeps its place: the profit and loss ledger has no group and the cash ledger stays in cash_in_hand', () => {
  const raw = good();
  raw.ledgers.push({ key: 'profit-and-loss', name: 'Profit and Loss', standard: 'profit_and_loss', group: 'capital' });
  mentions(problems(raw), 'ledgers.json', '"profit-and-loss"', 'outside every group');
  raw.ledgers.pop();
  raw.ledgers[0].group = 'bank_accounts';
  mentions(problems(raw), 'ledgers.json', '"cash"', 'cash_in_hand', '"bank_accounts"');
  raw.ledgers[0].group = 'cash_in_hand';
  assert.deepEqual(problems(raw), []);
});

test('duplicateKeys finds a repeated key at any depth and ignores look-alikes inside strings and separate objects', () => {
  assert.deepEqual(duplicateKeys('{"a":1,"b":{"c":1,"c":2},"d":[{"e":1},{"e":2}],"s":"x\\"y\\":1,\\"s\\":2"}'), ['b: the key "c" appears more than once']);
  assert.deepEqual(duplicateKeys('[{"key":"a","amount":"1.00","amount":"2.00"}]'), ['[0]: the key "amount" appears more than once']);
  assert.deepEqual(duplicateKeys('{"a":1,"a":2}'), ['the top level: the key "a" appears more than once']);
  assert.deepEqual(duplicateKeys('[{"lines":[{"x":1},{"y":1,"y":1}]}]'), ['[0].lines[1]: the key "y" appears more than once']);
  assert.deepEqual(duplicateKeys('{"n":-1.5e3,"t":true,"z":null,"o":{},"l":[]}'), []);
});

test('loading refuses a file with a repeated key in one entry and a file over the size limit, naming the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-dataset-'));
  try {
    const folder = join(root, 'sample-shop');
    await mkdir(folder);
    const raw = good();
    for (const name of ['company', 'groups', 'ledgers', 'vouchers', 'expected'] as const) await writeFile(join(folder, `${name}.json`), JSON.stringify(raw[name]));
    await loadDataset(folder);
    await writeFile(join(folder, 'vouchers.json'), JSON.stringify(raw.vouchers).replace('"amount":"40.00","side":"Cr"', '"amount":"40.00","amount":"41.00","side":"Cr"').replace('"side":"Cr","amount":"40.00"', '"side":"Cr","amount":"40.00","amount":"41.00"'));
    await assert.rejects(loadDataset(folder), /demo\/sample-shop\/vouchers\.json: \[0\]\.lines\[1\]: the key "amount" appears more than once/);
    await writeFile(join(folder, 'vouchers.json'), JSON.stringify(raw.vouchers));
    await assert.rejects(loadDataset(folder, { maxBytes: 100 }), /demo\/sample-shop\/\w+\.json: the file is \d+ bytes; the limit is 100 bytes per file/);
    await writeFile(join(folder, 'suppliers.json'), JSON.stringify([{ a: 1 }]).replace('"a":1', '"a":1,"a":2'));
    await assert.rejects(loadDataset(folder), /suppliers\.json: \[0\]: the key "a" appears more than once/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('starter-trading carries every golden voucher: type, date, ledger names, sides and amounts, in order', async () => {
  const dataset = await loadDataset(join(demoRoot, 'starter-trading'));
  const ledgerName = new Map(dataset.ledgers.map(ledger => [ledger.key, ledger.name]));
  assert.equal(dataset.vouchers.length, goldenVouchers.length);
  goldenVouchers.forEach(([kind, date, lines], index) => {
    const voucher = dataset.vouchers[index];
    assert.deepEqual([voucher.type, voucher.date, voucher.status, voucher.postDated], [kind, date, 'regular', false], `voucher ${index + 1}`);
    assert.deepEqual(voucher.lines.map(line => [ledgerName.get(line.ledger), line.side, line.amount]), lines.map(([name, side, amount]) => [name, side, `${amount}.00`]), `lines of voucher ${index + 1}`);
  });
});

test('a voucher without lines must be cancelled or marked as having no accounting effect, and a marked one carries no lines', () => {
  const raw = good();
  raw.vouchers[0].lines = [];
  mentions(problems(raw), 'vouchers.json', '"pay-1"', 'without lines', 'noAccountingEffect');
  raw.vouchers[0].status = 'cancelled';
  assert.deepEqual(problems(raw), [], 'a cancelled voucher may have no lines');
  raw.vouchers[0].status = 'regular';
  raw.vouchers[0].extras = { noAccountingEffect: true };
  assert.deepEqual(problems(raw), [], 'a marked voucher may have no lines');
  raw.vouchers[0].lines = good().vouchers[0].lines;
  mentions(problems(raw), 'vouchers.json', '"pay-1"', 'carries no lines');
});

test('dispositionOf: post, unsupported type, or no entries to post', () => {
  const voucher = (type: string, lines: unknown[]) => ({ ...good().vouchers[0], type, lines }) as Parameters<typeof dispositionOf>[0];
  assert.equal(dispositionOf(voucher('payment', good().vouchers[0].lines)), 'post');
  assert.equal(dispositionOf(voucher('payment', [])), 'no-entries');
  assert.equal(dispositionOf(voucher('sales_order', [])), 'unsupported-type');
  assert.equal(dispositionOf(voucher('memorandum', good().vouchers[0].lines)), 'unsupported-type');
});

/** A small items.json: one unit, location, stock group and item with an opening at that location. */
const stock = () => ({
  units: [{ key: 'nos', name: 'Nos' }], locations: [{ key: 'main', name: 'Main' }], stockGroups: [{ key: 'lamps', name: 'Lamps' }],
  items: [{ key: 'lamp', name: 'Lamp', group: 'lamps', unit: 'Nos', opening: [{ location: 'main', quantity: '10', rate: '50.00' }], hsn: 'kept' }],
});

test('items.json is checked for shape and references only, and everything else in it is kept', () => {
  const raw = good();
  raw.extraFiles = { 'items.json': stock() };
  const dataset = parseDataset(raw, 'demo/sample-shop');
  assert.deepEqual(dataset.extraFiles['items.json'], stock());
  assert.equal(openingStockValue(dataset.extraFiles['items.json'] as ItemsFile, 2), 50000n);

  const bad = good();
  const items = stock();
  items.items[0].group = 'nowhere';
  items.items[0].unit = 'Kg';
  items.items[0].opening = [{ location: 'attic', quantity: '10', rate: '50.005' }];
  bad.extraFiles = { 'items.json': items };
  const found = problems(bad);
  mentions(found, 'items.json', '"lamp"', 'group "nowhere"');
  mentions(found, 'items.json', '"lamp"', 'unit "Kg"');
  mentions(found, 'items.json', '"lamp"', 'location "attic"');
  mentions(found, 'items.json', '"lamp"', 'rate "50.005"', '2 decimal places');
  const badKey = good();
  badKey.extraFiles = { 'items.json': { items: [{ key: 'Lamp Two', name: 'x' }] } };
  mentions(problems(badKey), 'items.json', 'items[0].key', 'slug');
  const notAFile = good();
  notAFile.extraFiles = { 'items.json': { items: 'many' } };
  mentions(problems(notAFile), 'items.json', 'items');
});

test('a unit may carry decimals (a whole number from 0 to 4), which is kept; anything else is refused', () => {
  const raw = good();
  const items = stock();
  items.units = [{ key: 'nos', name: 'Nos' }, { key: 'kg', name: 'Kg', decimals: 1 } as never, { key: 'ltr', name: 'Ltr', decimals: 4 } as never];
  raw.extraFiles = { 'items.json': items };
  assert.deepEqual(parseDataset(raw, 'demo/sample-shop').extraFiles['items.json'], items);
  for (const decimals of [-1, 5, 1.5, '1']) {
    const bad = good();
    bad.extraFiles = { 'items.json': { ...stock(), units: [{ key: 'kg', name: 'Kg', decimals }] } };
    mentions(problems(bad), 'items.json', 'units[0].decimals');
  }
});

test('inventory lines name items and locations that items.json has, once the file is present', () => {
  const raw = good();
  raw.extraFiles = { 'items.json': stock() };
  raw.vouchers[0].inventory = [{ item: 'lamp', location: 'main', quantity: '1' }, { item: 'ghost', location: 'attic' }];
  const found = problems(raw);
  mentions(found, 'vouchers.json', '"pay-1"', 'inventory[1]', 'item "ghost"');
  mentions(found, 'vouchers.json', '"pay-1"', 'inventory[1]', 'location "attic"');
  assert.equal(found.length, 2);
  delete raw.extraFiles;
  assert.deepEqual(problems(raw), [], 'without items.json the inventory content is kept untouched and unchecked');
});

test('the opening stock value is quantity times rate for every item and location, rounded half up to the minor unit', () => {
  const items = { items: [
    { key: 'a', name: 'A', opening: [{ location: 'x', quantity: '480', rate: '38.00' }, { location: 'y', quantity: '160', rate: '38.00' }] },
    { key: 'b', name: 'B', opening: [{ location: 'x', quantity: '0.5', rate: '0.05' }] },
    { key: 'c', name: 'C' },
  ] } as ItemsFile;
  assert.equal(openingStockValue(items, 2), 2432003n, '24,320.00 plus 0.025 rounded to 0.03');
  assert.equal(openingStockValue(undefined, 2), 0n);
  assert.equal(openingStockValue({ items: [{ key: 'a', name: 'A', opening: [{ location: 'x', quantity: '3', rate: '1.250' }] }] } as ItemsFile, 3), 3750n);
});

test('expected.json may name voucher types the dataset uses beyond the seeded eight, and carries stock-aware figures', () => {
  const raw = good();
  raw.vouchers.push({ key: 'order-1', type: 'sales_order', date: '2026-01-06', status: 'regular', postDated: false, lines: [], extras: { noAccountingEffect: true } });
  raw.expected.voucherCount = 2;
  raw.expected.vouchersByType = { payment: 1, sales_order: 1 };
  raw.expected.profitAndLoss.grossProfitExcludingStock = '10.005';
  raw.expected.balanceSheet.closingStockInAssets = '1.234';
  const found = problems(raw);
  assert.equal(found.length, 2, found.join('\n'));
  mentions(found, 'expected.json', 'profitAndLoss.grossProfitExcludingStock', '"10.005"');
  mentions(found, 'expected.json', 'balanceSheet.closingStockInAssets', '"1.234"');
  raw.expected.profitAndLoss.grossProfitExcludingStock = '10.00';
  raw.expected.balanceSheet.closingStockInAssets = '1.23';
  assert.deepEqual(problems(raw), []);
});

test('blocks and fields the comparison cannot read are named with their reason; annotations are not listed', () => {
  const expected = { ...good().expected, source: 'x', voucherCountNote: 'y', stockSummary: { closingValue: '1.00' }, receivables: {}, payables: {}, vat: {},
    trialBalance: { ...good().expected.trialBalance, report: 'r', note: 'n' }, balanceSheet: { total: '1.00', closingStockInAssets: '1.00' } };
  assert.deepEqual(notComparable(expected), [
    'stockSummary (needs inventory)',
    'vat (needs the VAT return, which ten98-books does not compute yet)',
  ]);
});

test('the skipped-feature summary words items.json with its counts and the opening stock value', () => {
  const raw = good();
  raw.extraFiles = { 'items.json': stock(), 'employees.json': [] };
  assert.deepEqual(unmodelled(parseDataset(raw, 'demo/sample-shop')), [
    'items.json: stock not yet supported (1 item(s), 1 location(s); opening stock worth 500.00 is not a ledger balance)',
    'employees.json: feature file not modelled (kept as is)',
  ]);
});

test('numbersVerified is an optional boolean that says what expectedNumber is; it is not a figure to compare', () => {
  const raw = good();
  assert.equal(numbersKind(parseDataset(raw, 'demo/sample-shop')), 'dataset sequence (not yet verified against the reference)', 'the default');
  raw.expected.numbersVerified = false;
  assert.equal(numbersKind(parseDataset(raw, 'demo/sample-shop')), 'dataset sequence (not yet verified against the reference)');
  raw.expected.numbersVerified = true;
  assert.equal(numbersKind(parseDataset(raw, 'demo/sample-shop')), 'confirmed against the reference');
  assert.deepEqual(notComparable(raw.expected), []);
  raw.expected.numbersVerified = 'yes';
  mentions(problems(raw), 'expected.json', 'numbersVerified');
});

test('every dataset in demo/ says its numbers were confirmed against the reference', async () => {
  for (const slug of ['starter-trading', 'gulfline', 'najd', 'harbourview', 'sunrise']) assert.equal(numbersKind(await loadDataset(join(demoRoot, slug))), 'confirmed against the reference', slug);
});

/** Vouchers for the number check: type, key, date, status, lines, expectedNumber. */
const numbered = (...rows: [type: string, key: string, date: string, status: 'regular' | 'cancelled' | 'optional', lines: number, expectedNumber?: number][]) => ({
  company: { financialYearStart: { month: 1, day: 1 } },
  vouchers: rows.map(([type, key, date, status, lines, expectedNumber]) => ({
    key, type, date, status, postDated: false, expectedNumber, lines: Array.from({ length: lines }, () => ({ ledger: 'x', side: 'Dr' as const, amount: '1.00' })),
  })),
});

test('checkNumbers matches, skips what has no number to check, and explains a shift by skipped vouchers of the same type', () => {
  const dataset = numbered(
    ['journal', 'j1', '2026-01-01', 'optional', 2, 1], ['journal', 'j2', '2026-01-02', 'regular', 0, 2], ['journal', 'j3', '2026-01-03', 'regular', 2, 3],
    ['journal', 'j4', '2026-01-04', 'regular', 2, 4], ['sales_order', 'o1', '2026-01-05', 'regular', 0, 1], ['receipt', 'r1', '2026-01-06', 'regular', 2, 1], ['receipt', 'r2', '2026-01-07', 'regular', 2],
  );
  const assigned = new Map<string, number | null>([['j1', null], ['j3', 1], ['j4', 2], ['r1', 1], ['r2', 2]]);
  const check = checkNumbers(dataset as never, assigned);
  assert.deepEqual([check.checked, check.matched, check.unnumbered], [3, 1, 1], 'j3, j4 and r1 are checked; j1 is optional; o1 has an unsupported type; r2 has no expectedNumber');
  assert.deepEqual(check.differences.map(difference => [difference.key, difference.expected, difference.assigned, difference.explained]), [['j3', 3, 1, true], ['j4', 4, 2, true]]);
  assert.equal(describeNumberDifference(check.differences[0]), 'voucher "j3" (journal): expected number 3, ten98-books assigned 1; 2 earlier journal voucher(s) hold numbers in the dataset but none here, which accounts for the whole difference: j1 (optional), j2 (no entries)');
});

test('checkNumbers names refused and absent vouchers, and a restart of numbering is a real difference, not an explained one', () => {
  const dataset = numbered(
    ['sales', 's1', '2026-12-30', 'regular', 2, 1], ['sales', 's2', '2026-12-31', 'regular', 2, 2], ['sales', 's3', '2027-01-02', 'regular', 2, 1], ['sales', 's4', '2027-01-03', 'regular', 2, 2],
    ['payment', 'p1', '2026-01-02', 'regular', 2, 1], ['payment', 'p2', '2026-01-03', 'regular', 2, 2],
  );
  const check = checkNumbers(dataset as never, new Map([['s1', 1], ['s2', 2], ['s3', 3], ['s4', 4], ['p2', 1]]), new Set(['p1']));
  assert.deepEqual(check.differences.map(difference => [difference.key, difference.expected, difference.assigned, difference.explained]), [['s3', 1, 3, false], ['s4', 2, 4, false], ['p2', 2, 1, true]]);
  assert.ok(describeNumberDifference(check.differences[2]).endsWith('which accounts for the whole difference: p1 (refused by a posting rule)'));
  assert.equal(describeNumberDifference(check.differences[0]), 'voucher "s3" (sales): expected number 1, ten98-books assigned 3');
  const absent = checkNumbers(dataset as never, new Map([['s1', 1], ['s2', 2], ['s3', 3], ['s4', 4], ['p2', 1]]));
  assert.ok(describeNumberDifference(absent.differences[2]).endsWith('p1 (not in the books)'));
});

test('checkNumbers keys skipped vouchers by type and financial year, so a gap in one year explains nothing in the next', () => {
  const dataset = { ...numbered(
    ['journal', 'j1', '2027-03-20', 'regular', 0, 1], ['journal', 'j2', '2027-03-25', 'regular', 2, 2],
    ['journal', 'j3', '2027-04-02', 'regular', 2, 2], ['journal', 'j4', '2027-04-03', 'regular', 2, 3],
  ), company: { financialYearStart: { month: 4, day: 1 } } };
  const check = checkNumbers(dataset as never, new Map([['j2', 1], ['j3', 1], ['j4', 2]]));
  assert.deepEqual(check.differences.map(difference => [difference.key, difference.year, difference.holes.length, difference.explained]), [
    ['j2', '2026-04-01', 1, true], ['j3', '2027-04-01', 0, false], ['j4', '2027-04-01', 0, false]],
  'the March journal without entries explains the March shift only; April starts a new financial year');
});

/** Cost categories, centres and currencies for a dataset whose lines use them. */
const costing = () => ({
  'costCategories.json': [{ key: 'channel', name: 'Channel', allocateRevenue: true }, { key: 'projects', name: 'Projects' }],
  'costCentres.json': [{ key: 'online', name: 'Online', category: 'channel' }, { key: 'p-north', name: 'P-North', category: 'projects' }, { key: 'p-south', name: 'P-South', category: 'projects' }],
  'currencies.json': [{ code: 'USD', name: 'US Dollar', symbol: 'USD', rates: [{ kind: 'standard', date: '2026-01-01', rate: '3.6725' }] }],
  'checkpoints.json': { note: 'kept', dates: { '2026-02-28': { outstanding: {} } } },
});

test('cost categories, centres, currencies and checkpoints are accepted, checked and kept untouched', () => {
  const raw = good();
  raw.extraFiles = costing();
  raw.vouchers[0].lines[0].extras = { costCentres: [{ centre: 'online', amount: '40.00' }, { centre: 'p-north', amount: '30.00' }, { centre: 'p-south', amount: '10.00' }], currency: 'USD', currencyAmount: '10.89', rate: '3.6725', bills: [{ kind: 'new', name: 'A-1', amount: '10.89' }] };
  raw.vouchers[0].extras = { party: 'cash', reference: 'R-1' };
  const dataset = parseDataset(raw, 'demo/sample-shop');
  assert.deepEqual(dataset.extraFiles, costing());
  assert.deepEqual(dataset.vouchers[0].lines[0].extras, raw.vouchers[0].lines[0].extras);
  assert.deepEqual(problems(raw), []);
});

test('cost centre and currency references must resolve, and a category\'s allocations must add up to the line', () => {
  const raw = good();
  raw.extraFiles = costing();
  raw.vouchers[0].lines[0].extras = { costCentres: [{ centre: 'ghost', amount: '40.00' }], currency: 'EUR', currencyAmount: '1,5', rate: '3.6' };
  raw.vouchers[0].lines[1].extras = { costCentres: [{ centre: 'p-north', amount: '30.00' }, { centre: 'p-south', amount: '9.99' }] };
  raw.vouchers[0].extras = { party: 'nobody' };
  const found = problems(raw);
  mentions(found, 'vouchers.json', '"pay-1"', 'lines[0]', 'cost centre "ghost"');
  mentions(found, 'vouchers.json', '"pay-1"', 'lines[0]', 'currency "EUR"');
  mentions(found, 'vouchers.json', '"pay-1"', 'lines[0]', 'currencyAmount must be a plain decimal string');
  mentions(found, 'vouchers.json', '"pay-1"', 'lines[1]', 'category "projects" add up to 3999 but the line is 4000');
  mentions(found, 'vouchers.json', '"pay-1"', 'extras.party "nobody"');
});

test('cost centres name an existing category; keys are unique; checkpoint dates are real; item components are items', () => {
  const raw = good();
  const files = costing() as Record<string, any>;
  files['costCentres.json'].push({ key: 'online', name: 'Online again', category: 'elsewhere' });
  files['costCategories.json'].push({ key: 'projects', name: 'Dup' });
  files['currencies.json'].push({ code: 'USD', name: 'Dup' });
  files['checkpoints.json'].dates['2026-02-30'] = {};
  files['items.json'] = { items: [{ key: 'gate', name: 'Gate', extras: { billOfMaterials: [{ item: 'rod', quantity: '2' }] } }] };
  raw.extraFiles = files;
  const found = problems(raw);
  mentions(found, 'costCentres.json', 'centre "online"', 'category "elsewhere"');
  mentions(found, 'costCentres.json', 'cost centre "online"', 'more than once');
  mentions(found, 'costCategories.json', 'cost category "projects"', 'more than once');
  mentions(found, 'currencies.json', 'currency "USD"', 'more than once');
  mentions(found, 'checkpoints.json', 'dates "2026-02-30"', 'not a real date');
  mentions(found, 'items.json', 'item "gate"', 'billOfMaterials names "rod"');
  const shape = good();
  shape.extraFiles = { 'costCentres.json': [{ key: 'x', name: 'X' }], 'currencies.json': [{ code: 'usd', name: 'x', rates: [{ kind: 'standard', date: '2026-01-01', rate: '3,6' }] }] };
  const shapeFound = problems(shape);
  mentions(shapeFound, 'costCentres.json', 'category');
  mentions(shapeFound, 'currencies.json', 'three-letter currency code');
});

test('expected exchange differences are amounts that fit the currency, and the new blocks are named with their reason', () => {
  const raw = good();
  raw.expected.exchangeDifferences = { realised: { amount: '1.50', side: 'Dr' }, unrealised: { amount: '3.005', side: 'Dr' } };
  mentions(problems(raw), 'expected.json', 'exchangeDifferences.unrealised', '"3.005"');
  assert.deepEqual(notComparable({ ...good().expected, outstanding: {}, costCentres: {}, exchangeDifferences: {}, balanceSheet: { total: '1.00', unrealisedExchangeDifference: '1.00' } }), [
    'exchangeDifferences (needs foreign-currency accounting; the realised amount is the closing of the exchange gain and loss ledger, compared above, and the unrealised row is listed separately)',
  ]);
});

test('the skipped-feature summary counts bills, cost centres, foreign currencies and bank details, and words the new files', () => {
  const raw = good();
  raw.extraFiles = costing();
  raw.vouchers[0].lines[0].extras = { costCentres: [{ centre: 'online', amount: '40.00' }, { centre: 'p-north', amount: '40.00' }], currency: 'USD', currencyAmount: '10.89', rate: '3.6725', bank: { instrumentType: 'Cheque' } };
  raw.vouchers[0].lines[1].extras = { bills: [{ kind: 'new', name: 'A-1', amount: '40.00' }], currency: 'USD', currencyAmount: '10.89', rate: '3.6725' };
  const lines = unmodelled(parseDataset(raw, 'demo/sample-shop'));
  for (const expectedLine of [
    'vouchers.json: foreign-currency amounts on 2 voucher line(s) (USD 2): posted at their base-currency amounts; currency, currencyAmount and rate are kept, not modelled',
    'vouchers.json: bank details (instrument and bank date) on 1 voucher line(s) (not modelled)',
    'currencies.json: foreign currencies not yet supported (USD; 1 rate(s))', 'checkpoints.json: scenario checkpoint figures: pending bills are compared with the bill reports and the cost centre figures with the cost category summary',
  ]) assert.ok(lines.includes(expectedLine), expectedLine + '\n' + lines.join('\n'));
  assert.ok(!lines.some(text => /cost (centre|categor)/i.test(text) && !text.startsWith('checkpoints.json')), 'cost keys are read by the seeder, so they are not listed as skipped');
});

/** Bill keys the seeder reads: both spellings of the two generators, with plain-language problems for anything else. */
test('bill rows are read in both spellings and mapped to the ledger module\'s kinds', () => {
  assert.deepEqual(readLineBills({ bills: [
    { kind: 'new', name: 'INV-1', creditDays: 45, amount: '10.00' }, { type: 'against', ref: 'INV-1', amount: '4.00' },
    { type: 'advance', ref: 'ADV-1', amount: '3.00', creditDays: null }, { kind: 'on_account', amount: '1.00' }] }),
  { found: [
    { method: 'new_ref', name: 'INV-1', creditDays: 45, amount: '10.00' }, { method: 'against_ref', name: 'INV-1', amount: '4.00' },
    { method: 'advance', name: 'ADV-1', amount: '3.00' }, { method: 'on_account', amount: '1.00' }], problems: [] });
  assert.deepEqual(readLineBills(undefined), { found: [], problems: [] });
  const bad = readLineBills({ bills: [
    { kind: 'paid', name: 'X', amount: '1.00' }, { kind: 'against', amount: '1.00' }, { kind: 'on_account', name: 'X', amount: '1.00' },
    { kind: 'new', name: 'N', amount: '1,00' }, { kind: 'against', name: 'N', amount: '1.00', creditDays: 30 }, { kind: 'new', name: 'N', amount: '1.00', creditDays: 1.5 }, 'row'] });
  assert.deepEqual(bad.found, []);
  assert.deepEqual(bad.problems.map(text => text.replace(/^extras\.bills\[(\d)\]: /, '$1: ')), [
    '0: kind (or type) must be one of new, against, advance, on_account', '1: an against row must name the bill it settles', '2: an on_account row names no bill',
    '3: amount must be a plain decimal string', '4: creditDays applies to a new reference or an advance only', '5: creditDays must be a whole number of days from 0 to 3650', '6: must be an object']);
});

test('ledger bill settings and opening bills are read in both spellings', () => {
  assert.deepEqual(readLedgerBills({ billWise: true, creditDays: 30, opening: { bills: [{ kind: 'new', name: 'OB-1', billDate: '2025-12-16', creditDays: 30, amount: '3.00', side: 'Dr' }] } }).found,
    { billWise: true, creditDays: 30, openingBills: [{ name: 'OB-1', billDate: '2025-12-16', creditDays: 30, amount: '3.00', side: 'Dr' }] });
  assert.deepEqual(readLedgerBills({ billWise: false, creditPeriodDays: 15, openingBills: [{ ref: 'OB-9', date: '2025-12-01', amount: '2.00', side: 'Cr' }] }).found,
    { billWise: false, creditDays: 15, openingBills: [{ name: 'OB-9', billDate: '2025-12-01', amount: '2.00', side: 'Cr' }] });
  assert.deepEqual(readLedgerBills({ address: ['x'] }), { found: { openingBills: [] }, problems: [] });
  const bad = readLedgerBills({ billWise: 'yes', creditDays: -1, openingBills: [{ kind: 'against', name: 'x', amount: '1.00' }, { amount: '1.00' }, { name: 'a', date: '2025-02-30', amount: '1.00' }, { name: 'b', amount: '1.00', side: 'Debit' }] });
  assert.deepEqual(bad.problems, [
    'extras.billWise must be true or false', 'extras.creditDays must be a whole number of days from 0 to 3650',
    'opening bill 1: an opening bill is a new reference (kind "new")', 'opening bill 2: name (or ref) is required',
    'opening bill 3: billDate (or date) must be a real date written YYYY-MM-DD', 'opening bill 4: side must be Dr or Cr']);
});

test('a due date written like 21-Oct-26 becomes a real date; anything else is refused', () => {
  assert.equal(parseDueDate('21-Oct-26'), '2026-10-21');
  assert.equal(parseDueDate('8-feb-26'), '2026-02-08');
  for (const text of ['30-Feb-26', '21-Foo-26', '2026-10-21', '21-Oct-2026', '']) assert.equal(parseDueDate(text), undefined, text);
});

/** A ledger with opening bills for validation. */
const withBills = () => {
  const raw = good();
  raw.ledgers[2].extras = { billWise: true, creditDays: 30, opening: { bills: [{ kind: 'new', name: 'OB-1', billDate: '2025-12-16', amount: '10.00', side: 'Dr' }] } };
  raw.ledgers[2].opening = { amount: '10.00', side: 'Dr' };
  return raw;
};

test('bill settings are validated against the ledger and the line: sides, totals, dates and amounts', () => {
  assert.deepEqual(problems(withBills()), []);
  const bad = withBills();
  bad.ledgers[2].extras = { opening: { bills: [
    { kind: 'new', name: 'A', billDate: '2025-12-16', amount: '6.00', side: 'Cr' }, { kind: 'new', name: 'B', billDate: '2026-02-01', amount: '6.005' }, { kind: 'new', name: 'C', amount: '6.00' }] } };
  const found = problems(bad);
  mentions(found, 'ledgers.json', 'opening bill "A" is on Cr but the opening balance is Dr');
  mentions(found, 'ledgers.json', 'opening bill "B": amount "6.005" must be a plain decimal with at most 2 decimal places');
  mentions(found, 'ledgers.json', 'the opening bills add up to 1200 but the opening balance is 1000');
  const noOpening = good();
  noOpening.ledgers[2].extras = { openingBills: [{ ref: 'OB', date: '2025-12-01', amount: '1.00' }] };
  mentions(problems(noOpening), 'ledgers.json', 'has opening bills but no opening balance');
  const late = withBills();
  late.ledgers[2].extras = { openingBills: [{ ref: 'OB', date: '2026-01-02', amount: '1.00' }] };
  mentions(problems(late), 'ledgers.json', 'opening bill "OB" is dated 2026-01-02, after the books begin');
  const rows = good();
  rows.vouchers[0].lines[0].extras = { bills: [{ kind: 'new', name: 'A', amount: '30.00' }, { kind: 'new', name: 'B', amount: '20.00' }] };
  mentions(problems(rows), 'vouchers.json', '"pay-1"', 'lines[0]', 'the bill rows add up to 5000 but the line is 4000');
  rows.vouchers[0].lines[0].extras = { bills: [{ kind: 'sideways', amount: '1.00' }] };
  mentions(problems(rows), 'vouchers.json', '"pay-1"', 'lines[0]', 'extras.bills[0]: kind (or type) must be one of');
});

test('expected pending bills are checked: ledger keys, amounts, sides and due dates', () => {
  const raw = good();
  raw.expected.outstanding = { asOf: '2026-12-31', ledgers: { ghost: { bills: { bills: { 'INV-1': { pending: '1.005', side: 'Dr', dueDate: '21-Oct-26' } } } } } };
  raw.expected.receivables = { pendingBills: 1, pendingTotal: '2.005' };
  const found = problems(raw);
  mentions(found, 'expected.json', 'outstanding.ledgers "ghost"', 'not a ledger key');
  mentions(found, 'expected.json', 'outstanding.ledgers "ghost", bill "INV-1"', '"1.005"');
  mentions(found, 'expected.json', 'receivables.pendingTotal', '"2.005"');
  const badDate = good();
  badDate.expected.outstanding = { asOf: '2026-12-31', ledgers: { bank: { bills: { bills: { 'INV-1': { pending: '1.00', side: 'Dr', dueDate: '31-Nov-26' } } } } } };
  mentions(problems(badDate), 'expected.json', 'must be a day written like 21-Oct-26');
  const dated = good();
  dated.extraFiles = { 'checkpoints.json': { dates: { '2026-02-28': { outstanding: { ghost: { bills: { 'C-1': { pending: '1.001', side: 'Cr', dueDate: '1-Mar-26' } } } } } } } };
  mentions(problems(dated), 'checkpoints.json', 'dates "2026-02-28" outstanding "ghost"', 'not a ledger key');
});

/** The plan the seeder and the comparison share: which rows are sent and which are left out, in entry order. */
test('the bill plan sends rows in the ledger module\'s kinds and leaves out foreign-currency rows and settlements of bills nothing live creates', () => {
  const raw = good();
  const usd = { currency: 'USD', currencyAmount: '1.00', rate: '3.67' };
  const [debtor, other] = [raw.ledgers[2].key, raw.ledgers[0].key];
  raw.ledgers[2].extras = { billWise: true, opening: { bills: [{ kind: 'new', name: 'OB-1', billDate: '2025-12-16', amount: '10.00', side: 'Dr' }] } };
  raw.ledgers[2].opening = { amount: '10.00', side: 'Dr' };
  const voucher = (key: string, status: string, date: string, rows: unknown[], extras?: object) => ({ key, type: 'payment', date, status, postDated: false, lines: [
    { ledger: debtor, side: 'Cr', amount: '1.00', extras: { bills: rows, ...extras } }, { ledger: other, side: 'Dr', amount: '1.00' }] });
  raw.vouchers = [
    voucher('v-new', 'regular', '2026-02-01', [{ kind: 'new', name: 'INV-1', creditDays: 15, amount: '1.00' }]),
    voucher('v-settle-opening', 'regular', '2026-02-02', [{ kind: 'against', name: 'ob-1', amount: '1.00' }]),
    voucher('v-foreign', 'regular', '2026-02-03', [{ kind: 'new', name: 'USD-1', amount: '1.00' }], usd),
    voucher('v-settle-foreign', 'regular', '2026-02-04', [{ kind: 'against', name: 'USD-1', amount: '1.00' }]),
    voucher('v-draft', 'optional', '2026-02-05', [{ kind: 'new', name: 'DRAFT-1', amount: '1.00' }]),
    voucher('v-settle-draft', 'regular', '2026-02-06', [{ kind: 'against', name: 'DRAFT-1', amount: '1.00' }]),
    voucher('v-ghost', 'regular', '2026-02-07', [{ kind: 'against', name: 'GHOST', amount: '0.50' }, { kind: 'on_account', amount: '0.50' }]),
  ];
  const plan = planBills(parseDataset(raw, 'demo/sample-shop'));
  assert.equal(plan.sent, 4);
  assert.deepEqual([...plan.lines].map(([key, perLine]) => [key, perLine[0]]), [
    ['v-new', [{ kind: 'new_ref', name: 'INV-1', creditPeriod: { count: 15, unit: 'day' }, amount: '1.00' }]],
    ['v-settle-opening', [{ kind: 'against_ref', name: 'ob-1', amount: '1.00' }]],
    ['v-foreign', undefined], ['v-settle-foreign', undefined],
    ['v-draft', [{ kind: 'new_ref', name: 'DRAFT-1', amount: '1.00' }]], ['v-settle-draft', undefined],
    ['v-ghost', [{ kind: 'on_account', amount: '0.50' }]],
  ]);
  assert.deepEqual(plan.skipped.map(row => [row.voucher, row.name, row.reason]), [
    ['v-foreign', 'USD-1', 'foreign'], ['v-settle-foreign', 'USD-1', 'unknown'], ['v-settle-draft', 'DRAFT-1', 'unknown'], ['v-ghost', 'GHOST', 'unknown']]);
  assert.deepEqual([...plan.affected.get(debtor)!], [['usd1', 'foreign'], ['draft1', 'unknown'], ['ghost', 'unknown']]);
  assert.deepEqual([...plan.created.get(debtor)!].sort(), ['draft1', 'inv1', 'ob1'], 'bills are keyed by the name match key');
  assert.deepEqual([...plan.foreignLedgers], [debtor]);
});

/** Master names are compared under the product's name match key, so two spellings of one name are one name. */
test('two master names equal under the name match key are refused at validation, naming both spellings', () => {
  const groups = good();
  groups.groups.push({ key: 'promo-costs-2', name: 'promotion-costs', under: 'indirect_expenses' });
  mentions(problems(groups), 'groups.json', 'group name "promotion-costs"', 'the same name as "Promotion Costs" under the name match key');
  const ledgers = good();
  ledgers.ledgers.push({ key: 'promo-2', name: 'PROMOTION ', group: 'promotion-costs' }, { key: 'capital-2', name: 'Cap. ital', group: 'capital' });
  const found = problems(ledgers);
  mentions(found, 'ledgers.json', 'ledger name "PROMOTION"', 'the same name as "Promotion"');
  mentions(found, 'ledgers.json', 'ledger name "Cap. ital"', 'the same name as "Capital"');
  const same = good();
  same.ledgers.push({ key: 'promo-3', name: 'Promotion', group: 'promotion-costs' });
  mentions(problems(same), 'ledgers.json', 'ledger name "Promotion"', 'the name is used more than once');
  const cost = good();
  cost.extraFiles = { 'costCategories.json': [{ key: 'a', name: 'Channel' }, { key: 'b', name: 'CHANNEL' }], 'costCentres.json': [{ key: 'x', name: 'North-1', category: 'a' }, { key: 'y', name: 'north 1', category: 'b' }] };
  const costFound = problems(cost);
  mentions(costFound, 'costCategories.json', 'cost category name "CHANNEL"', 'the same name as "Channel"');
  mentions(costFound, 'costCentres.json', 'cost centre name "north 1"', 'the same name as "North-1"');
  assert.deepEqual(problems(good()), []);
});

test('cost keys are read: a line\'s rows, a ledger\'s setting, and the centre tree and figures are checked', () => {
  assert.deepEqual(readLineCosts({ costCentres: [{ centre: 'online', amount: '40.00' }, { centre: 5, amount: '1.00' }, 'row'] }), [{ centre: 'online', amount: '40.00' }]);
  assert.deepEqual(readLineCosts(undefined), []);
  assert.deepEqual([readLedgerCostSetting({ costCentres: true }), readLedgerCostSetting({ costCentres: false }), readLedgerCostSetting({}), readLedgerCostSetting({ costCentres: 'yes' })], [true, false, undefined, undefined]);
  const raw = good();
  raw.ledgers[2].extras = { costCentres: 'yes' };
  mentions(problems(raw), 'ledgers.json', '"promotion"', 'extras.costCentres must be true or false');
  const tree = good();
  const files = costing();
  const centres = files['costCentres.json'] as { parent?: string }[];
  centres[0].parent = 'ghost';
  centres[1].parent = 'p-south';
  centres[2].parent = 'p-north';
  tree.extraFiles = files;
  const found = problems(tree);
  mentions(found, 'costCentres.json', 'centre "online"', 'parent "ghost" is not a centre key');
  mentions(found, 'costCentres.json', 'the centres form a cycle through "parent"');
  const figures = good();
  figures.extraFiles = { ...costing(), 'checkpoints.json': { dates: { '2026-01-31': { costCentres: { ghost: { debit: '1.00', credit: '0.001' } } } } } };
  figures.expected.costCentres = { from: '2026-01-01', to: '2026-01-31', centres: { online: { debit: '1.005', credit: '0.00' }, nowhere: { debit: '1.00', credit: '0.00' } } };
  const figureFound = problems(figures);
  mentions(figureFound, 'expected.json', 'costCentres.centres "nowhere"', 'not a centre key');
  mentions(figureFound, 'expected.json', 'costCentres.centres "online", debit', '"1.005"');
  mentions(figureFound, 'checkpoints.json', 'dates "2026-01-31" costCentres "ghost"', 'not a centre key');
  mentions(figureFound, 'checkpoints.json', 'costCentres "ghost", credit', '"0.001"');
});

test('a voucher cancelled without lines is a void and takes its number; one with no lines that is not cancelled is still skipped', () => {
  const voucher = (type: string, status: 'regular' | 'cancelled' | 'optional', lines: number) => numbered([type, 'v', '2026-01-01', status, lines]).vouchers[0];
  assert.deepEqual([voucher('journal', 'cancelled', 0), voucher('journal', 'regular', 0), voucher('journal', 'regular', 2), voucher('sales_order', 'cancelled', 0), voucher('journal', 'cancelled', 2)].map(item => dispositionOf(item as never)),
    ['void', 'no-entries', 'post', 'unsupported-type', 'post']);
  const dataset = numbered(['journal', 'j1', '2026-01-01', 'regular', 2, 1], ['journal', 'j2', '2026-01-02', 'cancelled', 0, 2], ['journal', 'j3', '2026-01-03', 'regular', 2, 3]);
  const check = checkNumbers(dataset as never, new Map([['j1', 1], ['j2', 2], ['j3', 3]]));
  assert.deepEqual([check.checked, check.matched, check.differences], [3, 3, []], 'the void holds number 2, so j3 is number 3 and nothing is shifted');
});
