import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountGroup } from '../src/lib/ledger.ts';
import { quantityText, rateText, stockItemCreateInput, stockOpeningInput, stockUnitCreateInput } from '../src/lib/stock.ts';
import type { LedgerRow } from '../src/server/ledger/reports.ts';
import { rollUp, statementTree } from '../src/server/reports/tree.ts';

/** Stock masters' pure checks (M2b slice a): the wire schemas and the stock line of the statement tree. */

const location = '01890000-0000-7000-8000-000000000001';

test('an opening row takes a quantity and exactly one of a rate or a value; quantities and rates are plain decimals', () => {
  assert.equal(stockOpeningInput.safeParse({ locationId: location, quantity: '4000', rate: '4.20' }).success, true);
  assert.equal(stockOpeningInput.safeParse({ locationId: location, quantity: '3', value: '100.00' }).success, true);
  assert.equal(stockOpeningInput.safeParse({ locationId: location, quantity: '3', value: '0' }).success, true, 'zero cost');
  assert.equal(stockOpeningInput.safeParse({ locationId: location, quantity: '3', rate: '1', value: '3' }).success, false, 'both');
  assert.equal(stockOpeningInput.safeParse({ locationId: location, quantity: '3' }).success, false, 'neither');
  for (const quantity of ['1.2345', '0', '16'.padEnd(16, '9')]) assert.equal(quantityText.safeParse(quantity).success, true, quantity);
  for (const quantity of ['1.23456', '-1', '1e3', '1,000', ' 1', '.5']) assert.equal(quantityText.safeParse(quantity).success, false, quantity);
  for (const rate of ['4.20', '33.333333']) assert.equal(rateText.safeParse(rate).success, true, rate);
  assert.equal(rateText.safeParse('1.1234567').success, false, 'seven places');
  assert.equal(stockUnitCreateInput.safeParse({ symbol: 'Nos', decimals: 5 }).success, false, 'five unit places');
  assert.deepEqual(stockItemCreateInput.parse({ name: ' Rod ', unitId: location.toUpperCase() }), { name: 'Rod', secondLanguageName: null, groupId: null, categoryId: null, unitId: location, standardSellingRate: null });
});

const group = (id: string, parentId: string | null, name: string, systemKey: string | null = null): AccountGroup =>
  ({ id, parentId, name, nature: 'asset', grossProfit: false, systemKey, secondLanguageName: null, revision: 1 });
const ledger = (ledgerId: string, groupId: string, name: string, opening: bigint): LedgerRow => ({
  ledgerId, groupId, name, systemKey: null, primaryGroupId: null, primaryGroupName: null, nature: 'asset', grossProfit: false, enteredOpening: opening,
  openingDebit: opening, openingCredit: 0n, debit: 0n, credit: 0n, closingDebit: opening, closingCredit: 0n,
});

test('the stock line stands first inside the seeded current assets group, counts in its sums and has no ledger value', () => {
  const groups = [group('ca', null, 'Current Assets', 'current_assets'), group('cash', 'ca', 'Cash on Hand'), group('fa', null, 'Fixed Assets')];
  const rows = [ledger('till', 'cash', 'Till', 500n), ledger('van', 'fa', 'Van', 900n)];
  const nodes = statementTree(groups, rows, { name: 'Opening stock', value: 370n });
  assert.deepEqual(nodes.map(node => `${'  '.repeat(node.depth)}${node.kind}:${node.name}`),
    ['group:Current Assets', '  stock:Opening stock', '  group:Cash on Hand', '    ledger:Till', 'group:Fixed Assets', '  ledger:Van']);
  const stock = nodes.find(node => node.kind === 'stock')!;
  assert.deepEqual([stock.openingDebit, stock.closingDebit, stock.opening, stock.closing, stock.parentKey], [370n, 370n, 370n, 370n, 'g:ca']);
  assert.deepEqual([nodes[0].opening, nodes[0].closing], [870n, 870n]);
  assert.equal(rollUp(nodes, node => node.closing).get('g:ca'), 870n, 'rolled up like a ledger');
  assert.equal(statementTree(groups, rows).some(node => node.kind === 'stock'), false, 'no stock, no line');
  assert.equal(statementTree([group('fa', null, 'Fixed Assets')], [], { name: 'Opening stock', value: 1n }).length, 1, 'only the seeded current assets group holds it');
});
