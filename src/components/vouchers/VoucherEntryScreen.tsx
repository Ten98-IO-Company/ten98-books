import { Alert, Button, Field, Inline, Input, PageHeader, Stack, StatusLine, Textarea, type CommandPress, type EntryCommitEvent, type EntryEndContext, type EntryGridApi, type EntryGridPanel } from '@ten98/ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { forgetDefaults } from '../reports/navigation'
import type { MoneyExponent } from '@ten98/runtime/browser'
import type { Company } from '../../lib/company'
import type { GroupRow, LedgerRow } from '../../lib/masters'
import type { VoucherType } from '../../lib/ledger'
import { resolveTyped } from '../../lib/lookup-entry'
import { longDate } from '../../lib/reports'
import { useApp } from '../../lib/app-context'
import {
  afterDate, afterDeclinedAccept, amountText, appendedLine, balanceText, bodyLines, bodyProblems, cashInHandIds, cashRuleProblem, creditPeriodText,
  detailSteps, differenceText, draftDirty, entryDateLabel, entryDateProblem, escapeStep, isBlankLine, isCompleteLine, kindTitles, layoutTitles, layoutsOf, ledgerOptions,
  lineKey, listEnd, minorOf, negativeCashWarning, parseEntryDate, particularsSide, particularsTotal, proposedAmount, readLayout, refusalPlace,
  relayLines, writeLayout, type EntryFocus, type EntryKind, type EntryLayout, type EntryLine, type FocusOrigin,
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
export const lastTypeKey = (userId: string, companyId: string) => `voucherType:${userId}:${companyId}`

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
  const userId = useApp().me.user.id
  const draft = useVoucherDraft(userId, company.id, { kind: start.kind, layout: readLayout(start.kind, sessionStore, userId, company.id), date: start.date }, exponent)
  const { state, dispatch, locked } = draft
  // The latest state, for commands and grid events that run before React renders the last change.
  const latest = useRef(state)
  latest.current = state
  const root = useRef<HTMLElement>(null)
  const grid = useRef<EntryGridApi>(null)
  const serial = useRef(0)
  serial.current = Math.max(serial.current, state.serial)
  const nextKey = () => lineKey(serial.current++)

  const entryLedgers = useMemo(() => ledgers.map(ledger => ({ id: ledger.id, name: ledger.name, secondLanguageName: ledger.secondLanguageName, cashOrBank: ledger.cashOrBank })), [ledgers])
  const ledgerById = useMemo(() => new Map(ledgers.map(ledger => [ledger.id, ledger])), [ledgers])
  // Cash-in-hand ledgers (not bank): a credit taking one below zero warns (observed).
  const cashInHand = useMemo(() => cashInHandIds(groups, ledgers), [groups, ledgers])
  const typeOf = (kind: EntryKind) => types.find(type => type.kind === kind && type.systemKey !== null) ?? types.find(type => type.kind === kind)
  const voucherType = typeOf(state.kind)

  const [refresh, setRefresh] = useState(0)
  const number = useNextNumber(company.id, voucherType?.id ?? null, state.date, refresh)
  const preview = useMemo(() => bodyLines(state, exponent).map(line => ({ ledgerId: line.ledger, side: line.side, amount: line.amount })), [state, exponent])
  const others = useMemo(() => [state.account, ...state.lines.map(line => line.ledger)].filter(Boolean), [state.account, state.lines])
  const balances = useResultingBalances(company.id, state.date, preview, others, exponent)

  const [dateText, setDateTextState] = useState<string | null>(null)
  // Commands read the date text from here: keys pressed faster than React renders still see the latest text.
  const dateRef = useRef<string | null>(null)
  const setDateText = (text: string | null) => { dateRef.current = text; setDateTextState(text) }
  const [dateError, setDateError] = useState<string>()
  const dateOrigin = useRef<FocusOrigin>({ field: 'account' })
  const [accountError, setAccountError] = useState<string>()
  const [prompt, setPrompt] = useState(false)
  const [announced, setAnnounced] = useState('')
  // The screen's own notices (a refused switch) live apart from the grid's announcements, so a commit does not overwrite them.
  const [notice, setNotice] = useState('')
  // Text typed in a line cell and not committed yet counts as entered (the leave guard asks).
  const [typing, setTypingState] = useState(false)
  const typingRef = useRef(false)
  const setTyping = (value: boolean) => { typingRef.current = value; setTypingState(value) }
  const [failure, setFailure] = useState<{ message: string; unknown?: boolean } | null>(null)
  const [saved, setSaved] = useState('')
  const [typeList, setTypeList] = useState(false)
  const [modeList, setModeList] = useState(false)
  const [confirm, dialog] = useConfirm()
  const dirty = draftDirty(state) || typing
  const leave = useLeave({ to: '/app/c/$companyId', params: { companyId: company.id } })
  const askToLeave = useCallback(async () => {
    // Text still in a cell's editor is committed first, then what was entered decides (a guard call with nothing entered passes).
    grid.current?.commit()
    // Text the grid dropped as focus left the cell (it named no ledger) counts too: it was typed (the guard asks).
    if (!draftDirty(latest.current) && !typingRef.current) return true
    const yes = await confirm({ title: `Leave this ${kindTitles[latest.current.kind].toLowerCase()} unsaved?`, description: 'What you entered in this voucher is not saved.', confirmLabel: 'Leave', cancelLabel: 'Keep entering' })
    // Kept: back to where the cursor was, also when the question came from a link or a key outside the voucher.
    if (!yes) window.setTimeout(() => focus(afterDate(lastOrigin.current)), 0)
    return yes
  }, [confirm])
  const guard = useLeaveGuard(dirty, askToLeave)

  // ---- Focus ----

  const focus = useCallback((target: EntryFocus, attempt = 0) => {
    if ('field' in target) {
      const control = controlOf(root.current, target.field)
      // A field the layout no longer has (the Account after a switch to double entry): the layout's first field.
      if (!control) { if (attempt === 0 && target.field !== 'date') focus(firstField(), 1); return }
      control.focus(); control.select?.()
      return
    }
    const { row, column, open, edit } = target.cell
    // A line that went away (a type switch re-laid the lines) returns to the layout's first field instead.
    if (!latest.current.lines.some(line => line.key === row)) { if (attempt === 0) window.setTimeout(() => focus(firstField(), 1), 0); return }
    const done = grid.current?.focusCell(row, column, { open, edit }) ?? false
    // A line the screen has just added renders on the next frame.
    if (!done && attempt < 5) window.requestAnimationFrame(() => focus(target, attempt + 1))
  }, [])
  const focusSoon = (target: EntryFocus) => window.setTimeout(() => focus(target), 0)
  const firstField = (from = latest.current): EntryFocus => from.layout === 'single' ? { field: 'account' } : { cell: { row: from.lines[0]?.key ?? '', column: 'ledger', open: true } }
  const firstLine = (from = latest.current): EntryFocus => ({ cell: { row: from.lines[0]?.key ?? '', column: 'ledger', open: true } })
  useEffect(() => { focusSoon(firstField()) }, [])
  // Where the cursor last was inside the voucher, for keys and bar buttons that take focus away (the date button, a question).
  const lastOrigin = useRef<FocusOrigin>({ field: 'account' })
  // A line whose bill panel was just accepted: the cursor moves on once the panel has given focus back to the grid.
  const continuing = useRef<string | null>(null)
  useEffect(() => {
    const holder = root.current
    if (!holder) return
    const onFocus = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const field = fieldOf(holder, target)
      if (field && field !== 'date') { lastOrigin.current = { field }; return }
      if (!holder.querySelector('[role="grid"]')?.contains(target)) return
      window.setTimeout(() => {
        const row = grid.current?.activeRow, column = grid.current?.activeColumn
        if (row && (column === 'side' || column === 'ledger' || column === 'amount')) lastOrigin.current = { cell: { row, column } }
        const pending = continuing.current
        if (pending) { continuing.current = null; continueAfter(pending) }
      }, 0)
    }
    holder.addEventListener('focusin', onFocus)
    return () => holder.removeEventListener('focusin', onFocus)
  }, [])

  // ---- Lines ----

  const setLines = (lines: EntryLine[]) => { latest.current = { ...latest.current, lines }; dispatch({ type: 'lines', lines }); setSaved(''); setFailure(null); setTyping(false) }
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

  function onEnd(context: EntryEndContext): boolean | void {
    const lines = fromGridRows(context.rows)
    const line = lines.find(entry => entry.key === context.row)
    // A bill-wise line opens its bills first, also on Enter over an unchanged amount (observed).
    if (context.column === 'amount' && needsBills(line) && continuing.current !== context.row) {
      grid.current?.openPanel(context.row)
      return true
    }
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
      grid.current?.openPanel(line.key)
    }
  }

  const lineSide = (line: EntryLine) => (latest.current.layout === 'single' ? particularsSide(latest.current.kind) : line.side || 'Dr')
  const panel: EntryGridPanel = {
    title: row => { const ledger = ledgerById.get(row.values.ledger ?? ''); return `Bills of ${ledger?.name ?? 'the line'}, up to ${amountText(minorOf(row.values.amount ?? '', exponent), exponent)} ${lineSide(fromGridRows([row])[0])}` },
    render: (row, close) => {
      const line = fromGridRows([row])[0]
      const ledger = ledgerById.get(line.ledger)
      return <BillPanel key={row.key} companyId={company.id} kind={latest.current.kind} date={latest.current.date} exponent={exponent}
        line={{ ledger: line.ledger, side: lineSide(line), amount: minorOf(line.amount, exponent) }} previous={latest.current.bills[row.key]}
        creditDefault={creditPeriodText(ledger?.creditPeriod ?? null)}
        // The grid's dialog gives focus back to the amount cell as it closes; the cursor moves on after that.
        onAccept={rows => {
          dispatch({ type: 'bills', row: row.key, rows })
          continuing.current = row.key
          // Should the grid not give focus back (nothing to restore), move on anyway.
          window.setTimeout(() => { if (continuing.current === row.key) { continuing.current = null; continueAfter(row.key) } }, 800)
        }} close={close} />
    },
  }

  // ---- Header ----

  const accountOptions = useMemo(() => ledgerOptions(state.kind, 'single', 'account', '', entryLedgers).all, [state.kind, entryLedgers])
  const setAccount = (ledgerId: string) => { latest.current = { ...latest.current, account: ledgerId }; dispatch({ type: 'account', ledger: ledgerId }); setAccountError(undefined); setSaved(''); setFailure(null) }
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
    // From a bar button (focus outside the voucher) the field or cell the cursor was in last.
    dateOrigin.current = inGrid && grid.current?.activeRow && (column === 'side' || column === 'ledger' || column === 'amount')
      ? { cell: { row: grid.current.activeRow, column } } : field && field !== 'date' ? { field }
      : !root.current?.contains(active) ? lastOrigin.current
      : latest.current.layout === 'single' ? { field: 'account' } : { cell: { row: latest.current.lines[0]?.key ?? '', column: 'ledger' } }
    if (inGrid) grid.current?.commit()
    setDateError(undefined)
    // Rendered at once, so the text is selected before the next key: typing replaces the date (no appending).
    flushSync(() => setDateText(longDate(latest.current.date)))
    const control = controlOf(root.current, 'date')
    control?.focus()
    control?.select()
  }
  function closeDate() { setDateText(null); setDateError(undefined); focusSoon(afterDate(dateOrigin.current)) }
  function applyDate() {
    const parsed = parseEntryDate(dateRef.current ?? '', latest.current.date)
    if ('error' in parsed) { setDateError(parsed.error); return }
    const problem = entryDateProblem(parsed.value, company, workingDate)
    if (problem) { setDateError(problem); return }
    dispatch({ type: 'date', date: parsed.value })
    // The date becomes the tab's working date even if the voucher is not saved (observed).
    onWorkingDate(parsed.value)
    closeDate()
  }

  // ---- Type and layout ----

  /** A type or layout switch, re-laid by `relayLines`; one that would reverse a side or drop a row is refused and said why. */
  function switchTo(kind: EntryKind, layout: EntryLayout): boolean {
    grid.current?.commit()
    setTypeList(false); setModeList(false); setPrompt(false); setFailure(null)
    if (dateRef.current !== null) { setDateText(null); setDateError(undefined) }
    const relaid = relayLines(latest.current, { kind, layout }, exponent, nextKey, ledgerId => ledgerById.get(ledgerId)?.cashOrBank === true)
    if ('refused' in relaid) { setNotice(relaid.refused); return false }
    setNotice('')
    latest.current = { ...latest.current, ...relaid }
    dispatch({ type: 'relaid', relaid })
    writeStored(sessionStore, lastTypeKey(userId, company.id), kind)
    // The cursor goes to line 1's ledger with its list open (observed); single entry starts on the Account.
    // After the grid has re-rendered and settled its own focus, so the first field keeps it.
    window.setTimeout(() => window.requestAnimationFrame(() => focus(firstField())), 0)
    return true
  }
  const switchType = (kind: EntryKind) => switchTo(kind, readLayout(kind, sessionStore, userId, company.id))
  function switchLayout(layout: EntryLayout) { if (switchTo(latest.current.kind, layout)) writeLayout(latest.current.kind, layout, sessionStore, userId, company.id) }

  // ---- Accept and save ----

  function problemBeforeSave(): { message: string; focus: EntryFocus; panel?: string } | null {
    const current = latest.current
    const lines = bodyLines(current, exponent)
    const problems = bodyProblems({ ...current, idempotencyKey: 'check-only', voucherTypeId: voucherType?.id ?? '' }, exponent)
    const incomplete = problems.find(problem => problem.line && problem.column)
    if (incomplete?.line && incomplete.column) return { message: incomplete.message, focus: { cell: { row: incomplete.line, column: incomplete.column, edit: true } }, panel: incomplete.bills ? incomplete.line : undefined }
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
    if (problems[0]) return { message: problems[0].message, focus: firstField() }
    return null
  }

  async function save() {
    // Locked by an unknown outcome, the only save is "Check and retry" (the same voucher, the same key); never two at once.
    if (!voucherType || draft.busy) return
    if (grid.current?.commit() === false) return
    setPrompt(false)
    const problem = problemBeforeSave()
    if (problem) { showProblem(problem); return }
    setFailure(null)
    const current = latest.current
    const expected = number
    // While the save runs the fields are read-only; the narration keeps the cursor (it was on the question or a field).
    if (!root.current?.contains(document.activeElement) || document.activeElement === document.body) controlOf(root.current, 'narration')?.focus()
    const outcome = await draft.save(voucherType.id, current)
    if (!outcome) return
    if (outcome.kind === 'saved') {
      // The saved voucher is history now: counters read before it are stale.
      counters.reset()
      const { voucher, warnings } = outcome
      const differs = expected !== null && voucher.number !== expected ? ` (No. ${expected} was shown; another voucher took it first)` : ''
      const notes = warnings.length ? ` ${warnings.length === 1 ? 'Note' : 'Notes'}: ${warnings.map(warning => warning.code.replaceAll('_', ' ')).join(', ')}.` : ''
      setSaved(`Saved ${kindTitles[current.kind].toLowerCase()} No. ${voucher.number ?? 'none'} dated ${longDate(voucher.date)}${differs}.${notes}`)
      setNotice('')
      onWorkingDate(voucher.date)
      // The reports' cached last voucher date is stale now (the day book would open on the old day).
      forgetDefaults(company.id)
      dispatch({ type: 'next' })
      setRefresh(value => value + 1)
      // The next voucher: same type, layout and date, the cursor on its first field (observed).
      window.setTimeout(() => focus(firstField()), 0)
      return
    }
    if (outcome.kind === 'unknown') { setFailure({ message: `No definite answer came (${outcome.message}), so this voucher may or may not be in the books. Check and retry sends the same voucher under the same key: the server saves it once, or answers that it already has it.`, unknown: true }); return }
    const place = refusalPlace(outcome.code)
    const message = place === 'maybe-saved' ? 'This voucher may already be saved under its key. Open the day book on its date to check before entering it again.' : outcome.message
    setFailure({ message })
    if (place === 'date') { setDateText(longDate(current.date)); setDateError(outcome.message); window.setTimeout(() => controlOf(root.current, 'date')?.focus(), 0) }
    else if (place === 'difference') { const last = [...current.lines].reverse().find(isCompleteLine); if (last) focusSoon({ cell: { row: last.key, column: 'amount', edit: true } }) }
    else if (place === 'cash-rule') focusSoon(current.layout === 'single' ? { field: 'account' } : firstLine())
    else if (place === 'bills') {
      // The server names the line ("line 2") in the order of the body: reopen that line's panel on its rows.
      const lineNo = Number(/line (\d+)/i.exec(outcome.message)?.[1] ?? 0)
      const key = bodyLines(current, exponent)[lineNo - 1]?.key
      if (key) { focus({ cell: { row: key, column: 'amount' } }); window.setTimeout(() => grid.current?.openPanel(key), 0) }
    }
  }

  function showProblem(problem: { message: string; focus: EntryFocus; panel?: string }) {
    setFailure({ message: problem.message })
    focusSoon(problem.focus)
    const panelLine = problem.panel
    if (panelLine) window.setTimeout(() => grid.current?.openPanel(panelLine), 30)
  }

  function openPrompt() {
    if (locked || grid.current?.commit() === false) return
    const problem = problemBeforeSave()
    if (problem) { showProblem(problem); return }
    setFailure(null)
    setPrompt(true)
  }
  function declineAccept() { setPrompt(false); focusSoon(afterDeclinedAccept(latest.current.layout, latest.current.lines)) }

  // ---- Commands ----

  useAppCommand('entry.next-field', (press?: CommandPress) => {
    const field = fieldOf(root.current, press?.target ?? document.activeElement)
    if (!field) { press?.decline(); return }
    if (field === 'date') applyDate()
    else if (field === 'account') { if (!latest.current.account) setAccountError('Choose a cash or bank ledger.'); else focus(firstLine()) }
    else if (field === 'total') focus({ field: 'narration' })
    else openPrompt()
  }, { allowInTextInput: true })
  useAppCommand('entry.previous-field', (press?: CommandPress) => {
    const target = press?.target instanceof HTMLInputElement || press?.target instanceof HTMLTextAreaElement ? press.target : null
    const field = fieldOf(root.current, target)
    const last = latest.current.lines[latest.current.lines.length - 1]
    if (!field || (target?.value ?? '') !== '' || field === 'date' || field === 'account' || !last) { press?.decline(); return }
    if (field === 'narration' && latest.current.layout === 'single' && !cashInHand.has(latest.current.account)) focus({ field: 'total' })
    else focus({ cell: { row: last.key, column: field === 'total' ? 'ledger' : 'amount', edit: true } })
  }, { allowInTextInput: true })
  useAppCommand('entry.skip-account', (press?: CommandPress) => {
    const target = press?.target instanceof HTMLInputElement || press?.target instanceof HTMLTextAreaElement ? press.target : null
    if (fieldOf(root.current, target) !== 'account' || (target?.value ?? '') !== '') { press?.decline(); return }
    focus(firstLine())
  }, { allowInTextInput: true })
  useAppCommand('entry.accept', () => void save(), { allowInTextInput: true, enabled: !locked })
  useAppCommand('entry.cancel', ((press?: CommandPress) => void cancel(press)), { allowInTextInput: true })
  useAppCommand('entry.voucher.date', openDate, { enabled: !locked })
  useAppCommand('entry.voucher.list', () => { grid.current?.commit(); setTypeList(true) }, { enabled: !locked })
  useAppCommand('entry.voucher.mode', () => { grid.current?.commit(); setModeList(true) }, { enabled: !locked && layoutsOf(state.kind).length > 1 })
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
      // The Escape ladder (escapeStep): a focused value is emptied first, prefilled ones included.
      const active = document.activeElement
      const field = fieldOf(root.current, active)
      if (field === 'date') { if ((dateRef.current ?? '') !== '') setDateText(''); else closeDate(); return }
      if (field === 'account' && escapeStep(latest.current.account, true) === 'clear') { setAccount(''); return }
      if (field === 'narration' && escapeStep(latest.current.narration, true) === 'clear') { dispatch({ type: 'narration', text: '' }); return }
      const row = grid.current?.activeRow, column = grid.current?.activeColumn
      if (!field && row && (column === 'ledger' || column === 'amount') && root.current?.querySelector('[role="grid"]')?.contains(active)) {
        const line = latest.current.lines.find(entry => entry.key === row)
        if (line && escapeStep(line[column], true) === 'clear') { setLines(latest.current.lines.map(entry => entry.key === row ? { ...entry, [column]: '' } : entry)); return }
      }
    }
    grid.current?.commit()
    if (escapeStep('', draftDirty(latest.current) || typingRef.current) === 'leave') { guard.pass(leave); return }
    if (await askToLeave()) guard.pass(leave)
  }

  // ---- Rendering ----

  const warnings = useMemo(() => [...new Set(state.lines.filter(line => line.ledger && line.amount && cashInHand.has(line.ledger)).map(line => line.ledger))]
    .map(ledgerId => negativeCashWarning(ledgerById.get(ledgerId)?.name ?? 'Cash', balances.get(ledgerId), exponent)).filter(Boolean), [state.lines, balances, cashInHand, ledgerById, exponent])
  const total = particularsTotal(state.lines, exponent)
  const difference = state.layout === 'double' ? differenceText(state.lines, exponent) : null
  const accountKept = balances.get(state.account)
  const accountBalance = state.account && accountKept !== undefined ? balanceText(accountKept, exponent) : null
  const title = kindTitles[state.kind]
  const summary = `${title} dated ${longDate(state.date)}${state.layout === 'single' ? `, ${amountText(total, exponent)} ${state.kind === 'payment' ? 'from' : 'into'} ${ledgerById.get(state.account)?.name ?? 'the account'}` : ''}, ${bodyLines(state, exponent).length} lines.`

  return <Stack gap={5} ref={root}>
    <PageHeader eyebrow={`Voucher entry · ${layoutTitles[state.layout]}`} title={title}
      description={`${number === null ? 'Number to be given on saving' : `No. ${number} (expected)`} · ${entryDateLabel(state.date)}`} />
    {draft.restorable && <Alert tone='info' title='A voucher was being entered before you signed in again'
      actions={<Inline gap={2}><Button size='sm' onClick={draft.restore}>Restore it</Button><Button size='sm' variant='secondary' onClick={draft.dropRestorable}>Discard it</Button></Inline>}>
      The unsaved {kindTitles[draft.restorable.state.kind].toLowerCase()} from {new Date(draft.restorable.savedAt).toLocaleTimeString()} is kept in this tab.
    </Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    {failure && <Alert tone='danger' title={failure.unknown ? 'Not known whether it was saved' : 'Not saved'}
      actions={failure.unknown ? <Inline gap={2}><Button size='sm' autoFocus onClick={() => void save()}>Check and retry</Button><Button size='sm' variant='secondary' onClick={() => void cancel()}>Leave</Button></Inline> : undefined}>
      {failure.message}
    </Alert>}
    {warnings.map(warning => <Alert key={warning} tone='warning'>{warning}</Alert>)}
    <VoucherHeader date={state.date} dateText={dateText} dateError={dateError} onDateText={text => { setDateText(text); setDateError(undefined) }}
      account={state.layout === 'single' ? state.account : null} accountOptions={accountOptions} accountError={accountError}
      onAccount={setAccount} onAccountTyped={accountTyped} onSkipAccount={() => focus(firstLine())} accountBalance={accountBalance}
      accountNegative={!!state.account && (balances.get(state.account) ?? 0n) < 0n} locked={locked} />
    <Stack onKeyDownCapture={event => {
      // Up on line 1 returns to the Account in single entry (observed), unless a list is open with a ledger typed in it.
      const input = event.target
      if (!(input instanceof HTMLInputElement) || event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || state.layout !== 'single') return
      if (grid.current?.activeRow !== state.lines[0]?.key || (input.getAttribute('aria-expanded') === 'true' && input.value !== '')) return
      event.preventDefault(); event.stopPropagation(); focus({ field: 'account' })
    }} onInput={event => { if (event.target instanceof HTMLInputElement && event.target.value) setTyping(true) }}>
      <LinesGrid kind={state.kind} layout={state.layout} number={number} lines={state.lines} ledgers={entryLedgers} balances={balances} exponent={exponent}
        locked={locked} apiRef={grid} panel={panel} onLines={setLines} createRow={createRow} onEnd={onEnd} onCellCommit={onCellCommit} announce={setAnnounced} />
    </Stack>
    {state.layout === 'single' && <Stack data-voucher-field='total'>
      <Field label='Total' description='Enter goes on to the narration.'><Input readOnly value={amountText(total, exponent)} dir='ltr' /></Field>
    </Stack>}
    <Stack data-voucher-field='narration'>
      <Field label='Narration' description='Enter asks to save; Shift+Enter starts a new line.'>
        <Textarea value={state.narration} readOnly={locked} rows={2} dir='auto' maxLength={2000} onChange={event => { dispatch({ type: 'narration', text: event.target.value }); setSaved('') }} />
      </Field>
    </Stack>
    {prompt && <AcceptPrompt title={`Save this ${title.toLowerCase()}?`} summary={summary} onYes={() => void save()} onNo={declineAccept} />}
    {notice && <StatusLine tone='warning' live='polite'>{notice}</StatusLine>}
    {difference && <StatusLine live='polite'>{difference}</StatusLine>}
    <StatusLine live='polite' busy={draft.busy}>{draft.busy ? 'Saving…' : announced || ' '}</StatusLine>
    <TypeList open={typeList} current={state.kind} onPick={switchType} onClose={() => setTypeList(false)} />
    {layoutsOf(state.kind).length > 1 && <ModeList open={modeList} current={state.layout} onPick={switchLayout} onClose={() => setModeList(false)} />}
    <DialogKeys name='Confirm' open={!!dialog}>{dialog}</DialogKeys>
  </Stack>
}
