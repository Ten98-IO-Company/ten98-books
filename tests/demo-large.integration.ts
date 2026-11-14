import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { formatMoney, subtractMoney } from '@ten98/runtime';
import { compareDataset, formatCompareResult } from '../src/server/demo/compare.ts';
import { demoRoot, dispositionOf, loadDataset, toMinor } from '../src/server/demo/dataset.ts';
import { seedDataset } from '../src/server/demo/seed.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { setupOwner, type Member } from './helpers/ledger.ts';

/**
 * The two large companies (319 vouchers each, with orders, stock journals, cancelled entries, a refused journal, opening
 * stock and 30 vouchers after the compared period) seeded as books_app and compared with their expected.json.
 *
 * Findings are asserted, not hidden: expected.json lists 16 party, bank, loan, provision and tax ledgers at 0.00 although
 * the dataset's own vouchers move them, and gives the profit and loss figure excluding stock without its loss sign. If
 * the analyst corrects expected.json these assertions fail on purpose: shrink the list then.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('demo_large');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

for (const slug of ['gulfline', 'najd']) {
  test(`${slug}: seeds its postable vouchers, reports every skip, runs again without change, and its comparable lines agree apart from the findings`, async t => {
    const dataset = await loadDataset(join(demoRoot, slug));
    let started = Date.now();
    const first = await seedDataset(owner.userId, dataset);
    t.diagnostic(`first seed of ${dataset.vouchers.length} vouchers: ${Date.now() - started} ms`);
    assert.equal(first.companyCreated, true);
    assert.deepEqual(first.vouchers, { created: 300, present: 0, cancelled: 0 });
    assert.deepEqual(first.unsupportedTypes, { sales_order: 3, delivery_note: 3, purchase_order: 2, receipt_note: 1, stock_journal: 4, memorandum: 2, reversing_journal: 1 });
    assert.deepEqual(first.noEntries, { journal: 2 }, 'the two cancelled journals without lines');
    assert.equal(first.refused.length, 1);
    assert.match(first.refused[0], /^voucher "journal-001" \(journal, 2026-06-15, optional\): A journal cannot use a cash or bank ledger/);
    assert.deepEqual(first.numbers, { checked: 300, matched: 298, unnumbered: 0, kind: 'dataset sequence (not yet verified against the reference)' });
    assert.equal(first.numberDifferences.length, 2);
    assert.ok(first.numberDifferences.every(line => line.includes('3 earlier journal voucher(s) hold numbers in the dataset but none here, which accounts for the whole difference')));
    assert.ok(first.skipped.some(line => line.startsWith('items.json: stock not yet supported (14 item(s), 3 location(s); opening stock worth 369440.00')));

    started = Date.now();
    const again = await seedDataset(owner.userId, dataset);
    t.diagnostic(`second seed (nothing to do): ${Date.now() - started} ms`);
    assert.deepEqual([again.companyCreated, again.vouchers, again.groups.created, again.ledgers.created], [false, { created: 0, present: 300, cancelled: 0 }, 0, 0]);
    assert.deepEqual(again.numberDifferences, first.numberDifferences);

    const result = await compareDataset(owner.userId, dataset);
    t.diagnostic(`${result.lines.length} lines compared, ${result.differences} differ`);
    const text = formatCompareResult(result).join('\n');
    const findings = result.lines.filter(line => !line.ok);
    const placeholders = findings.filter(line => line.block === 'Trial balance' && line.expected === '0.00');
    assert.equal(placeholders.length, 16, text);
    assert.deepEqual(findings.filter(line => !placeholders.includes(line)).map(line => line.label).sort(),
      ['Net profit (excluding stock)', 'Voucher count (types ten98-books has)', 'Vouchers of type journal'], text);
    const net = result.lines.find(line => line.label === 'Net profit (excluding stock)')!;
    assert.deepEqual([net.expected, net.actual], ['52839.06', '-52839.06'], 'a loss, given without its sign');
    const journals = result.lines.find(line => line.label === 'Vouchers of type journal')!;
    assert.deepEqual([journals.expected, journals.actual], ['3', '2'], 'the refused optional journal');

    // Everything that carries a figure and is not one of those findings agrees exactly, totals and opening stock included.
    const agreeing = result.lines.filter(line => line.ok).map(line => line.label);
    for (const label of ['Total debit', 'Total credit', 'Opening-balance difference (equals the opening stock value)', 'Gross profit (excluding stock)', 'Vouchers of type sales', 'Vouchers of type purchase', 'Vouchers of type payment', 'Vouchers of type receipt']) {
      assert.ok(agreeing.includes(label), label);
    }
    assert.ok(result.lines.filter(line => line.expected !== '0.00' && !findings.includes(line)).length >= 25);
    for (const name of ['stockSummary (needs inventory)', 'receivables (needs bill-wise receivables, which ten98-books does not track yet)']) assert.ok(result.notComparable.includes(name), name);
    assert.equal(result.notComparable.some(line => line.startsWith('vat (')), slug === 'najd');

    // The app's figure for each placeholder ledger is what the dataset's own vouchers add up to: opening balance plus
    // every regular voucher with lines up to the period's end.
    const exponent = dataset.company.minorUnits;
    const totals = new Map<string, bigint>();
    for (const ledger of dataset.ledgers) {
      const opening = ledger.opening ? toMinor(ledger.opening.amount, exponent) : 0n;
      totals.set(ledger.name, ledger.opening?.side === 'Cr' ? subtractMoney(0n, opening) : opening);
    }
    const nameOf = new Map(dataset.ledgers.map(ledger => [ledger.key, ledger.name]));
    for (const voucher of dataset.vouchers) {
      if (voucher.status !== 'regular' || dispositionOf(voucher) !== 'post' || voucher.date > dataset.expected.period.to) continue;
      for (const line of voucher.lines) {
        const name = nameOf.get(line.ledger)!;
        const amount = toMinor(line.amount, exponent);
        totals.set(name, line.side === 'Dr' ? totals.get(name)! + amount : subtractMoney(totals.get(name)!, amount));
      }
    }
    for (const line of placeholders) {
      const name = line.label.replace('Closing balance of ', '');
      const sum = totals.get(name)!;
      const shown = sum === 0n ? formatMoney(0n, exponent) : `${formatMoney(sum < 0n ? subtractMoney(0n, sum) : sum, exponent)} ${sum < 0n ? 'Cr' : 'Dr'}`;
      assert.equal(line.actual, shown, `${name} follows from the dataset's vouchers`);
    }
  });
}
