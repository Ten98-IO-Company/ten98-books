import { Alert, EntryGrid, formatChord, Stack, StatusLine, Text, useCommandKeys, type EntryCommitEvent, type EntryGridApi, type EntryGridColumn, type EntryGridRow } from '@ten98/ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney, subtractMoney, type MoneyExponent } from '@ten98/runtime/browser'
import { errMsg } from '../../lib/api'
import { longDate } from '../../lib/reports'
import type { BillKind, Side, VoucherKind } from '../../lib/ledger'
import {
  againstAmount, allocated, billDueDate, billKindOrder, billKindTitles, billsCover, nextBillRow,
  parseCreditPeriod, parseEntryAmount, settleable, type BillDraft, type PendingChoice,
} from '../../lib/voucher-entry'
import { DialogKeys } from '../KeyboardShell'
import { readPendingBills } from './useEntryReads'

const methodOptions = billKindOrder.map(kind => ({ value: kind, label: billKindTitles[kind] }))
const sides = [{ value: 'Dr', label: 'Dr', keys: ['B', 'D'] }, { value: 'Cr', label: 'Cr', keys: ['T', 'C'] }] as const
const names = (method: string) => method === 'new_ref' || method === 'advance'

const toRows = (drafts: readonly BillDraft[], date: string): EntryGridRow[] => drafts.map(draft => {
  const period = parseCreditPeriod(draft.credit, date)
  const due = names(draft.method) && 'value' in period ? longDate(billDueDate(date, period.value)) : ''
  return { key: draft.key, values: { method: draft.method, bill: draft.bill, name: draft.name, credit: draft.credit, due, amount: draft.amount, side: draft.side } }
})
const fromRows = (rows: readonly EntryGridRow[]): BillDraft[] => rows.map(row => ({
  key: row.key, method: (row.values.method ?? '') as BillKind | '', bill: row.values.bill ?? '', name: row.values.name ?? '',
  credit: row.values.credit ?? '', amount: row.values.amount ?? '', side: (row.values.side ?? '') as Side | '',
}))

/**
 * The bill rows of one line on a bill-wise ledger (docs/VOUCHERS.md, "Bills"): a nested entry grid in the line's panel.
 * The first row starts against a bill while the party has pending bills on the other side, else on account; a picked
 * bill proposes the lesser of what is left and its pending; Enter on the last row adds one for the remainder, and the
 * panel closes by itself once the rows cover the line. Ctrl+A accepts with the rest on account; Escape keeps the
 * line's earlier rows.
 */
export function BillPanel({ companyId, kind, date, line, previous, creditDefault, exponent, onAccept, close }: {
  companyId: string; kind: VoucherKind; date: string
  line: { ledger: string; side: Side; amount: bigint }
  previous: readonly BillDraft[] | undefined
  /** The party's default credit period as typed text, for a new bill. */
  creditDefault: string
  exponent: MoneyExponent
  onAccept: (rows: BillDraft[]) => void
  close: () => void
}) {
  const [pending, setPending] = useState<PendingChoice[] | null>(null)
  const [error, setError] = useState('')
  const [drafts, setDrafts] = useState<BillDraft[]>([])
  const serial = useRef(1)
  const key = () => `bill-${serial.current++}`
  const latest = useRef(drafts)
  latest.current = drafts
  const grid = useRef<EntryGridApi>(null)
  const acceptKey = useCommandKeys('entry.accept')[0]
  // The rows arrive after the pending bills: the first row's method then takes focus with its list open (observed).
  const firstKey = drafts[0]?.key
  useEffect(() => { if (firstKey) window.setTimeout(() => grid.current?.focusCell(firstKey, 'method', { open: true }), 0) }, [firstKey])

  useEffect(() => {
    let live = true
    readPendingBills(companyId, line.ledger, date, exponent).then(found => {
      if (!live) return
      setPending(found)
      const first = previous?.length ? previous.map(row => ({ ...row })) : [nextBillRow({ kind, lineSide: line.side, lineAmount: line.amount, rows: [], pending: found, exponent, key: key() })]
      setDrafts(first.map(row => names(row.method) && row.credit === '' ? { ...row, credit: creditDefault } : row))
    }).catch(cause => { if (live) setError(errMsg(cause)) })
    return () => { live = false }
  }, [companyId, line.ledger, date])

  const billOptions = useMemo(() => (pending ? settleable(pending, line.side) : []).map(bill => ({
    value: bill.billId, label: bill.name,
    description: `Dated ${bill.billDate ? longDate(bill.billDate) : 'at the opening'}${bill.dueDate ? `, due ${longDate(bill.dueDate)}` : ''}, pending ${formatMoney(bill.pending < 0n ? -bill.pending : bill.pending, exponent)} ${bill.pending < 0n ? 'Cr' : 'Dr'}`,
  })), [pending, line.side, exponent])

  const columns = useMemo<EntryGridColumn[]>(() => [
    { id: 'method', label: 'Method', type: 'lookup', options: methodOptions, required: true },
    { id: 'bill', label: 'Bill', type: 'lookup', options: billOptions, readOnly: row => row.values.method !== 'against_ref', required: true },
    { id: 'name', label: 'Name', type: 'text', readOnly: row => !names(row.values.method ?? '') },
    { id: 'credit', label: 'Credit period or due date', type: 'text', readOnly: row => !names(row.values.method ?? ''),
      validate: value => { const parsed = parseCreditPeriod(value, date); return 'error' in parsed ? parsed.error : undefined } },
    { id: 'due', label: 'Due', type: 'text', readOnly: true },
    { id: 'amount', label: 'Amount', type: 'amount', required: true, parse: text => parseEntryAmount(text, exponent) },
    { id: 'side', label: 'Dr or Cr', type: 'side', sides, required: true },
  ], [billOptions, date, exponent])

  function change(next: BillDraft[]) { latest.current = next; setDrafts(next) }

  function accept(rows: BillDraft[] = latest.current) {
    const kept = rows.filter(row => row.method !== '' && row.amount !== '')
    const left = subtractMoney(line.amount, allocated(kept, line.side, exponent))
    // Accepted short of the line: the rest is on account.
    const filled = left > 0n ? [...kept, { key: key(), method: 'on_account' as const, bill: '', name: '', credit: '', amount: formatMoney(left, exponent), side: line.side }] : kept
    onAccept(filled)
    close()
  }

  function onCellCommit(event: EntryCommitEvent) {
    const rows = fromRows(event.rows)
    const index = rows.findIndex(row => row.key === event.row)
    const row = rows[index]
    if (!row) return
    // "Against a bill": the Bill cell opens its pending list, as the method list does (observed).
    if (event.column === 'method' && row.method === 'against_ref' && row.bill === '') window.setTimeout(() => grid.current?.focusCell(row.key, 'bill', { open: true }), 0)
    if (event.column === 'method' && event.changed) {
      rows[index] = { ...row, bill: '', name: names(row.method) ? row.name : '', credit: names(row.method) ? row.credit || creditDefault : '' }
      change(rows)
    }
    if (event.column === 'bill' && event.changed && pending) {
      const bill = pending.find(entry => entry.billId === row.bill)
      const others = rows.filter((_, position) => position !== index)
      if (bill) { rows[index] = { ...row, amount: againstAmount(bill, subtractMoney(line.amount, allocated(others, line.side, exponent)), exponent) }; change(rows) }
    }
  }

  const title = `Bills of the line, up to ${formatMoney(line.amount, exponent)} ${line.side}`
  return <DialogKeys name='Bills' open onAccept={() => accept()}>
    <Stack gap={3}>
      {error ? <Alert tone='danger'>The pending bills could not be loaded: {error}</Alert>
        : !pending ? <StatusLine busy>Loading the pending bills…</StatusLine>
        : <>
          <Text size='sm' tone='muted'>Enter after the last row adds a row for the rest; {acceptKey ? formatChord(acceptKey).text : 'the accept key'} accepts with the rest on account; Escape keeps the earlier rows. Pending bills are listed by name.</Text>
          <EntryGrid label={title} columns={columns} rows={toRows(drafts, date)} onRowsChange={next => change(fromRows(next))}
            createRow={current => toRows([nextBillRow({ kind, lineSide: line.side, lineAmount: line.amount, rows: fromRows(current), pending, exponent, key: key() })], date)[0]}
            onCellCommit={onCellCommit} escapeMode='restore' openListOnAppend apiRef={grid}
            onEnd={context => {
              // Enter on a row's last cell: the panel closes once the rows cover the line (observed), else a row follows for the rest.
              const rows = fromRows(context.rows)
              if (context.column !== 'side' || !billsCover(rows, line.side, line.amount, exponent)) return
              accept(rows)
              return true
            }} />
          <Text size='sm' tone='muted' aria-live='polite'>Left to allocate: {formatMoney(subtractMoney(line.amount, allocated(drafts, line.side, exponent)), exponent)} {line.side}</Text>
        </>}
    </Stack>
  </DialogKeys>
}
