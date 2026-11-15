import type { EntryGridColumn, EntryGridRow } from '@ten98/ui';
import type { MoneyExponent } from '@ten98/runtime/browser';
import type { Side } from '../ledger.ts';
import { parseEntryAmount } from './amounts.ts';
import { firstLineSide, sideOf, type EntryKind, type EntryLayout, type LedgerLists } from './layout.ts';

const sides = [{ value: 'Dr', label: 'Dr', keys: ['B', 'D'] }, { value: 'Cr', label: 'Cr', keys: ['T', 'C'] }] as const;

/**
 * The voucher grid's columns: a side (double entry; fixed by the type on a first line that holds the type's side), a
 * ledger whose lists depend on the line's side, an amount that is required (one that rounds to zero empties the cell and
 * keeps the cursor there, observed: no line) and the resulting balance. Every cell is read-only while the draft is locked.
 */
export function lineColumns(input: { kind: EntryKind; layout: EntryLayout; locked: boolean; firstKey: string | undefined; lists: Readonly<Record<Side | '', LedgerLists>>; exponent: MoneyExponent }): EntryGridColumn[] {
  const { kind, layout, locked, firstKey, lists, exponent } = input;
  const listOf = (row: EntryGridRow) => lists[layout === 'double' ? sideOf(row.values.side) : ''];
  return [
    ...layout === 'double' ? [{ id: 'side', label: 'Dr or Cr', type: 'side' as const, sides, required: true,
      readOnly: (row: EntryGridRow) => locked || (row.key === firstKey && row.values.side === firstLineSide(kind)) }] : [],
    { id: 'ledger', label: 'Ledger', type: 'lookup', readOnly: locked, options: (row: EntryGridRow) => listOf(row).defaults, allOptions: (row: EntryGridRow) => listOf(row).all, showAllLabel: 'Show all ledgers' },
    { id: 'amount', label: 'Amount', type: 'amount', readOnly: locked, required: true, parse: (text: string) => parseEntryAmount(text, exponent) },
    { id: 'balance', label: 'Resulting balance', type: 'text', readOnly: true },
  ];
}
