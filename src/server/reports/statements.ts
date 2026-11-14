import { addMoney, subtractMoney } from '@ten98/runtime';
import { financialYearOf } from '../../lib/company.ts';
import type { Nature } from '../../lib/ledger.ts';
import {
  balanceSheetQuery, reportPeriodQuery, type BalanceSheetReport, type GroupSummaryReport, type NodeAmounts,
  type ProfitAndLossReport, type StatementLine, type StatementNode, type TrialBalanceReport,
} from '../../lib/reports.ts';
import { FoundationError } from '../auth.ts';
import { parseInput, type LedgerContext } from '../ledger/context.ts';
import { listGroups } from '../ledger/masters.ts';
import { ledgerRows, reportBudget, type LedgerRow } from '../ledger/reports.ts';
import { addAmounts, rollUp, statementTree, subtree, totalOf, zeroAmounts } from './tree.ts';

/**
 * Trial balance, profit and loss, balance sheet and group summary. Each reads the read model's ledger rows and the group
 * list once and derives its lines from that one hierarchy, so a statement line, its group summary and the group's
 * ledgers always agree. Statements get a 30-second budget of their own (D-02).
 */

const budgetSeconds = 30;
const periodFields = (path: readonly PropertyKey[]) => ({ from: 'the start date', to: 'the end date', date: 'the date' } as Record<string, string>)[String(path[0])] ?? 'the period';

export const parsePeriod = (query: unknown) => parseInput(reportPeriodQuery, query, periodFields);

async function hierarchy(context: LedgerContext, from: string, to: string) {
  await reportBudget(context, budgetSeconds);
  const read = await ledgerRows(context, from, to);
  const nodes = statementTree(await listGroups(context), read.rows);
  return { ...read, nodes, ledgers: new Map(read.rows.map(row => [row.ledgerId, row])) };
}

const primaryTotals = (nodes: readonly StatementNode[]) => totalOf(nodes.filter(node => node.depth === 0));

export async function trialBalanceReport(context: LedgerContext, query: unknown): Promise<TrialBalanceReport> {
  const period = parsePeriod(query);
  const { from, to, nodes, openingDifference } = await hierarchy(context, period.from, period.to);
  const { opening: _opening, closing: _closing, ...totals } = primaryTotals(nodes);
  // The difference line stands on the short side in both balance columns, so the grand totals agree (D-10).
  let difference: NodeAmounts | null = null;
  if (openingDifference.side) {
    difference = zeroAmounts();
    if (openingDifference.side === 'Dr') { difference.openingCredit = openingDifference.amount; difference.closingCredit = openingDifference.amount; }
    else { difference.openingDebit = openingDifference.amount; difference.closingDebit = openingDifference.amount; }
  }
  const grandTotals = { ...totals };
  if (difference) addAmounts(grandTotals, difference);
  return { from, to, nodes, totals, openingDifference, difference, grandTotals };
}

const targetOf = (node: StatementNode): StatementLine['target'] => node.kind === 'group'
  ? { report: 'group-summary', groupId: node.id } : { report: 'ledger-monthly', ledgerId: node.id };

/** Lines for `primaries` and everything below them, each amount from `value` with its sign set for the section. */
function sectionLines(nodes: readonly StatementNode[], primaries: readonly StatementNode[], value: Map<string, bigint>, credit: boolean): { lines: StatementLine[]; total: bigint } {
  const lines: StatementLine[] = [];
  let total = 0n;
  for (const primary of primaries) {
    for (const node of subtree(nodes, nodes.indexOf(primary))) {
      const signed = value.get(node.key) ?? 0n;
      const amount = credit ? subtractMoney(0n, signed) : signed;
      if (node === primary) total = addMoney(total, amount);
      lines.push({ key: node.key, kind: node.kind, label: node.name, depth: node.depth, amount, target: targetOf(node) });
    }
  }
  return { lines, total };
}

const heading = (key: string, label: string): StatementLine => ({ key, kind: 'heading', label, depth: null, amount: null, target: null });
const subtotal = (key: string, label: string, amount: bigint): StatementLine => ({ key, kind: 'subtotal', label, depth: null, amount, target: null });
const primariesOf = (nodes: readonly StatementNode[], nature: Nature, grossProfit?: boolean) =>
  nodes.filter(node => node.depth === 0 && node.kind === 'group' && node.nature === nature && (grossProfit === undefined || node.grossProfit === grossProfit));

/**
 * Profit and loss for a period inside one financial year: the trading section (groups that count towards gross profit)
 * gives gross profit or loss, then the other income and expenses give the net result. A ledger's figure is its
 * movement in the period, plus its opening balance when the books begin inside the period (that opening belongs to
 * this year's result). Stock is not valued in M1, so there is no opening or closing stock line.
 */
export async function profitAndLossReport(context: LedgerContext, query: unknown): Promise<ProfitAndLossReport> {
  const period = parsePeriod(query);
  if (financialYearOf(context.company.financialYearStart, period.from).to < period.to) {
    throw new FoundationError(400, 'A profit and loss statement covers one financial year at most. Choose an end date in the same financial year.');
  }
  const { from, to, nodes, ledgers } = await hierarchy(context, period.from, period.to);
  const booksBeginInPeriod = from <= context.company.booksBeginning && context.company.booksBeginning <= to;
  const movement = (row: LedgerRow) => addMoney(subtractMoney(row.debit, row.credit), booksBeginInPeriod ? row.enteredOpening : 0n);
  const value = rollUp(nodes, node => node.nature === 'income' || node.nature === 'expense' ? movement(ledgers.get(node.id)!) : 0n);

  const tradingIncome = sectionLines(nodes, primariesOf(nodes, 'income', true), value, true);
  const tradingCosts = sectionLines(nodes, primariesOf(nodes, 'expense', true), value, false);
  const otherIncome = sectionLines(nodes, primariesOf(nodes, 'income', false), value, true);
  const otherCosts = sectionLines(nodes, primariesOf(nodes, 'expense', false), value, false);
  const grossProfit = subtractMoney(tradingIncome.total, tradingCosts.total);
  const netProfit = addMoney(grossProfit, subtractMoney(otherIncome.total, otherCosts.total));
  const result = (key: string, profit: string, loss: string, amount: bigint): StatementLine =>
    ({ key, kind: 'result', label: amount < 0n ? loss : profit, depth: null, amount: amount < 0n ? subtractMoney(0n, amount) : amount, target: null });

  const lines: StatementLine[] = [
    heading('h:trading-income', 'Trading income'), ...tradingIncome.lines, subtotal('t:trading-income', 'Total trading income', tradingIncome.total),
    heading('h:trading-costs', 'Cost of sales'), ...tradingCosts.lines, subtotal('t:trading-costs', 'Total cost of sales', tradingCosts.total),
    result('r:gross', 'Gross profit', 'Gross loss', grossProfit),
    heading('h:other-income', 'Other income'), ...otherIncome.lines, subtotal('t:other-income', 'Total other income', otherIncome.total),
    heading('h:other-costs', 'Other expenses'), ...otherCosts.lines, subtotal('t:other-costs', 'Total other expenses', otherCosts.total),
    result('r:net', 'Net profit', 'Net loss', netProfit),
  ];
  return { from, to, lines, grossProfit, netProfit };
}

/**
 * The balance sheet as at a date: liabilities and assets by group, closing balances from the start of that date's
 * financial year. The profit and loss account carries what earlier years closed into the profit and loss ledger
 * (brought forward) and this year's result to date (current period): a profit stands with the liabilities, a loss with
 * the assets. Opening balances entered out of balance show as a difference line on the short side, so both sides agree.
 */
export async function balanceSheetReport(context: LedgerContext, query: unknown): Promise<BalanceSheetReport> {
  const { date } = parseInput(balanceSheetQuery, query, periodFields);
  const yearStart = financialYearOf(context.company.financialYearStart, date).from;
  const { nodes, ledgers, openingDifference } = await hierarchy(context, yearStart, date);
  const value = rollUp(nodes, node => {
    const row = ledgers.get(node.id)!;
    return subtractMoney(row.closingDebit, row.closingCredit);
  });
  const liabilities = sectionLines(nodes, primariesOf(nodes, 'liability'), value, true);
  const assets = sectionLines(nodes, primariesOf(nodes, 'asset'), value, false);

  const profitLedger = [...ledgers.values()].find(row => row.systemKey === 'profit_and_loss');
  const broughtForward = profitLedger ? subtractMoney(profitLedger.closingCredit, profitLedger.closingDebit) : 0n;
  let currentPeriod = 0n;
  for (const row of ledgers.values()) if (row.nature === 'income' || row.nature === 'expense') currentPeriod = addMoney(currentPeriod, subtractMoney(row.closingCredit, row.closingDebit));
  const retained = addMoney(broughtForward, currentPeriod);
  const loss = retained < 0n;
  const shown = (amount: bigint) => loss ? subtractMoney(0n, amount) : amount;
  const profitLines: StatementLine[] = [
    { key: 'p:account', kind: 'profit-and-loss', label: loss ? 'Profit and loss account (loss)' : 'Profit and loss account', depth: 0, amount: shown(retained), target: { report: 'profit-and-loss' } },
    { key: 'p:brought-forward', kind: 'ledger', label: 'Brought forward', depth: 1, amount: shown(broughtForward), target: profitLedger ? { report: 'ledger-monthly', ledgerId: profitLedger.ledgerId } : null },
    { key: 'p:current', kind: 'profit-and-loss', label: 'Current period', depth: 1, amount: shown(currentPeriod), target: { report: 'profit-and-loss' } },
  ];
  const difference: StatementLine[] = openingDifference.side
    ? [{ key: 'd:opening', kind: 'difference', label: 'Difference in opening balances', depth: 0, amount: openingDifference.amount, target: null }] : [];
  const liabilityTotal = addMoney(addMoney(liabilities.total, loss ? 0n : retained), openingDifference.side === 'Dr' ? openingDifference.amount : 0n);
  const assetTotal = addMoney(addMoney(assets.total, loss ? subtractMoney(0n, retained) : 0n), openingDifference.side === 'Cr' ? openingDifference.amount : 0n);

  const lines: StatementLine[] = [
    heading('h:liabilities', 'Capital and liabilities'), ...liabilities.lines, ...loss ? [] : profitLines, ...openingDifference.side === 'Dr' ? difference : [],
    subtotal('t:liabilities', 'Total capital and liabilities', liabilityTotal),
    heading('h:assets', 'Assets'), ...assets.lines, ...loss ? profitLines : [], ...openingDifference.side === 'Cr' ? difference : [],
    subtotal('t:assets', 'Total assets', assetTotal),
  ];
  return { date, from: yearStart, lines, totals: { liabilities: liabilityTotal, assets: assetTotal }, profitAndLoss: { broughtForward, currentPeriod }, openingDifference };
}

/** One group's sub-groups and ledgers for the period, or with no group the primary groups and ungrouped ledgers. */
export async function groupSummaryReport(context: LedgerContext, groupId: string | null, query: unknown): Promise<GroupSummaryReport> {
  const period = parsePeriod(query);
  const { from, to, nodes } = await hierarchy(context, period.from, period.to);
  if (groupId === null) return { from, to, group: null, rows: nodes.filter(node => node.depth === 0), totals: primaryTotals(nodes) };
  const node = nodes.find(item => item.key === `g:${groupId}`);
  if (!node) throw new FoundationError(404, 'Group not found.');
  const parent = node.parentKey ? nodes.find(item => item.key === node.parentKey)! : null;
  const { key: _key, kind: _kind, id, name, parentKey: _parentKey, depth: _depth, nature, grossProfit: _gp, systemKey: _systemKey, ...totals } = node;
  return {
    from, to, group: { id, name, parentId: parent?.id ?? null, nature: nature! },
    rows: nodes.filter(item => item.parentKey === node.key), totals,
  };
}
