import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { notComparable } from '../src/server/demo/compare.ts';
import { DatasetError, dispositionOf, duplicateKeys, listDatasetFolders, loadDataset, openingStockValue, parseDataset, demoRoot, toMinor, type ItemsFile, type RawDataset } from '../src/server/demo/dataset.ts';
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
    'receivables (needs bill-wise receivables, which ten98-books does not track yet)',
    'payables (needs bill-wise payables, which ten98-books does not track yet)',
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
