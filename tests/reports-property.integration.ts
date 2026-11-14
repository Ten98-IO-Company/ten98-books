import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { formatMoney, parseMoney } from '@ten98/runtime';
import { financialYearOf } from '../src/lib/company.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { addLedger, chart, createCompany, post, setupOwner, type Line, type Member } from './helpers/ledger.ts';

/**
 * Property-style check of the trial balance: random balanced journals over two financial years, then for several
 * periods the report balances (both sides of every column pair agree, closing balances sum to zero) and every ledger's
 * figures equal an independent sum over the posted lines computed here. A fixed seed keeps failures reproducible.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };

before(async () => {
  database = await freshDatabase('reports_property');
  owner = await setupOwner();
});
after(async () => { await database?.drop(); });

/** mulberry32: a small deterministic generator, enough to spread dates and amounts. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Posted = { date: string; ledger: string; signed: bigint; side: 'Dr' | 'Cr'; amount: bigint };

test('random balanced vouchers: the trial balance sums to zero and equals an independent sum over the lines', async () => {
  const seed = Number(process.env.REPORTS_PROPERTY_SEED ?? 20261114);
  const next = random(seed);
  const companyId = await createCompany(owner.browser, { name: 'Random Books', booksBeginning: '2025-01-01' });
  const books = await chart(owner.browser, companyId);
  const specs = [
    ['Plant', 'fixed_assets', 'asset', { amount: '5000', side: 'Dr' as const }], ['Debtors One', 'receivables', 'asset', undefined],
    ['Creditors One', 'payables', 'liability', undefined], ['Partner Capital', 'capital', 'liability', { amount: '5000', side: 'Cr' as const }],
    ['Goods Sold', 'sales', 'income', undefined], ['Interest Earned', 'indirect_income', 'income', undefined],
    ['Goods Bought', 'purchases', 'expense', undefined], ['Utilities', 'indirect_expenses', 'expense', undefined],
  ] as const;
  const ledgers: { id: string; nature: string; opening: bigint }[] = [];
  for (const [name, group, nature, opening] of specs) {
    const id = await addLedger(owner.browser, companyId, name, books.group(group), opening);
    ledgers.push({ id, nature, opening: opening ? (opening.side === 'Dr' ? 1n : -1n) * parseMoney(opening.amount, 2) : 0n });
  }
  const profitLedger = (await chart(owner.browser, companyId)).ledger('Profit and Loss');

  const posted: Posted[] = [];
  const start = Date.UTC(2025, 0, 1);
  for (let index = 0; index < 40; index++) {
    const date = new Date(start + Math.floor(next() * 730) * 86_400_000).toISOString().slice(0, 10);
    const picked = [...ledgers].sort(() => next() - 0.5).slice(0, 2 + Math.floor(next() * 3));
    const debits = picked.slice(0, Math.max(1, Math.floor(picked.length / 2)));
    const credits = picked.slice(debits.length);
    const amounts = debits.map(() => BigInt(1 + Math.floor(next() * 500_000)));
    const total = amounts.reduce((sum, amount) => sum + amount, 0n);
    // Split the total over the credit lines so the voucher balances exactly.
    const creditAmounts = credits.map((_, position) => position < credits.length - 1 ? total / BigInt(credits.length) : total - (total / BigInt(credits.length)) * BigInt(credits.length - 1));
    const lines: Line[] = [
      ...debits.map((ledger, position): Line => [ledger.id, 'Dr', formatMoney(amounts[position], 2)]),
      ...credits.map((ledger, position): Line => [ledger.id, 'Cr', formatMoney(creditAmounts[position], 2)]),
    ];
    await post(owner.browser, companyId, books.type('journal'), date, lines);
    for (const [ledger, side, amount] of lines) {
      const minor = parseMoney(amount, 2);
      posted.push({ date, ledger, side, amount: minor, signed: side === 'Dr' ? minor : -minor });
    }
  }

  const periods = [['2025-01-01', '2025-06-30'], ['2025-03-15', '2025-12-31'], ['2026-01-01', '2026-12-31'], ['2025-07-01', '2026-02-28'], ['2025-01-01', '2026-12-31'], ['2026-05-05', '2026-05-05']];
  for (const [from, to] of periods) {
    const response = await owner.browser.call(`/api/companies/${companyId}/reports/trial-balance?from=${from}&to=${to}`);
    assert.equal(response.status, 200);
    const report = response.body.report;
    const money = (text: string) => parseMoney(text, 2);
    const totals = report.grandTotals;
    assert.equal(totals.openingDebit, totals.openingCredit, `${from}..${to} opening`);
    assert.equal(totals.debit, totals.credit, `${from}..${to} movements`);
    assert.equal(totals.closingDebit, totals.closingCredit, `${from}..${to} closing`);
    const nodes = report.nodes.filter((node: any) => node.kind === 'ledger');
    assert.equal(nodes.reduce((sum: bigint, node: any) => sum + money(node.closingDebit) - money(node.closingCredit), 0n), 0n, 'closing balances sum to zero');

    // Independent sums over the posted lines.
    const yearStart = financialYearOf({ month: 1, day: 1 }, from).from;
    const inPeriod = posted.filter(line => line.date >= from && line.date <= to);
    assert.equal(money(totals.debit), inPeriod.filter(line => line.side === 'Dr').reduce((sum, line) => sum + line.amount, 0n));
    let carried = 0n;
    for (const ledger of ledgers) {
      const node = nodes.find((item: any) => item.id === ledger.id);
      const profitOrLoss = ledger.nature === 'income' || ledger.nature === 'expense';
      const counted = posted.filter(line => line.ledger === ledger.id && line.date <= to && (!profitOrLoss || line.date >= yearStart));
      const closing = (profitOrLoss && yearStart > '2025-01-01' ? 0n : ledger.opening) + counted.reduce((sum, line) => sum + line.signed, 0n);
      if (profitOrLoss) carried += posted.filter(line => line.ledger === ledger.id && line.date < yearStart).reduce((sum, line) => sum + line.signed, 0n);
      assert.equal(money(node.closingDebit) - money(node.closingCredit), closing, `${node.name} ${from}..${to}`);
      const moves = inPeriod.filter(line => line.ledger === ledger.id);
      assert.deepEqual([money(node.debit), money(node.credit)], [
        moves.filter(line => line.side === 'Dr').reduce((sum, line) => sum + line.amount, 0n),
        moves.filter(line => line.side === 'Cr').reduce((sum, line) => sum + line.amount, 0n),
      ], `${node.name} movements ${from}..${to}`);
    }
    const profit = nodes.find((item: any) => item.id === profitLedger);
    assert.equal(money(profit.closingDebit) - money(profit.closingCredit), carried, `earlier years carried ${from}..${to}`);
  }
});
