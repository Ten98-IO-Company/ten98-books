import { Alert, Button, Field, Inline, Input, PageHeader, Stack, StatusLine, Textarea, type CommandPress, type EntryCommitEvent, type EntryEndContext, type EntryGridApi, type EntryGridPanel } from '@ten98/ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import type { Company } from '../../lib/company'
import { descendantIds, type GroupRow, type LedgerRow } from '../../lib/masters'
import type { CreditPeriod, VoucherType } from '../../lib/ledger'
import { resolveTyped } from '../../lib/lookup-entry'
import {
  afterDate, afterDeclinedAccept, appendedLine, balanceText, bodyLines, cashRuleProblem, creditPeriodText, detailSteps, differenceText,
  draftDirty, entryDateLabel, entryDateProblem, entryDateText, groupedAmount, isBlankLine, isCompleteLine, kindTitles, layoutTitles, ledgerOptions,
  lineKey, listEnd, minorOf, negativeCashWarning, parseEntryDate, particularsSide, particularsTotal, proposedAmount, readLayout, refusalPlace,
  writeLayout, type EntryFocus, type EntryKind, type EntryLayout, type EntryLine, type FocusOrigin,
} from '../../lib/voucher-entry'
import { sessionStore, writeStored } from '../../lib/working-date'
import { useAppCommand } from '../KeyboardShell'
import { EntryScope, useLeave, useLeaveGuard } from '../masters/entry'
import { useConfirm } from '../useConfirm'
import { DialogKeys } from '../KeyboardShell'
import { AcceptPrompt } from './AcceptPrompt'
import { BillPanel } from './BillPanel'
import { fromGridRows, LinesGrid } from './LinesGrid'
import { ModeList } from './ModeList'
import { TypeList } from './TypeList'
import { useCounterLedgers, useNextNumber, useResultingBalances } from './useEntryReads'
import { useVoucherDraft } from './useVoucherDraft'
import { VoucherHeader } from './VoucherHeader'

type Field = 'date' | 'account' | 'total' | 'narration'
export const lastTypeKey = (companyId: string) => `voucherType:${companyId}`

const controlOf = (root: HTMLElement | null, field: Field) =>
  root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-voucher-field="${field}"] input:not([type="hidden"]), [data-voucher-field="${field}"] textarea`) ?? null
const fieldOf = (root: HTMLElement | null, element: Element | null): Field | null =>
  (element && root?.contains(element) ? element.closest<HTMLElement>('[data-voucher-field]')?.dataset.voucherField as Field | undefined : undefined) ?? null

/**
 * Voucher entry, create (docs/VOUCHERS.md): payment, receipt, contra and journal, in single or double entry, with the
 * bill panel, the working date and the number and balance previews. Every decision is a pure function of
 * src/lib/voucher-entry.ts; this screen holds the state and moves focus.
 */
export function VoucherEntryScreen({ company, ledgers, groups, types, start, workingDate, onWorkingDate }: {
  company: Company; ledgers: readonly LedgerRow[]; groups: readonly GroupRow[]; types: readonly VoucherType[]
  start: { kind: EntryKind; date: string }
  workingDate: string
  onWorkingDate: (date: string) => void
}) {
  return <EntryScope><Entry company={company} ledgers={ledgers} groups={groups} types={types} start={start} workingDate={workingDate} onWorkingDate={onWorkingDate} /></EntryScope>
}

function Entry({ company, ledgers, groups, types, start, workingDate, onWorkingDate }: Parameters<typeof VoucherEntryScreen>[0]) {
  const exponent = company.currencyMinorUnits as MoneyExponent
  const draft = useVoucherDraft(company.id, { kind: start.kind, layout: readLayout(start.kind, sessionStore, company.id), date: start.date }, exponent)
  const { state, dispatch, locked } = draft
  // The latest state, for commands and grid events that run before React renders the last change.
  const latest = useRef(state)
  latest.current = state
  const root = useRef<HTMLDivElement>(null)
  const grid = useRef<EntryGridApi>(null)
  const serial = useRef(0)
  serial.current = Math.max(serial.current, state.serial)
  const nextKey = () => lineKey(serial.current++)

  const entryLedgers = useMemo(() => ledgers.map(ledger => ({ id: ledger.id, name: ledger.name, secondLanguageName: ledger.secondLanguageName, cashOrBank: ledger.cashOrBank })), [ledgers])
  const ledgerById = useMemo(() => new Map(ledgers.map(ledger => [ledger.id, ledger])), [ledgers])
  // Cash-in-hand ledgers (not bank): a credit taking one below zero warns (observed).
  const cashInHand = useMemo(() => {
    const ids = new Set<string>()
    for (const group of groups) if (group.systemKey === 'cash_in_hand') { ids.add(group.id); for (const id of descendantIds(groups, group.id)) ids.add(id) }
    return new Set(ledgers.filter(ledger => ledger.groupId !== null && ids.has(ledger.groupId)).map(ledger => ledger.id))
  }, [groups, ledgers])
  const typeOf = (kind: EntryKind) => types.find(type => type.kind === kind && type.systemKey !== null) ?? types.find(type => type.kind === kind)
  const voucherType = typeOf(state.kind)

  const [refresh, setRefresh] = useState(0)
  const number = useNextNumber(company.id, voucherType?.id ?? null, state.date, refresh)
  const preview = useMemo(() => bodyLines(state, exponent).map(line => ({ ledgerId: line.ledger, side: line.side, amount: line.amount })), [state, exponent])
  const others = useMemo(() => [state.account, ...state.lines.map(line => line.ledger)].filter(Boolean), [state.account, state.lines])
  const balances = useResultingBalances(company.id, state.date, preview, others, company.financialYearStart, exponent)

  const [dateText, setDateText] = useState<string | null>(null)
  const [dateError, setDateError] = useState<string>()
  const dateOrigin = useRef<FocusOrigin>({ field: 'account' })
  const [accountError, setAccountError] = useState<string>()
  const [prompt, setPrompt] = useState(false)
  const [announced, setAnnounced] = useState('')
  const [failure, setFailure] = useState<{ message: string; unknown?: boolean } | null>(null)
  const [saved, setSaved] = useState('')
  const [typeList, setTypeList] = useState(false)
  const [modeList, setModeList] = useState(false)
  const [confirm, dialog] = useConfirm()
  const dirty = draftDirty(state)
  const leave = useLeave({ to: '/app/c/$companyId', params: { companyId: company.id } })
  const askToLeave = useCallback(() => { grid.current?.commit(); return confirm({ title: `Leave this ${kindTitles[latest.current.kind].toLowerCase()} unsaved?`, description: 'What you entered in this voucher is not saved.', confirmLabel: 'Leave', cancelLabel: 'Keep entering' }) }, [confirm])
  const guard = useLeaveGuard(dirty, askToLeave)

  // ---- Focus ----

  const focus = useCallback((target: EntryFocus, attempt = 0) => {
    if ('field' in target) {
      const control = controlOf(root.current, target.field)
      if (!control) return
      control.focus(); control.select?.()
      return
    }
    const { row, column, open, edit } = target.cell
    const done = grid.current?.focusCell(row, column, { open, edit }) ?? false
    // A line the screen has just added renders on the next frame.
    if (!done && attempt < 5) window.requestAnimationFrame(() => focus(target, attempt + 1))
  }, [])
  const focusSoon = (target: EntryFocus) => window.setTimeout(() => focus(target), 0)
  const firstField = (from = latest.current): EntryFocus => from.layout === 'single' ? { field: 'account' } : { cell: { row: from.lines[0]?.key ?? '', column: 'ledger', open: true } }
  const firstLine = (from = latest.current): EntryFocus => ({ cell: { row: from.lines[0]?.key ?? '', column: 'ledger', open: true } })
  useEffect(() => { focusSoon(firstField()) }, [])

  // ---- Lines ----

  const setLines = (lines: EntryLine[]) => { latest.current = { ...latest.current, lines }; dispatch({ type: 'lines', lines }); setSaved('') }
  // A line appended before its counter-ledger read answered takes the answer while it is still empty (observed timing aside).
  const awaiting = useRef(new Map<string, string>())
  const counters = useCounterLedgers(company.id, voucherType?.id ?? null, (ledgerId, side, counter) => {
    if (!counter) return
    const lines = latest.current.lines
    const target = lines.find(line => awaiting.current.get(line.key) === `${ledgerId}:${side}` && isBlankLine(line))
    if (!target) return
    awaiting.current.delete(target.key)
    const filled = lines.map(line => line.key === target.key ? { ...line, ledger: counter } : line)
    setLines(filled.map(line => line.key === target.key ? { ...line, amount: proposedAmount(filled, target.key, exponent) } : line))
  })
  const needsBills = (line: EntryLine | undefined) => !!line && detailSteps(line, ledgerById.get(line.ledger)).includes('bills')

  function createRow(lines: readonly EntryLine[]): EntryLine {
    const { kind, layout } = latest.current
    const last = lines[lines.length - 1]
    const known = layout === 'double' && last?.ledger && last.side ? counters.counterOf(last.ledger, last.side) : null
    const line = appendedLine({ kind, layout, lines, counter: known ?? null, exponent, key: nextKey() })
    if (layout === 'double' && known === undefined && last?.ledger && last.side) awaiting.current.set(line.key, `${last.ledger}:${last.side}`)
    return line
  }

  /** After a line's details are accepted: on to Narration when the voucher is complete, else the next line. */
  function continueAfter(row: string) {
    const { layout, lines } = latest.current
    const end = listEnd({ layout, lines, row, column: 'amount', accountIsCash: cashInHand.has(latest.current.account), exponent })
    if (end) { focus(end); return }
    const index = lines.findIndex(line => line.key === row)
    if (index === lines.length - 1) grid.current?.insertRow('below', row)
    else if (index >= 0) focus({ cell: { row: lines[index + 1].key, column: layout === 'double' ? 'side' : 'ledger' } })
  }

  const panelShown = useRef<string | null>(null)
  function onEnd(context: EntryEndContext): boolean | void {
    const lines = fromGridRows(context.rows)
    const line = lines.find(entry => entry.key === context.row)
    // A bill-wise line opens its bills first, also on Enter over an unchanged amount (observed).
    if (context.column === 'amount' && needsBills(line) && panelShown.current !== context.row) {
      panelShown.current = context.row
      grid.current?.openPanel(context.row)
      return true
    }
    panelShown.current = null
    const end = listEnd({ layout: latest.current.layout, lines, row: context.row, column: context.column, accountIsCash: cashInHand.has(latest.current.account), exponent })
    if (!end) return
    focus(end)
    return true
  }

  function onCellCommit(event: EntryCommitEvent) {
    const lines = fromGridRows(event.rows)
    const index = lines.findIndex(entry => entry.key === event.row)
    const line = lines[index]
    if (!line) return
    if (event.column === 'ledger' && latest.current.layout === 'double' && line.ledger && line.side) {
      awaiting.current.delete(line.key)
      counters.read(line.ledger, line.side)
      // The difference is proposed once a ledger is chosen on a line with no amount (observed).
      const amount = proposedAmount(lines, line.key, exponent)
      if (amount) setLines(lines.map(entry => entry.key === line.key ? { ...entry, amount } : entry))
    }
    // Lines before the last open their bills here; the last line does it through onEnd.
    if (event.column === 'amount' && event.changed && index < lines.length - 1 && needsBills(line)) {
      panelShown.current = line.key
      grid.current?.openPanel(line.key)
    }
  }

  const lineSide = (line: EntryLine) => (latest.current.layout === 'single' ? particularsSide(latest.current.kind) : line.side || 'Dr')
  const panel: EntryGridPanel = {
    title: row => { const ledger = ledgerById.get(row.values.ledger ?? ''); return `Bills of ${ledger?.name ?? 'the line'}, up to ${groupedAmount(minorOf(row.values.amount ?? '', exponent), exponent)} ${lineSide(fromGridRows([row])[0])}` },
    render: (row, close) => {
      const line = fromGridRows([row])[0]
      const ledger = ledgerById.get(line.ledger)
      return <BillPanel key={row.key} companyId={company.id} kind={latest.current.kind} date={latest.current.date} exponent={exponent}
        line={{ ledger: line.ledger, side: lineSide(line), amount: minorOf(line.amount, exponent) }} previous={latest.current.bills[row.key]}
        creditDefault={creditPeriodText((ledger?.creditPeriod ?? null) as CreditPeriod | null)}
        onAccept={rows => { dispatch({ type: 'bills', row: row.key, rows }); window.setTimeout(() => continueAfter(row.key), 30) }} close={close} />
    },
  }

  // ---- Header ----

  const accountOptions = useMemo(() => ledgerOptions(state.kind, 'single', 'account', '', entryLedgers).all, [state.kind, entryLedgers])
  const setAccount = (ledgerId: string) => { latest.current = { ...latest.current, account: ledgerId }; dispatch({ type: 'account', ledger: ledgerId }); setAccountError(undefined); setSaved('') }
  function accountTyped(text: string, advance: boolean): 'picked' | 'error' | 'unchanged' {
    const result = resolveTyped(accountOptions, text, latest.current.account)
    if ('error' in result) { setAccountError(result.error); return 'error' }
    if (result.value === '') { setAccount(''); return 'unchanged' }
    setAccount(result.value)
    if (advance) focusSoon(firstLine())
    return 'picked'
  }

  function openDate() {
    if (locked) return
    const active = document.activeElement
    const field = fieldOf(root.current, active)
    const column = grid.current?.activeColumn
    const inGrid = !!active && !field && root.current?.querySelector('[role="grid"]')?.contains(active)
    dateOrigin.current = inGrid && grid.current?.activeRow && (column === 'side' || column === 'ledger' || column === 'amount')
      ? { cell: { row: grid.current.activeRow, column } } : field && field !== 'date' ? { field }
      : latest.current.layout === 'single' ? { field: 'account' } : { cell: { row: latest.current.lines[0]?.key ?? '', column: 'ledger' } }
    if (inGrid) grid.current?.commit()
    setDateError(undefined)
    setDateText(entryDateText(latest.current.date))
    window.setTimeout(() => { const control = controlOf(root.current, 'date'); control?.focus(); control?.select() }, 0)
  }
  function closeDate() { setDateText(null); setDateError(undefined); focusSoon(afterDate(dateOrigin.current)) }
  function applyDate() {
    const parsed = parseEntryDate(dateText ?? '', latest.current.date)
    if ('error' in parsed) { setDateError(parsed.error); return }
    const problem = entryDateProblem(parsed.value, company, workingDate)
    if (problem) { setDateError(problem); return }
    dispatch({ type: 'date', date: parsed.value })
    // The date becomes the tab's working date even if the voucher is not saved (observed).
    onWorkingDate(parsed.value)
    closeDate()
  }

  // ---- Type and layout ----

  function switchTo(kind: EntryKind, layout: EntryLayout) {
    grid.current?.commit()
    const next = { ...latest.current, kind, layout }
    dispatch({ type: 'switch', kind, layout, exponent })
    writeStored(sessionStore, lastTypeKey(company.id), kind)
    setTypeList(false); setModeList(false); setPrompt(false); setFailure(null)
    // The cursor goes to line 1's ledger with its list open (observed); single entry starts on the Account.
    window.setTimeout(() => focus(layout === 'single' ? { field: 'account' } : { cell: { row: latest.current.lines[0]?.key ?? '', column: 'ledger', open: true } }), 0)
    latest.current = next
  }
  const switchType = (kind: EntryKind) => switchTo(kind, readLayout(kind, sessionStore, company.id))
  function switchLayout(layout: EntryLayout) { writeLayout(latest.current.kind, layout, sessionStore, company.id); switchTo(latest.current.kind, layout) }

  // ---- Accept and save ----

  function problemBeforeSave(): { message: string; focus: EntryFocus } | null {
    const current = latest.current
    const lines = bodyLines(current, exponent)
    if (current.layout === 'single' && current.account === '') return { message: 'Choose the Account: the cash or bank ledger of this voucher.', focus: { field: 'account' } }
    if (!lines.length || (current.layout === 'double' && lines.length < 2)) return { message: 'Enter the lines of the voucher: a ledger and an amount on each.', focus: firstLine() }
    if (current.layout === 'double') {
      const difference = differenceText(current.lines, exponent)
      const last = [...current.lines].reverse().find(isCompleteLine)
      if (difference && last) return { message: `The voucher does not balance: ${difference}.`, focus: { cell: { row: last.key, column: 'amount', edit: true } } }
    }
    const rule = cashRuleProblem(current.kind, lines, ledgerId => ledgerById.get(ledgerId)?.cashOrBank === true)
    if (rule) {
      const at = lines[rule.line]
      return { message: rule.message, focus: current.layout === 'single' || at?.key == null ? { field: 'account' } : { cell: { row: at.key, column: 'ledger', open: true } } }
    }
    const date = entryDateProblem(current.date, company, workingDate)
    if (date) return { message: date, focus: { field: 'date' } }
    return null
  }

  async function save() {
    if (!voucherType || locked) return
    if (grid.current?.commit() === false) return
    setPrompt(false)
    const problem = problemBeforeSave()
    if (problem) { setFailure({ message: problem.message }); focusSoon(problem.focus); return }
    setFailure(null)
    const current = latest.current
    const expected = number
    const outcome = await draft.save(voucherType.id, current)
    if (!outcome) return
    if (outcome.kind === 'saved') {
      const { voucher, warnings } = outcome
      const differs = expected !== null && voucher.number !== expected ? ` (No. ${expected} was shown; another voucher took it first)` : ''
      const notes = warnings.length ? ` ${warnings.length === 1 ? 'Note' : 'Notes'}: ${warnings.map(warning => warning.code.replaceAll('_', ' ')).join(', ')}.` : ''
      setSaved(`Saved ${kindTitles[current.kind].toLowerCase()} No. ${voucher.number ?? 'none'} dated ${entryDateText(voucher.date)}${differs}.${notes}`)
      onWorkingDate(voucher.date)
      dispatch({ type: 'next' })
      setRefresh(value => value + 1)
      // The next voucher: same type, layout and date, the cursor on its first field (observed).
      window.setTimeout(() => focus(firstField()), 0)
      return
    }
    if (outcome.kind === 'unknown') { setFailure({ message: `The answer did not arrive (${outcome.message}), so this voucher may or may not be saved. Check and retry sends the same voucher again and cannot save it twice.`, unknown: true }); return }
    const place = refusalPlace(outcome.code)
    const message = place === 'maybe-saved' ? 'This voucher may already be saved under its key. Open the day book on its date to check before entering it again.' : outcome.message
    setFailure({ message })
    if (place === 'date') { setDateText(entryDateText(current.date)); setDateError(outcome.message); window.setTimeout(() => controlOf(root.current, 'date')?.focus(), 0) }
    else if (place === 'difference') { const last = [...current.lines].reverse().find(isCompleteLine); if (last) focusSoon({ cell: { row: last.key, column: 'amount', edit: true } }) }
    else if (place === 'cash-rule') focusSoon(current.layout === 'single' ? { field: 'account' } : firstLine())
  }

  function openPrompt() {
    if (locked || grid.current?.commit() === false) return
    const problem = problemBeforeSave()
    if (problem) { setFailure({ message: problem.message }); focusSoon(problem.focus); return }
    setFailure(null)
    setPrompt(true)
  }
  function declineAccept() { setPrompt(false); focusSoon(afterDeclinedAccept(latest.current.layout, latest.current.lines)) }

  // ---- Commands ----

  useAppCommand('entry.next-field', ((press?: CommandPress) => {
    const field = fieldOf(root.current, press?.target ?? document.activeElement)
    if (!field) { press?.decline(); return }
    if (field === 'date') applyDate()
    else if (field === 'account') { if (!latest.current.account) setAccountError('Choose a cash or bank ledger.'); else focus(firstLine()) }
    else if (field === 'total') focus({ field: 'narration' })
    else openPrompt()
  }) as () => void, { allowInTextInput: true })
  useAppCommand('entry.previous-field', ((press?: CommandPress) => {
    const target = press?.target as HTMLInputElement | null
    const field = fieldOf(root.current, target)
    const last = latest.current.lines[latest.current.lines.length - 1]
    if (!field || (target?.value ?? '') !== '' || field === 'date' || field === 'account' || !last) { press?.decline(); return }
    if (field === 'narration' && latest.current.layout === 'single' && !cashInHand.has(latest.current.account)) focus({ field: 'total' })
    else focus({ cell: { row: last.key, column: field === 'total' ? 'ledger' : 'amount', edit: true } })
  }) as () => void, { allowInTextInput: true })
  useAppCommand('entry.skip-account', ((press?: CommandPress) => {
    const target = press?.target as HTMLInputElement | null
    if (fieldOf(root.current, target) !== 'account' || (target?.value ?? '') !== '') { press?.decline(); return }
    focus(firstLine())
  }) as () => void, { allowInTextInput: true })
  useAppCommand('entry.accept', () => void save(), { allowInTextInput: true, enabled: !locked })
  useAppCommand('entry.cancel', ((press?: CommandPress) => void cancel(press)) as () => void, { allowInTextInput: true })
  useAppCommand('entry.voucher.date', openDate, { enabled: !locked })
  useAppCommand('entry.voucher.list', () => { grid.current?.commit(); setTypeList(true) }, { enabled: !locked })
  useAppCommand('entry.voucher.mode', () => { grid.current?.commit(); setModeList(true) }, { enabled: !locked && state.kind !== 'journal' })
  useAppCommand('entry.voucher.payment', () => switchType('payment'), { enabled: !locked && state.kind !== 'payment' })
  useAppCommand('entry.voucher.receipt', () => switchType('receipt'), { enabled: !locked && state.kind !== 'receipt' })
  useAppCommand('entry.voucher.contra', () => switchType('contra'), { enabled: !locked && state.kind !== 'contra' })
  useAppCommand('entry.voucher.journal', () => switchType('journal'), { enabled: !locked && state.kind !== 'journal' })
  // Sales and purchase come with the invoice layouts (slice 2); their keys are kept from the browser meanwhile.
  useAppCommand('entry.voucher.sales', () => undefined, { enabled: false })
  useAppCommand('entry.voucher.purchase', () => undefined, { enabled: false })
  useAppCommand('entry.create-master', () => undefined, { enabled: false })
  useAppCommand('entry.delete', () => undefined, { enabled: false })
  useAppCommand('entry.history', () => undefined, { enabled: false })

  /**
   * Escape and Ctrl+Q (entry.cancel). Escape first empties the focused value, prefilled ones included; with nothing to
   * empty it asks to quit when anything was entered, else it leaves (observed). Ctrl+Q asks at once (a kept difference:
   * the observed silent discard loses typed work). The answer No keeps the cursor where it was.
   */
  async function cancel(press?: CommandPress) {
    if (prompt) { declineAccept(); return }
    const quit = press !== undefined && press.event.key.toLowerCase() === 'q'
    if (!quit) {
      const active = document.activeElement as HTMLInputElement | null
      const field = fieldOf(root.current, active)
      if (field === 'date') { if ((dateText ?? '') !== '') setDateText(''); else closeDate(); return }
      if (field === 'account' && (latest.current.account !== '' || (active?.value ?? '') !== '')) { setAccount(''); if (active) active.value = ''; return }
      if (field === 'narration' && latest.current.narration !== '') { dispatch({ type: 'narration', text: '' }); return }
      const row = grid.current?.activeRow, column = grid.current?.activeColumn
      if (!field && row && (column === 'ledger' || column === 'amount') && root.current?.querySelector('[role="grid"]')?.contains(active)) {
        const line = latest.current.lines.find(entry => entry.key === row)
        if (line && line[column] !== '') { setLines(latest.current.lines.map(entry => entry.key === row ? { ...entry, [column]: '' } : entry)); return }
      }
    }
    if (!draftDirty(latest.current)) { guard.pass(leave); return }
    if (await askToLeave()) guard.pass(leave)
  }

  // ---- Rendering ----

  const warnings = useMemo(() => [...new Set(state.lines.filter(line => line.ledger && line.amount && cashInHand.has(line.ledger)).map(line => line.ledger))]
    .map(ledgerId => negativeCashWarning(ledgerById.get(ledgerId)?.name ?? 'Cash', balances.get(ledgerId), exponent)).filter(Boolean), [state.lines, balances, cashInHand, ledgerById, exponent])
  const total = particularsTotal(state.lines, exponent)
  const difference = state.layout === 'double' ? differenceText(state.lines, exponent) : null
  const accountBalance = state.account && balances.has(state.account) ? balanceText(balances.get(state.account)!, exponent) : null
  const title = kindTitles[state.kind]
  const summary = `${title} dated ${entryDateText(state.date)}${state.layout === 'single' ? `, ${groupedAmount(total, exponent)} ${state.kind === 'payment' ? 'from' : 'into'} ${ledgerById.get(state.account)?.name ?? 'the account'}` : ''}, ${bodyLines(state, exponent).length} lines.`

  return <Stack gap={5} ref={root as never}>
    <PageHeader eyebrow={`Voucher entry · ${layoutTitles[state.layout]}`} title={title}
      description={`${number === null ? 'Number to be given on saving' : `No. ${number} (expected)`} · ${entryDateLabel(state.date)}`} />
    {draft.restorable && <Alert tone='info' title='A voucher was being entered before you signed in again'
      actions={<Inline gap={2}><Button size='sm' onClick={draft.restore}>Restore it</Button><Button size='sm' variant='secondary' onClick={draft.dropRestorable}>Discard it</Button></Inline>}>
      The unsaved {kindTitles[draft.restorable.state.kind].toLowerCase()} from {new Date(draft.restorable.savedAt).toLocaleTimeString()} is kept in this tab.
    </Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    {failure && <Alert tone='danger' title={failure.unknown ? 'Not known whether it was saved' : 'Not saved'}
      actions={failure.unknown ? <Inline gap={2}><Button size='sm' onClick={() => void save()}>Check and retry</Button><Button size='sm' variant='secondary' onClick={() => { draft.discardUnknown(); setFailure(null) }}>Unlock and edit</Button></Inline> : undefined}>
      {failure.message}
    </Alert>}
    {warnings.map(warning => <Alert key={warning} tone='warning'>{warning}</Alert>)}
    <VoucherHeader date={state.date} dateText={dateText} dateError={dateError} onDateText={text => { setDateText(text); setDateError(undefined) }}
      account={state.layout === 'single' ? state.account : null} accountOptions={accountOptions} accountError={accountError}
      onAccount={setAccount} onAccountTyped={accountTyped} accountBalance={accountBalance}
      accountNegative={!!state.account && (balances.get(state.account) ?? 0n) < 0n} locked={locked} />
    <LinesGrid kind={state.kind} layout={state.layout} number={number} lines={state.lines} ledgers={entryLedgers} balances={balances} exponent={exponent}
      locked={locked} apiRef={grid} panel={panel} onLines={setLines} createRow={createRow} onEnd={onEnd} onCellCommit={onCellCommit} announce={setAnnounced} />
    {state.layout === 'single' && <Stack data-voucher-field='total'>
      <Field label='Total' description='Enter goes on to the narration.'><Input readOnly value={groupedAmount(total, exponent)} dir='ltr' /></Field>
    </Stack>}
    <Stack data-voucher-field='narration'>
      <Field label='Narration' description='Enter asks to save; Shift+Enter starts a new line.'>
        <Textarea value={state.narration} readOnly={locked} rows={2} dir='auto' maxLength={2000} onChange={event => { dispatch({ type: 'narration', text: event.target.value }); setSaved('') }} />
      </Field>
    </Stack>
    {prompt && <AcceptPrompt title={`Save this ${title.toLowerCase()}?`} summary={summary} onYes={() => void save()} onNo={declineAccept} />}
    <StatusLine live='polite' busy={draft.busy}>{draft.busy ? 'Saving…' : announced || difference || ' '}</StatusLine>
    <TypeList open={typeList} current={state.kind} onPick={switchType} onClose={() => setTypeList(false)} />
    {state.kind !== 'journal' && <ModeList open={modeList} current={state.layout} onPick={switchLayout} onClose={() => setModeList(false)} />}
    <DialogKeys name='Confirm' open={!!dialog}>{dialog}</DialogKeys>
  </Stack>
}
