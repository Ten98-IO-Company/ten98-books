import { EntryGrid, useEntryGrid, type EntryCommitEvent, type EntryEndContext, type EntryGridApi, type EntryGridColumn, type EntryGridPanel, type EntryGridRow } from '@ten98/ui'
import { useMemo, type Ref } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { useAppCommand } from '../KeyboardShell'
import {
  amountText, balanceText, kindTitles, lineColumns, sideOf, ledgerOptions, lineTotals, minorOf, particularsTotal,
  type EntryKind, type EntryLayout, type EntryLedger, type EntryLine, type LedgerLists,
} from '../../lib/voucher-entry'
import type { Side } from '../../lib/ledger'

const balanceOf = (ledger: string, balances: ReadonlyMap<string, bigint>, exponent: MoneyExponent): string => { const balance = ledger ? balances.get(ledger) : undefined; return balance === undefined ? '' : balanceText(balance, exponent) }

/** Lines as the grid holds them, with each line's resulting balance as a read-only cell. */
export const toGridRows = (lines: readonly EntryLine[], balances: ReadonlyMap<string, bigint>, exponent: MoneyExponent): EntryGridRow[] =>
  lines.map(line => ({ key: line.key, values: { side: line.side, ledger: line.ledger, amount: line.amount, balance: balanceOf(line.ledger, balances, exponent) } }))
export const fromGridRows = (rows: readonly EntryGridRow[]): EntryLine[] =>
  rows.map(row => ({ key: row.key, side: sideOf(row.values.side), ledger: row.values.ledger ?? '', amount: row.values.amount ?? '' }))


/**
 * The voucher's lines in the design system's entry grid: a side (double entry; the first line's is fixed by the type),
 * a ledger whose list depends on the type, layout and side (`ledgerOptions`), an amount rounded at entry, and the
 * ledger's resulting balance. The screen decides what Enter does at the end of the list (`onEnd`) and what a new line
 * holds (`createRow`); the grid's commands for one line (remove) run inside it.
 */
export function LinesGrid({ kind, layout, number, lines, ledgers, balances, exponent, locked, apiRef, panel, onLines, createRow, onEnd, onCellCommit, announce }: {
  kind: EntryKind; layout: EntryLayout; number: number | null
  lines: readonly EntryLine[]; ledgers: readonly EntryLedger[]; balances: ReadonlyMap<string, bigint>; exponent: MoneyExponent
  /** While a save's outcome is unknown nothing can be edited. */
  locked: boolean
  apiRef: Ref<EntryGridApi>
  panel: EntryGridPanel
  onLines: (lines: EntryLine[]) => void
  createRow: (lines: readonly EntryLine[]) => EntryLine
  onEnd: (context: EntryEndContext) => boolean | string | void
  onCellCommit: (event: EntryCommitEvent) => void
  announce: (message: string) => void
}) {
  // One list per side, so the arrays stay the same between renders (the grid caches labels per array).
  const lists = useMemo(() => {
    const of = (side: Side | ''): LedgerLists => ledgerOptions(kind, layout, 'line', side, ledgers)
    const byside: Record<Side | '', LedgerLists> = { '': of(''), Dr: of('Dr'), Cr: of('Cr') }
    return byside
  }, [kind, layout, ledgers])
  const columns = useMemo<EntryGridColumn[]>(() => lineColumns({ kind, layout, locked, firstKey: lines[0]?.key, lists, exponent }), [kind, layout, locked, lines[0]?.key, lists, exponent])
  const rows = useMemo(() => toGridRows(lines, balances, exponent), [lines, balances, exponent])
  const footer = useMemo(() => {
    if (layout === 'single') return { amount: amountText(particularsTotal(lines, exponent), exponent) }
    const { debit, credit } = lineTotals(lines, exponent)
    return { amount: `Dr ${amountText(debit, exponent)} · Cr ${amountText(credit, exponent)}` }
  }, [layout, lines, exponent])
  return <EntryGrid label={`Lines of ${kindTitles[kind].toLowerCase()}${number === null ? '' : ` ${number}`}`} columns={columns} rows={rows}
    onRowsChange={next => onLines(fromGridRows(next))} createRow={current => { const line = createRow(fromGridRows(current)); return toGridRows([line], balances, exponent)[0] }}
    footer={footer} footerLabel='Total' panel={panel} apiRef={apiRef} onEnd={onEnd} onCellCommit={onCellCommit} announce={announce}
    editKey={null} openListOnAppend escapeMode='clear'
    labels={{ cell: (column, row) => `${column}, line ${row}`, required: 'Enter an amount above zero.' }}>
    <LineCommands locked={locked} />
  </EntryGrid>
}

/** Ctrl+D removes the line with the cursor in its ledger cell, and does nothing in an amount cell (observed). */
function LineCommands({ locked }: { locked: boolean }) {
  const grid = useEntryGrid()
  // From the bar, focus comes back to the cell either way; while the draft is locked it changes nothing.
  useAppCommand('entry.line.remove', () => { if (grid.activeColumn === 'ledger') grid.removeRow(); else if (grid.activeRow) grid.focusCell(grid.activeRow) }, { enabled: !locked })
  return null
}

/** The amount of a line in minor units (zero while empty). */
export const lineAmount = (line: EntryLine | undefined, exponent: MoneyExponent): bigint => line ? minorOf(line.amount, exponent) : 0n
