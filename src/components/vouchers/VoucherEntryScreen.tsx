import { Alert, Button, Field, Inline, Input, PageHeader, Stack, StatusLine, Textarea, type CommandPress, type EntryCommitEvent, type EntryEndContext, type EntryGridApi, type EntryGridPanel } from '@ten98/ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
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
  afterDate, afterDeclinedAccept, amountText, appendedLine, balanceText, blankDraft, bodyLines, bodyProblems, canTakeStored, cashInHandIds, cashRuleProblem, creditPeriodText,
  detailSteps, differenceText, draftDirty, entryDateLabel, entryDateProblem, escapeStep, isBlankLine, isCompleteLine, kindTitles, layoutTitles, layoutsOf, ledgerOptions,
  lineKey, listEnd, minorOf, negativeCashWarning, parseEntryDate, particularsSide, particularsTotal, proposedAmount, readLayout, refusalPlace,
  isLocked, lockAlert, refusal, relayLines, writeLayout, type DraftState, type EntryFocus, type EntryKind, type EntryLayout, type EntryLine, type FocusOrigin,
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
import { useVoucherDraft, type SaveAnswer } from './useVoucherDraft'
import type { SaveResult } from '../../lib/voucher-entry'
import { VoucherHeader } from './VoucherHeader'

type Field = 'date' | 'account' | 'total' | 'narration'
export const lastTypeKey = (userId: string, companyId: string) => `voucherType:${userId}:${companyId}`

const controlOf = (root: HTMLElement | null, field: Field) =>
  root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-voucher-field="${field}"] input:not([type="hidden"]), [data-voucher-field="${field}"] textarea`) ?? null
const fields: readonly Field[] = ['date', 'account', 'total', 'narration']
const isField = (value: string | undefined): value is Field => fields.some(field => field === value)
const fieldOf = (root: HTMLElement | null, element: Element | null): Field | null => {
  const name = element && root?.contains(element) ? element.closest<HTMLElement>('[data-voucher-field]')?.dataset.voucherField : undefined
  return isField(name) ? name : null
}

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
  const { state, locked, edit } = draft
  // The draft as of now (the machine holds it synchronously), for keys and grid events that run before React renders.
  const now = (): DraftState => draft.current().draft
  const lockedNow = () => isLocked(draft.current())
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
  const promptHolder = useRef<HTMLElement>(null)
  const [announced, setAnnounced] = useState('')
  // The screen's own notices (a refused switch) live apart from the grid's announcements, so a commit does not overwrite them.
  const [notice, setNotice] = useState('')
  // Text typed in a line cell and not committed yet counts as entered (the leave guard asks).
  const [typing, setTypingState] = useState(false)
  const typingRef = useRef(false)
  const setTyping = (value: boolean) => { typingRef.current = value; setTypingState(value) }
  const [saved, setSaved] = useState('')
  const [typeList, setTypeList] = useState(false)
  const [modeList, setModeList] = useState(false)
  const [confirm, dialog] = useConfirm()
  const navigate = useNavigate()
  const dirty = draftDirty(state) || typing || locked
  const leave = useLeave({ to: '/app/c/$companyId', params: { companyId: company.id } })
  const retryButton = useRef<HTMLButtonElement>(null)
  /**
   * The question before the voucher is left or discarded, by its state: while a save runs or its outcome is unknown the
   * voucher may already be in the books (leaving forgets its key); in a conflict it was not saved; else what was entered.
   */
  const askBefore = useCallback(async (verb: 'Leave' | 'Discard') => {
    // Text still in a cell's editor is committed first, then what was entered decides (a guard call with nothing entered passes).
    grid.current?.commit()
    // A save on its way decides first (for a few seconds at most): right after a saved voucher there is nothing to ask about.
    await Promise.race([draft.settled(), new Promise(resolve => window.setTimeout(resolve, 3000))])
    const { phase, draft: current } = draft.current()
    // Text the grid dropped as focus left the cell (it named no ledger) counts too: it was typed (the guard asks).
    if (phase === 'editing' && !draftDirty(current) && !typingRef.current) return true
    const kind = kindTitles[current.kind].toLowerCase()
    const yes = await confirm(phase === 'sending' || phase === 'unknown'
      ? { title: `${verb} this ${kind}? It may already be saved`, description: `No definite answer came for its save, so it may be in the books. ${verb === 'Leave' ? 'Leaving' : 'Discarding it'} forgets its key: entering it again could save it twice. Check and retry first, or look in the day book.`, confirmLabel: verb, cancelLabel: 'Stay' }
      : phase === 'conflict'
        ? { title: `${verb} this ${kind}? It was not saved`, description: 'Its key is already used by a voucher in the books with other content. Open the day book to compare them first.', confirmLabel: verb, cancelLabel: 'Stay' }
        : { title: `${verb} this ${kind} unsaved?`, description: 'What you entered in this voucher is not saved.', confirmLabel: verb, cancelLabel: 'Keep entering' })
    // Kept: back to "Check and retry" when that is the way on, else where the cursor was (also after a link or a key outside the voucher).
    if (!yes) window.setTimeout(() => { if (draft.current().phase === 'unknown') retryButton.current?.focus(); else focus(afterDate(lastOrigin.current)) }, 0)
    return yes
  }, [confirm])
  const askToLeave = useCallback(() => askBefore('Leave'), [askBefore])
  const guard = useLeaveGuard(dirty, askToLeave)
  const { unauthorized } = useApp()
  // A lost session keeps the draft in the tab first, so signing in again needs no question.
  draft.signedOut.current = () => guard.pass(unauthorized)

  // ---- Focus ----

  const mounted = useRef(true)
  // Set again on every mount: development mode mounts effects twice, running the cleanup in between.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  /** Moves the cursor; a retry stops once the screen is gone or the user has put focus somewhere else meanwhile. */
  const focus = useCallback((target: EntryFocus, attempt = 0, from: Element | null = document.activeElement) => {
    if (!mounted.current || (attempt > 0 && document.activeElement !== from && document.activeElement !== document.body)) return
    if ('field' in target) {
      const control = controlOf(root.current, target.field)
      // A field the layout no longer has (the Account after a switch to double entry): the layout's first field.
      if (!control) { if (attempt === 0 && target.field !== 'date') focus(firstField(), 1, from); return }
      control.focus(); control.select?.()
      return
    }
    const { row, column, open, edit } = target.cell
    // A line that went away (a type switch re-laid the lines) returns to the layout's first field instead.
    if (!now().lines.some(line => line.key === row)) { if (attempt === 0) window.setTimeout(() => focus(firstField(), 1, from), 0); return }
    const done = grid.current?.focusCell(row, column, { open, edit }) ?? false
    // A line the screen has just added renders on the next frame.
    // (A timer, not an animation frame: frames do not run in a hidden or background tab.)
    if (!done && attempt < 5) window.setTimeout(() => focus(target, attempt + 1, from), 16)
  }, [])
  const focusSoon = (target: EntryFocus) => window.setTimeout(() => focus(target), 0)
  const firstField = (from = now()): EntryFocus => from.layout === 'single' ? { field: 'account' } : { cell: { row: from.lines[0]?.key ?? '', column: 'ledger', open: true } }
  const firstLine = (from = now()): EntryFocus => ({ cell: { row: from.lines[0]?.key ?? '', column: 'ledger', open: true } })
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

  // Every change goes through the machine, which refuses it unless the draft is being edited.
  const setLines = (lines: EntryLine[]) => { if (edit({ type: 'lines', lines })) { setSaved(''); setTyping(false) } }
  // A line appended before its counter-ledger read answered takes the answer while it is still empty (observed timing aside).
  const awaiting = useRef(new Map<string, string>())
  const counters = useCounterLedgers(company.id, voucherType?.id ?? null, (ledgerId, side, counter) => {
    if (!counter) return
    const lines = now().lines
    const target = lines.find(line => awaiting.current.get(line.key) === `${ledgerId}:${side}` && isBlankLine(line))
    if (!target) return
    awaiting.current.delete(target.key)
    const filled = lines.map(line => line.key === target.key ? { ...line, ledger: counter } : line)
    setLines(filled.map(line => line.key === target.key ? { ...line, amount: proposedAmount(filled, target.key, exponent) } : line))
  })
  const needsBills = (line: EntryLine | undefined) => !!line && detailSteps(line, ledgerById.get(line.ledger)).includes('bills')

  function createRow(lines: readonly EntryLine[]): EntryLine {
    const { kind, layout } = now()
    const last = lines[lines.length - 1]
    const known = layout === 'double' && last?.ledger && last.side ? counters.counterOf(last.ledger, last.side) : null
    const line = appendedLine({ kind, layout, lines, counter: known ?? null, exponent, key: nextKey() })
    if (layout === 'double' && known === undefined && last?.ledger && last.side) awaiting.current.set(line.key, `${last.ledger}:${last.side}`)
    return line
  }

  /** After a line's details are accepted: on to Narration when the voucher is complete, else the next line. */
  function continueAfter(row: string) {
    const { layout, lines } = now()
    const end = listEnd({ layout, lines, row, column: 'amount', accountIsCash: cashInHand.has(now().account), exponent })
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
    const end = listEnd({ layout: now().layout, lines, row: context.row, column: context.column, accountIsCash: cashInHand.has(now().account), exponent })
    if (!end) return
    focus(end)
    return true
  }

  function onCellCommit(event: EntryCommitEvent) {
    const lines = fromGridRows(event.rows)
    const index = lines.findIndex(entry => entry.key === event.row)
    const line = lines[index]
    if (!line) return
    if (event.column === 'ledger' && now().layout === 'double' && line.ledger && line.side) {
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

  const lineSide = (line: EntryLine) => (now().layout === 'single' ? particularsSide(now().kind) : line.side || 'Dr')
  const panel: EntryGridPanel = {
    title: row => { const ledger = ledgerById.get(row.values.ledger ?? ''); return `Bills of ${ledger?.name ?? 'the line'}, up to ${amountText(minorOf(row.values.amount ?? '', exponent), exponent)} ${lineSide(fromGridRows([row])[0])}` },
    render: (row, close) => {
      const line = fromGridRows([row])[0]
      const ledger = ledgerById.get(line.ledger)
      return <BillPanel key={row.key} companyId={company.id} kind={now().kind} date={now().date} exponent={exponent}
        line={{ ledger: line.ledger, side: lineSide(line), amount: minorOf(line.amount, exponent) }} previous={now().bills[row.key]}
        creditDefault={creditPeriodText(ledger?.creditPeriod ?? null)}
        // The grid's dialog gives focus back to the amount cell as it closes; the cursor moves on after that.
        onAccept={rows => {
          if (!edit({ type: 'bills', row: row.key, rows })) return
          continuing.current = row.key
          const from = document.activeElement
          // Should the grid not give focus back (nothing to restore), move on anyway, unless the user has put focus elsewhere.
          window.setTimeout(() => {
            const active = document.activeElement
            const moved = !!active && active !== document.body && active !== from && active.isConnected
            if (mounted.current && continuing.current === row.key && !moved) { continuing.current = null; continueAfter(row.key) }
          }, 800)
        }} close={close} />
    },
  }

  // ---- Header ----

  const accountOptions = useMemo(() => ledgerOptions(state.kind, 'single', 'account', '', entryLedgers).all, [state.kind, entryLedgers])
  const setAccount = (ledgerId: string) => { if (edit({ type: 'account', ledger: ledgerId })) { setAccountError(undefined); setSaved('') } }
  function accountTyped(text: string, advance: boolean): 'picked' | 'error' | 'unchanged' {
    const result = resolveTyped(accountOptions, text, now().account)
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
      : now().layout === 'single' ? { field: 'account' } : { cell: { row: now().lines[0]?.key ?? '', column: 'ledger' } }
    if (inGrid) grid.current?.commit()
    setDateError(undefined)
    // Rendered at once, so the text is selected before the next key: typing replaces the date (no appending).
    flushSync(() => setDateText(longDate(now().date)))
    const control = controlOf(root.current, 'date')
    control?.focus()
    control?.select()
  }
  function closeDate() { setDateText(null); setDateError(undefined); focusSoon(afterDate(dateOrigin.current)) }
  function applyDate() {
    const parsed = parseEntryDate(dateRef.current ?? '', now().date)
    if ('error' in parsed) { setDateError(parsed.error); return }
    const problem = entryDateProblem(parsed.value, company, workingDate)
    if (problem) { setDateError(problem); return }
    if (!edit({ type: 'date', date: parsed.value })) return
    // The date becomes the tab's working date even if the voucher is not saved (observed).
    onWorkingDate(parsed.value)
    closeDate()
  }

  // ---- Type and layout ----

  /** A type or layout switch, re-laid by `relayLines`; one that would reverse a side or drop a row is refused and said why. */
  function switchTo(kind: EntryKind, layout: EntryLayout): boolean {
    if (lockedNow()) return false
    grid.current?.commit()
    const relaid = relayLines(now(), { kind, layout }, exponent, nextKey, ledgerId => ledgerById.get(ledgerId)?.cashOrBank === true)
    if ('refused' in relaid) { setTypeList(false); setModeList(false); setNotice(relaid.refused); return false }
    // Rendered at once and the cursor moved inside the key's own handler, so keys typed straight after the switch land
    // in the new first field: line 1's ledger with its list open (observed), or the Account in single entry.
    let switched = false
    flushSync(() => {
      setTypeList(false); setModeList(false); setPrompt(false); setNotice('')
      if (dateRef.current !== null) { setDateText(null); setDateError(undefined) }
      switched = edit({ type: 'relaid', relaid })
    })
    if (!switched) return false
    writeStored(sessionStore, lastTypeKey(userId, company.id), kind)
    // The grid moves its focus in a layout effect of its next render: rendered at once too.
    flushSync(() => focus(firstField()))
    return true
  }
  const switchType = (kind: EntryKind) => switchTo(kind, readLayout(kind, sessionStore, userId, company.id))
  function switchLayout(layout: EntryLayout) { if (switchTo(now().kind, layout)) writeLayout(now().kind, layout, sessionStore, userId, company.id) }

  // ---- Accept and save ----

  function problemBeforeSave(): { message: string; focus: EntryFocus; panel?: string } | null {
    const current = now()
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
    // Locked, the only send is "Check and retry" (the same body under the same key); the machine drops a second press.
    if (!voucherType || lockedNow()) return
    if (grid.current?.commit() === false) return
    // Saving from the question: the cursor moves to the narration before the question (and its focused button) goes.
    if (promptHolder.current?.contains(document.activeElement)) controlOf(root.current, 'narration')?.focus()
    setPrompt(false)
    const problem = problemBeforeSave()
    if (problem) { showProblem(problem); return }
    const sent = now()
    const expected = number
    // While the save runs the fields are read-only; the narration keeps the cursor (it was on the question or a field).
    if (!root.current?.contains(document.activeElement) || document.activeElement === document.body) controlOf(root.current, 'narration')?.focus()
    const pending = draft.save(voucherType.id)
    if (pending) settle(await pending, sent, expected)
  }

  /** "Check and retry": the cursor waits on the (read-only) narration while the alert is away, and comes back with it. */
  async function retry() {
    const sent = now()
    const expected = number
    controlOf(root.current, 'narration')?.focus()
    const pending = draft.retry()
    if (pending) settle(await pending, sent, expected)
  }

  /** What the screen does after an answer; the voucher's own state (locked, the alert) is the machine's already. */
  function settle(result: SaveResult<SaveAnswer>, sent: DraftState, expected: number | null) {
    if (!mounted.current) return
    if (result.kind === 'saved') {
      // The saved voucher is history now: counters read before it are stale.
      counters.reset()
      const { voucher, warnings } = result.answer
      // A replay is the voucher an earlier send already saved: its number was never the one shown since.
      const differs = result.answer.replayed ? ' (it was already in the books: saved by an earlier send whose answer was lost)'
        : expected !== null && voucher.number !== expected ? ` (No. ${expected} was shown; another voucher took it first)` : ''
      const notes = warnings.length ? ` ${warnings.length === 1 ? 'Note' : 'Notes'}: ${warnings.map(warning => warning.code.replaceAll('_', ' ')).join(', ')}.` : ''
      setSaved(`Saved ${kindTitles[sent.kind].toLowerCase()} No. ${voucher.number ?? 'none'} dated ${longDate(voucher.date)}${differs}.${notes}`)
      setNotice('')
      setDateText(null); setDateError(undefined)
      onWorkingDate(voucher.date)
      // The reports' cached last voucher date is stale now (the day book would open on the old day).
      forgetDefaults(company.id)
      setRefresh(value => value + 1)
      // The next voucher: same type, layout and date, the cursor on its first field (observed).
      window.setTimeout(() => focus(firstField()), 0)
      return
    }
    if (result.kind !== 'refused') return
    const place = refusalPlace(result.code)
    if (place === 'date') {
      setDateText(longDate(sent.date)); setDateError(result.message)
      // Selected, so the corrected date replaces the refused one.
      window.setTimeout(() => { const control = controlOf(root.current, 'date'); control?.focus(); control?.select() }, 0)
    }
    else if (place === 'difference') { const last = [...sent.lines].reverse().find(isCompleteLine); if (last) focusSoon({ cell: { row: last.key, column: 'amount', edit: true } }) }
    else if (place === 'cash-rule') focusSoon(sent.layout === 'single' ? { field: 'account' } : firstLine())
    else if (place === 'bills') {
      // The server names the line ("line 2") in the order of the body: reopen that line's panel on its rows.
      const lineNo = Number(/line (\d+)/i.exec(result.message)?.[1] ?? 0)
      const key = bodyLines(sent, exponent)[lineNo - 1]?.key
      if (key) { focus({ cell: { row: key, column: 'amount' } }); window.setTimeout(() => grid.current?.openPanel(key), 0) }
    }
  }

  function showProblem(problem: { message: string; focus: EntryFocus; panel?: string }) {
    draft.problem(problem.message)
    focusSoon(problem.focus)
    const panelLine = problem.panel
    if (panelLine) window.setTimeout(() => grid.current?.openPanel(panelLine), 30)
  }

  function openPrompt() {
    if (lockedNow() || grid.current?.commit() === false) return
    const problem = problemBeforeSave()
    if (problem) { showProblem(problem); return }
    setPrompt(true)
  }

  // ---- A conflict, and the drafts kept across a lost session ----

  function openDayBook() {
    const date = now().date
    void askToLeave().then(yes => { if (yes) guard.pass(() => void navigate({ to: '/app/c/$companyId/reports/day-book', params: { companyId: company.id }, search: { from: date, to: date } })) })
  }
  async function startNew() {
    const { kind, layout, date } = now()
    if (!(await askBefore('Discard'))) return
    if (draft.discard(blankDraft(kind, layout, date))) { setTyping(false); focusSoon(firstField()) }
  }
  function restoreKept() {
    if (!draft.restore()) return
    setSaved(''); setTyping(false)
    // A voucher whose outcome is unknown comes back locked, its alert's "Check and retry" taking the cursor (autoFocus).
    if (draft.current().phase === 'editing') focusSoon(firstField())
  }
  async function dropKept() {
    const kept = draft.current().offered[0]
    if (!kept || !canTakeStored(draft.current())) return
    const kind = kindTitles[kept.draft.kind].toLowerCase()
    if (kept.phase !== 'editing' && !(await confirm({ title: `Discard the kept ${kind}? It may already be saved`, description: kept.phase === 'unknown' ? 'Its save got no definite answer, so it may be in the books. Discarding it forgets its key: entering it again could save it twice. Restore it and check and retry instead, or look in the day book.' : 'Its key is already used by a voucher in the books with other content.', confirmLabel: 'Discard', cancelLabel: 'Keep it' }))) return
    draft.drop()
  }

  function declineAccept() { setPrompt(false); focusSoon(afterDeclinedAccept(now().layout, now().lines)) }

  // ---- Commands ----

  useAppCommand('entry.next-field', (press?: CommandPress) => {
    const field = fieldOf(root.current, press?.target ?? document.activeElement)
    if (!field) { press?.decline(); return }
    if (field === 'date') applyDate()
    else if (field === 'account') { if (!now().account) setAccountError('Choose a cash or bank ledger.'); else focus(firstLine()) }
    else if (field === 'total') focus({ field: 'narration' })
    else openPrompt()
  }, { allowInTextInput: true })
  useAppCommand('entry.previous-field', (press?: CommandPress) => {
    const target = press?.target instanceof HTMLInputElement || press?.target instanceof HTMLTextAreaElement ? press.target : null
    const field = fieldOf(root.current, target)
    const last = now().lines[now().lines.length - 1]
    if (!field || (target?.value ?? '') !== '' || field === 'date' || field === 'account' || !last) { press?.decline(); return }
    if (field === 'narration' && now().layout === 'single' && !cashInHand.has(now().account)) focus({ field: 'total' })
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
    if (!quit && !lockedNow()) {
      // The Escape ladder (escapeStep): a focused value is emptied first, prefilled ones included.
      const active = document.activeElement
      const field = fieldOf(root.current, active)
      if (field === 'date') { if ((dateRef.current ?? '') !== '') setDateText(''); else closeDate(); return }
      if (field === 'account' && escapeStep(now().account, true) === 'clear') { setAccount(''); return }
      if (field === 'narration' && escapeStep(now().narration, true) === 'clear') { edit({ type: 'narration', text: '' }); return }
      const row = grid.current?.activeRow, column = grid.current?.activeColumn
      if (!field && row && (column === 'ledger' || column === 'amount') && root.current?.querySelector('[role="grid"]')?.contains(active)) {
        const line = now().lines.find(entry => entry.key === row)
        if (line && escapeStep(line[column], true) === 'clear') { setLines(now().lines.map(entry => entry.key === row ? { ...entry, [column]: '' } : entry)); return }
      }
    }
    grid.current?.commit()
    if (escapeStep('', draftDirty(now()) || typingRef.current || lockedNow()) === 'leave') { guard.pass(leave); return }
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
  const alert = lockAlert(draft.machine)
  const refused = refusal(draft.machine)
  const kept = draft.machine.offered[0]
  const canTake = canTakeStored(draft.machine)
  const keptText = !kept ? '' : `${kept.phase === 'editing' ? 'The unsaved' : 'A'} ${kindTitles[kept.draft.kind].toLowerCase()} dated ${longDate(kept.draft.date)}, kept at ${new Date(kept.savedAt).toLocaleTimeString()}${kept.phase === 'unknown' ? ', got no definite answer to its save: it may already be in the books. Restore it to check and retry under its own key.' : kept.phase === 'conflict' ? ', was not saved: its key is already used by a voucher with other content.' : ', is kept in this tab.'}`
  const summary = `${title} dated ${longDate(state.date)}${state.layout === 'single' ? `, ${amountText(total, exponent)} ${state.kind === 'payment' ? 'from' : 'into'} ${ledgerById.get(state.account)?.name ?? 'the account'}` : ''}, ${bodyLines(state, exponent).length} lines.`

  return <Stack gap={5} ref={root}>
    <PageHeader eyebrow={`Voucher entry · ${layoutTitles[state.layout]}`} title={title}
      description={`${number === null ? 'Number to be given on saving' : `No. ${number} (expected)`} · ${entryDateLabel(state.date)}`} />
    {kept && <Alert tone='info' title={kept.phase === 'editing' ? 'A voucher was being entered before you signed in again' : 'A voucher whose save is not settled was kept before you signed in again'}
      actions={<Inline gap={2}><Button size='sm' disabled={!canTake} onClick={restoreKept}>Restore it</Button><Button size='sm' variant='secondary' disabled={!canTake} onClick={() => void dropKept()}>Discard it</Button></Inline>}>
      {keptText}{canTake ? '' : ' Save or leave the voucher on screen first: a kept voucher can be restored or discarded only while the one on screen is empty.'}
    </Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    {alert?.phase === 'unknown' && <Alert tone='danger' title='Not known whether it was saved'
      actions={<Inline gap={2}><Button ref={retryButton} size='sm' autoFocus onClick={() => void retry()}>Check and retry</Button><Button size='sm' variant='secondary' onClick={() => void cancel()}>Leave</Button></Inline>}>
      No definite answer came ({alert.message}), so this voucher may or may not be in the books. Check and retry sends the same voucher under the same key: the server saves it once, or answers that it already has it.
    </Alert>}
    {alert?.phase === 'conflict' && <Alert tone='danger' title='Not saved: its key is already used'
      actions={<Inline gap={2}><Button size='sm' autoFocus onClick={openDayBook}>Open the day book</Button><Button size='sm' variant='secondary' onClick={() => void startNew()}>Start a new voucher</Button><Button size='sm' variant='secondary' onClick={() => void cancel()}>Leave</Button></Inline>}>
      A voucher with other content is already in the books under this voucher's key, so this one was not saved and is kept as it is. Open the day book on {longDate(state.date)} to compare them; a new voucher gets a new key.
    </Alert>}
    {refused && <Alert tone='danger' title='Not saved'>{refused}</Alert>}
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
    }} onInput={event => { if (event.target instanceof HTMLInputElement) setTyping(event.target.value !== '') }}
      onKeyUp={event => { if (event.key === 'Escape' && event.target instanceof HTMLInputElement && event.target.value === '') setTyping(false) }}>
      <LinesGrid kind={state.kind} layout={state.layout} number={number} lines={state.lines} ledgers={entryLedgers} balances={balances} exponent={exponent}
        locked={locked} apiRef={grid} panel={panel} onLines={setLines} createRow={createRow} onEnd={onEnd} onCellCommit={onCellCommit} announce={setAnnounced} />
    </Stack>
    {state.layout === 'single' && <Stack data-voucher-field='total'>
      <Field label='Total' description='Enter goes on to the narration.'><Input readOnly value={amountText(total, exponent)} dir='ltr' /></Field>
    </Stack>}
    <Stack data-voucher-field='narration'>
      <Field label='Narration' description='Enter asks to save; Shift+Enter starts a new line.'>
        <Textarea value={state.narration} readOnly={locked} rows={2} dir='auto' maxLength={2000} onChange={event => { if (edit({ type: 'narration', text: event.target.value })) setSaved('') }} />
      </Field>
    </Stack>
    {prompt && <AcceptPrompt holder={promptHolder} title={`Save this ${title.toLowerCase()}?`} summary={summary} onYes={() => void save()} onNo={declineAccept} />}
    {/* Mounted while empty, so a screen reader announces each new text. */}
    <StatusLine tone='warning' live='polite'>{notice}</StatusLine>
    <StatusLine live='polite'>{difference ?? ''}</StatusLine>
    <StatusLine live='polite' busy={draft.busy}>{draft.busy ? 'Saving…' : announced || ' '}</StatusLine>
    <TypeList open={typeList} current={state.kind} onPick={switchType} onClose={() => setTypeList(false)} />
    {layoutsOf(state.kind).length > 1 && <ModeList open={modeList} current={state.layout} onPick={switchLayout} onClose={() => setModeList(false)} />}
    <DialogKeys name='Confirm' open={!!dialog}>{dialog}</DialogKeys>
  </Stack>
}
