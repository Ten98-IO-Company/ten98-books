import type { DataColumn } from '@ten98/ui'
import { useMemo } from 'react'
import type { Wire } from '../../lib/money'
import type { StatementLine } from '../../lib/reports'
import { Amount, Particulars } from './cells'
import type { ReportLink } from './navigation'
import { ReportTable } from './ReportTable'

type Line = Wire<StatementLine>
const zero = /^-?0(\.0+)?$/

const columns: DataColumn<Line>[] = [
  { key: 'particulars', header: 'Particulars', rowHeader: true, wrap: true, minWidth: 'md',
    render: line => <Particulars label={line.label} depth={line.depth ?? 0} strong={line.depth === null || line.depth === 0} muted={line.kind === 'heading'} /> },
  { key: 'amount', header: 'Amount', numeric: true, render: line => <Amount value={line.amount} strong={line.kind === 'subtotal' || line.kind === 'result'} /> },
]

/** Where Enter on a statement line leads, or null for headings and totals. */
export function lineLink(line: Line): ReportLink | null {
  const target = line.target
  if (!target) return null
  if (target.report === 'group-summary') return { report: 'group-summary', search: { group: target.groupId } }
  if (target.report === 'ledger-monthly') return { report: 'ledger-monthly', search: { ledger: target.ledgerId } }
  return { report: 'profit-and-loss', search: {} }
}

/**
 * A one-amount statement (profit and loss, balance sheet). Condensed keeps headings, totals and primary-level lines;
 * detailed adds every sub-group and ledger. Group and ledger lines without an amount are hidden unless asked for.
 */
export function StatementTable({ caption, lines, detail, zeros, highlight, onHighlight, onOpen }: {
  caption: string; lines: readonly Line[]; detail: boolean; zeros: boolean
  highlight: string | undefined; onHighlight: (key: string) => void; onOpen: (link: ReportLink) => void
}) {
  const shown = useMemo(() => lines.filter(line => line.depth === null
    || ((detail || line.depth === 0) && (zeros || line.kind === 'heading' || line.amount === null || !zero.test(line.amount)))), [lines, detail, zeros])
  return <ReportTable caption={caption} columns={columns} rows={shown} rowKey={line => line.key} highlight={highlight} onHighlight={onHighlight}
    onOpen={line => { const link = lineLink(line); if (link) onOpen(link) }} canOpen={line => line.target !== null} />
}
