import { addMoney, subtractMoney } from '@ten98/runtime';
import type { AccountGroup, Nature } from '../../lib/ledger.ts';
import { amountKeys, type NodeAmounts, type StatementNode } from '../../lib/reports.ts';
import type { LedgerRow } from '../ledger/reports.ts';

/**
 * The group hierarchy of a statement, built from the read model's ledger rows and the group list (two queries, no
 * per-row queries). Every group carries the sums of every ledger below it, so each level adds up to its parent by
 * construction, which is what makes drill-down totals agree.
 */

const natureOrder: Record<Nature, number> = { liability: 0, asset: 1, income: 2, expense: 3 };
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

export const zeroAmounts = (): NodeAmounts => ({ openingDebit: 0n, openingCredit: 0n, debit: 0n, credit: 0n, closingDebit: 0n, closingCredit: 0n });

/** Adds `amounts` into `target` in place. */
export function addAmounts(target: NodeAmounts, amounts: NodeAmounts): void {
  for (const key of amountKeys) target[key] = addMoney(target[key], amounts[key]);
}

/** Totals of `nodes` (which must not contain each other), with signed opening and closing balances. */
export function totalOf(nodes: readonly NodeAmounts[]): NodeAmounts & { opening: bigint; closing: bigint } {
  const totals = zeroAmounts();
  for (const node of nodes) addAmounts(totals, node);
  return withBalances(totals);
}

export const withBalances = <T extends NodeAmounts>(amounts: T): T & { opening: bigint; closing: bigint } => ({
  ...amounts,
  opening: subtractMoney(amounts.openingDebit, amounts.openingCredit),
  closing: subtractMoney(amounts.closingDebit, amounts.closingCredit),
});

/**
 * The hierarchy in pre-order: primary groups by nature (liabilities, assets, income, expenses) and name, each followed
 * by its sub-groups and then its ledgers, by name; ledgers outside every group come last at depth 0.
 */
export function statementTree(groups: readonly AccountGroup[], ledgers: readonly LedgerRow[]): StatementNode[] {
  const subGroups = new Map<string | null, AccountGroup[]>();
  for (const group of groups) subGroups.set(group.parentId, [...subGroups.get(group.parentId) ?? [], group]);
  const groupLedgers = new Map<string | null, LedgerRow[]>();
  for (const ledger of ledgers) groupLedgers.set(ledger.groupId, [...groupLedgers.get(ledger.groupId) ?? [], ledger]);
  const nodes: StatementNode[] = [];

  const addLedger = (ledger: LedgerRow, depth: number, parentKey: string | null): StatementNode => {
    const node: StatementNode = {
      key: `l:${ledger.ledgerId}`, kind: 'ledger', id: ledger.ledgerId, name: ledger.name, parentKey, depth,
      nature: ledger.nature, grossProfit: ledger.grossProfit, systemKey: ledger.systemKey, ...zeroAmounts(), opening: 0n, closing: 0n,
    };
    addAmounts(node, ledger);
    nodes.push(node);
    return node;
  };
  const addGroup = (group: AccountGroup, depth: number, parentKey: string | null): StatementNode => {
    const node: StatementNode = {
      key: `g:${group.id}`, kind: 'group', id: group.id, name: group.name, parentKey, depth,
      nature: group.nature, grossProfit: group.grossProfit, systemKey: group.systemKey, ...zeroAmounts(), opening: 0n, closing: 0n,
    };
    nodes.push(node);
    for (const child of [...subGroups.get(group.id) ?? []].sort(byName)) addAmounts(node, addGroup(child, depth + 1, node.key));
    for (const ledger of [...groupLedgers.get(group.id) ?? []].sort(byName)) addAmounts(node, addLedger(ledger, depth + 1, node.key));
    return node;
  };

  const primaries = [...subGroups.get(null) ?? []].sort((a, b) => natureOrder[a.nature] - natureOrder[b.nature] || byName(a, b));
  for (const group of primaries) addGroup(group, 0, null);
  for (const ledger of [...groupLedgers.get(null) ?? []].sort(byName)) addLedger(ledger, 0, null);
  for (const node of nodes) Object.assign(node, withBalances(node));
  return nodes;
}

/** A node followed by all its descendants: the contiguous pre-order run starting at `index`. */
export function subtree(nodes: readonly StatementNode[], index: number): StatementNode[] {
  const depth = nodes[index].depth;
  let end = index + 1;
  while (end < nodes.length && nodes[end].depth > depth) end++;
  return nodes.slice(index, end);
}

/** Sums a per-ledger value up the hierarchy: the value of every node, keyed by node key. */
export function rollUp(nodes: readonly StatementNode[], ledgerValue: (node: StatementNode) => bigint): Map<string, bigint> {
  const values = new Map<string, bigint>();
  for (const node of [...nodes].reverse()) {
    const own = node.kind === 'ledger' ? ledgerValue(node) : values.get(node.key) ?? 0n;
    values.set(node.key, own);
    if (node.parentKey) values.set(node.parentKey, addMoney(values.get(node.parentKey) ?? 0n, own));
  }
  return values;
}
