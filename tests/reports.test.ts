import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountGroup } from '../src/lib/ledger.ts';
import { defaultPeriod, formatAmount, formatBalance, isZeroNode, periodDays, periodText, popCursor, pushCursor, recordPeriod, rememberedPeriod, reportPageQuery, reportPeriodQuery, splitBalance } from '../src/lib/reports.ts';
import type { LedgerRow } from '../src/server/ledger/reports.ts';
import { rollUp, statementTree, subtree } from '../src/server/reports/tree.ts';

test('amounts read with grouping and exactly the currency decimal places, never through a float', () => {
  assert.equal(formatAmount('53625.00', 2), '53,625.00');
  assert.equal(formatAmount('1487.781', 3), '1,487.781');
  assert.equal(formatAmount('-375.00', 2), '-375.00');
  assert.equal(formatAmount('92233720368547758.07', 2), '92,233,720,368,547,758.07', 'the largest bigint amount stays exact');
  assert.equal(formatBalance('-32000.00', 2), '32,000.00 Cr');
  assert.equal(formatBalance('2100.000', 3), '2,100.000 Dr');
  assert.equal(formatBalance('0.00', 2), '0.00');
  assert.deepEqual(splitBalance(-5n), { amount: 5n, side: 'Cr' });
  assert.deepEqual(splitBalance(0n), { amount: 0n, side: null });
});

test('periods are real dates, in order and at most ten years; the default runs from the financial-year start', () => {
  assert.equal(periodDays('2026-01-01', '2026-12-31'), 365);
  assert.equal(reportPeriodQuery.safeParse({ from: '2026-01-01', to: '2026-02-03' }).success, true);
  for (const bad of [{ from: '2026-02-03', to: '2026-01-01' }, { from: '2026-02-29', to: '2026-03-01' }, { from: '2015-01-01', to: '2026-01-02' }, { from: '2026-01-01', to: '2026-01-02', extra: 'x' }]) {
    assert.equal(reportPeriodQuery.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(reportPageQuery.parse({ from: '2026-01-01', to: '2026-01-31' }).limit, 200);
  assert.deepEqual(defaultPeriod({ month: 4, day: 1 }, '2026-02-03'), { from: '2025-04-01', to: '2026-02-03' });
  assert.equal(periodText({ from: '2026-01-01', to: '2026-02-03' }), '1 January 2026 to 3 February 2026');
});

const group = (id: string, parentId: string | null, name: string, nature: AccountGroup['nature'] = 'asset'): AccountGroup =>
  ({ id, parentId, name, nature, grossProfit: false, systemKey: null, secondLanguageName: null, revision: 1 });
const ledger = (ledgerId: string, groupId: string | null, name: string, closing: bigint): LedgerRow => ({
  ledgerId, groupId, name, systemKey: null, primaryGroupId: null, primaryGroupName: null, nature: 'asset', grossProfit: false, enteredOpening: 0n,
  openingDebit: 0n, openingCredit: 0n, debit: closing > 0n ? closing : 0n, credit: closing < 0n ? -closing : 0n,
  closingDebit: closing > 0n ? closing : 0n, closingCredit: closing < 0n ? -closing : 0n,
});

test('the statement tree is pre-order, sums every ledger into each group above it and keeps debit and credit apart', () => {
  const groups = [group('b', null, 'Liabilities', 'liability'), group('a', null, 'Assets'), group('a1', 'a', 'Bank'), group('a2', 'a', 'Cash')];
  const nodes = statementTree(groups, [ledger('l1', 'a1', 'Main bank', 500n), ledger('l2', 'a1', 'Overdrawn bank', -200n), ledger('l3', 'a2', 'Till', 50n), ledger('l4', 'b', 'Loan', -350n), ledger('pl', null, 'Profit and loss', 0n)]);
  assert.deepEqual(nodes.map(node => `${'  '.repeat(node.depth)}${node.name}`), ['Liabilities', '  Loan', 'Assets', '  Bank', '    Main bank', '    Overdrawn bank', '  Cash', '    Till', 'Profit and loss']);
  const assets = nodes.find(node => node.name === 'Assets')!;
  assert.deepEqual([assets.closingDebit, assets.closingCredit, assets.closing], [550n, 200n, 350n]);
  assert.deepEqual(subtree(nodes, nodes.indexOf(assets)).map(node => node.name), ['Assets', 'Bank', 'Main bank', 'Overdrawn bank', 'Cash', 'Till']);
  const values = rollUp(nodes, node => node.closing);
  assert.equal(values.get('g:a'), 350n);
  assert.equal(values.get('g:a1'), 300n);
  assert.equal(isZeroNode(nodes.at(-1)!), true);
  assert.equal(isZeroNode({ openingDebit: '0.00', openingCredit: '0.00', debit: '0.00', credit: '0.00', closingDebit: '0.000', closingCredit: '1.000' }), false);
});

test('only statement periods are remembered: the day book keeps its day to itself', () => {
  const memory = new Map<string, { from: string; to: string }>();
  recordPeriod(memory, 'c1', 'statement', { from: '2026-01-01', to: '2026-02-03' });
  recordPeriod(memory, 'c1', 'day', { from: '2026-02-03', to: '2026-02-03' });
  recordPeriod(memory, 'c1', 'none', { from: '2026-02-03', to: '2026-02-03' });
  assert.deepEqual(rememberedPeriod(memory, 'c1', 'statement'), { from: '2026-01-01', to: '2026-02-03' }, 'opening the day book does not narrow the trial balance');
  assert.equal(rememberedPeriod(memory, 'c1', 'day'), undefined, 'the day book opens on its own default day');
  assert.equal(rememberedPeriod(memory, 'c2', 'statement'), undefined);
});

test('page cursors: a repeated push of the cursor on top is ignored, so PageUp still returns to the first page', () => {
  let stack: readonly string[] = [];
  // Three quick PageDowns while page 2 loads: the old page's next cursor is pushed each time.
  for (let press = 0; press < 3; press++) stack = pushCursor(stack, 'page-2');
  assert.deepEqual(stack, ['page-2']);
  stack = pushCursor(stack, 'page-3');
  assert.deepEqual(stack, ['page-2', 'page-3']);
  stack = popCursor(popCursor(stack));
  assert.deepEqual(stack, [], 'two PageUps return to the first page');
});
