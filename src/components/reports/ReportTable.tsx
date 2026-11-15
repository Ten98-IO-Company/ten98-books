import { DataTable, Stack, type DataColumn, type DataTableApi, type TableCursorPage } from '@ten98/ui'
import { useEffect, useRef, type ReactNode } from 'react'
import { useAppCommand } from '../KeyboardShell'

/** Lines one PageDown or PageUp moves. */
const pageLines = 10

/**
 * A report table with one highlighted line (D-05). The highlight is the table's current row; focus follows it, so the
 * table's own Up, Down, PageUp, PageDown, Home, End and Enter work on the focused row, and the report commands (the
 * same keys) move it when focus is elsewhere on the page. Enter opens the line (`onOpen`); a paged register moves to the
 * next or previous page when a key runs past its edge.
 *
 * Focus on a row lets screen readers read the line moved to; the row header names it.
 * Must be rendered inside the report's ShortcutScope. Each row needs a stable key; the highlight is that key.
 */
export function ReportTable<T>({ caption, columns, rows, rowKey, highlight, onHighlight, onOpen, canOpen, footerCells, page, onPage, pageBusy = false, focusOnLoad = true }: {
  caption: string
  columns: readonly DataColumn<T>[]
  rows: readonly T[]
  rowKey: (row: T) => string
  highlight: string | undefined
  onHighlight: (key: string) => void
  /** Opens the line (drill down); return without effect for lines that lead nowhere. */
  onOpen: (row: T) => void
  /** Whether a line leads anywhere; the open command is disabled on lines that do not (headings, totals). */
  canOpen?: (row: T) => boolean
  footerCells?: readonly ReactNode[]
  page?: TableCursorPage
  onPage?: (direction: 'previous' | 'next') => void
  /** A page is loading: paging keys are ignored until it arrives, so a held or repeated key moves one page only. */
  pageBusy?: boolean
  /** Moves focus to the highlighted line once the rows arrive, so the keys work at once. */
  focusOnLoad?: boolean
}) {
  const frame = useRef<HTMLElement>(null)
  const table = useRef<DataTableApi>(null)
  const keys = rows.map(rowKey)
  const index = Math.max(0, highlight === undefined ? 0 : keys.indexOf(highlight))
  const position = useRef(index)
  position.current = index
  const current = rows[index]

  const move = (to: number) => {
    if (!rows.length) return
    const target = Math.min(Math.max(to, 0), rows.length - 1)
    position.current = target
    onHighlight(keys[target])
    table.current?.focusRow(keys[target])
  }
  const pages = onPage && page ? page.cursor : null
  /** Turns the page past an edge, once per key press while no page is loading; false where there is no page that way. */
  const turn = (direction: 'next' | 'previous') => {
    if (!pages || !(direction === 'next' ? pages.hasNext : pages.hasPrevious)) return false
    if (!pageBusy) onPage!(direction)
    return true
  }
  const step = (by: number) => {
    const target = position.current + by
    if (!(target >= rows.length ? turn('next') : target < 0 ? turn('previous') : false)) move(target)
  }

  useAppCommand('report.next', () => step(1), { repeat: true })
  useAppCommand('report.previous', () => step(-1), { repeat: true })
  useAppCommand('report.page-down', () => step(pageLines), { repeat: true })
  useAppCommand('report.page-up', () => step(-pageLines), { repeat: true })
  useAppCommand('report.first', () => move(0))
  useAppCommand('report.last', () => move(rows.length - 1))
  const openable = current !== undefined && (canOpen?.(current) ?? true)
  useAppCommand('report.drill', () => { if (current) onOpen(current) }, { enabled: openable })

  // Once rows arrive (and after each page), the highlighted row takes focus unless the user is typing somewhere. With no
  // rows the table frame takes it, so focus is inside the report rather than on the page body.
  const signature = keys.join('|')
  useEffect(() => {
    if (!focusOnLoad) return
    const active = document.activeElement
    if (active && active !== document.body && !frame.current?.contains(active) && active.closest('input, textarea, select, dialog')) return
    if (rows.length) table.current?.focusRow(keys[position.current])
    else frame.current?.focus()
  }, [signature, focusOnLoad])

  return <Stack ref={frame} gap={2} tabIndex={-1} aria-label={caption} onFocusCapture={event => {
    // A row focused by the table's own keys, or by a click, becomes the highlight. The table renders one focusable row
    // per data row, in order, and reports no focus change of its own.
    const at = [...(frame.current?.querySelectorAll('tbody > tr[tabindex]') ?? [])].indexOf(event.target as HTMLElement)
    if (at >= 0 && at !== position.current) { position.current = at; onHighlight(keys[at]) }
  }}>
    <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} activeKey={current ? keys[index] : undefined}
      onRowActivate={row => onOpen(row)} searchable={false} sortable={false} pagination={page !== undefined} page={page}
      apiRef={table} pageStep={pageLines} onPageEdge={pages ? turn : undefined}
      onPageChange={change => { if (!pageBusy) onPage?.(change.direction) }} footerCells={footerCells} density='compact' />
  </Stack>
}
