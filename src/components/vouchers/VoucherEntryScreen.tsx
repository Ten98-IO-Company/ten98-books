import { Alert, Button, Field, Inline, Input, PageHeader, Stack, StatusLine, Textarea, type CommandPress, type EntryCommitEvent, type EntryEndContext, type EntryGridApi, type EntryGridPanel } from '@ten98/ui'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
  afterDate, afterDeclinedAccept, amountText, appendedLine, askBeforeLeaving, balanceText, blankDraft, bodyLines, dropKeptDraft, offersSaved, startNewVoucher, bodyProblems, canTakeStored, cashInHandIds, cashRuleProblem, creditPeriodText,
  detailSteps, differenceText, draftDirty, entryDateLabel, entryDateProblem, escapeStep, isBlankLine, isCompleteLine, kindTitles, layoutTitles, layoutsOf, ledgerOptions,
  lineKey, listEnd, minorOf, negativeCashWarning, parseEntryDate, particularsSide, particularsTotal, proposedAmount, readLayout, refusalPlace,
  isLocked, lockAlert, refusal, relayLines, savedNotes, writeLayout, type DraftState, type EntryFocus, type EntryKind, type EntryLayout, type EntryLine, type FocusOrigin,
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
  const [confirm, dialog, closeQuestion] = useConfirm()
  const navigate = useNavigate()
  const dirty = draftDirty(state) || typing || locked
  const leave = useLeave({ to: '/app/c/$companyId', params: { companyId: company.id } })
  const retryButton = useRef<HTMLButtonElement>(null)
  const savingSpot = useRef<HTMLElement>(null)
  /**
   * The leave question, by the draft's state (`askBeforeLeaving` in src/lib/voucher-entry/questions.ts): while a save is
   * on its way it is asked again, or not at all, once the answer arrives; a draft that may be in the books is kept here.
   */
  const askToLeave = useCallback(async () => {
    // Text still in a cell's editor is committed first, then what was entered decides (a guard call with nothing entered passes).
    grid.current?.commit()
    // Text the grid dropped as focus left the cell (it named no ledger) counts too: it was typed (the guard asks).
    const yes = await askBeforeLeaving(draft.current, draft.settled, () => typingRef.current, confirm, closeQuestion)
    // Kept: back to "Check and retry" when that is the way on, else where the cursor was (also after a link or a key outside the voucher).
    // Stayed (or the save's answer closed the question): back to "Check and retry" when that is the way on, to the next
    // voucher's first field after a save, else where the cursor was.
    if (!yes) window.setTimeout(() => {
      const { phase, draft: shown } = draft.current()
      if (phase === 'unknown') retryButton.current?.focus()
      else if (phase === 'editing' && !draftDirty(shown)) focus(firstField())
      else if (phase === 'editing') focus(afterDate(lastOrigin.current))
    }, 0)
    return yes
  }, [confirm])
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
  // Before the first paint, so keys typed as the screen appears land in its first field.
  useLayoutEffect(() => { focus(firstField()) }, [])
  // Where the cursor last was inside the voucher, for keys and bar buttons that take focus away (the date button, a question).
  const lastOrigin = useRef<FocusOrigin>({ field: 'account' })
  useEffect(() => {
    const holder = root.current
    if (!holder) return
    const inGrid = (node: EventTarget | null) => node instanceof Element && !!holder.querySelector('[role="grid"]')?.contains(node)
    /**
     * The bill panel's dialog gives focus back to a grid cell from its own close event, which the browser may deliver
     * after keys the user pressed meanwhile (Chrome serves input first). The cursor has moved on inside the accept key's
     * handler already, so that one return is undone: when the panel's dialog closes, the element focused at that moment
     * is kept, and the grid focus the close causes is hidden from the grid (these listeners sit below React's own, so it
     * keeps what is being typed) and sent back there. It applies to that close event only: no timer, no rule about keys.
     */
    let back: HTMLElement | null = null
    let returning = false
    const onClose = (event: Event) => {
      const dialog = event.target
      const active = document.activeElement
      // The grid's panel dialog: it keeps its (empty) panel holder, `<grid id>-panel`, after the panel's content has gone.
      const panelDialog = dialog instanceof HTMLDialogElement && holder.contains(dialog) && dialog.querySelector('[id$="-panel"]') !== null
      back = panelDialog && active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : null
      // The dialog's own close handler runs within this event; anything later is the user's again.
      window.setTimeout(() => { back = null }, 0)
    }
    const onBlur = (event: FocusEvent) => {
      if (returning || (back && event.target === back && inGrid(event.relatedTarget))) event.stopPropagation()
    }
    const onFocus = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const kept = back
      if (kept && kept !== target && kept.isConnected && inGrid(target)) {
        back = null
        event.stopPropagation()
        returning = true
        try { kept.focus() } finally { returning = false }
        return
      }
      const field = fieldOf(holder, target)
      if (field && field !== 'date') { lastOrigin.current = { field }; return }
      if (!holder.querySelector('[role="grid"]')?.contains(target)) return
      window.setTimeout(() => {
        const row = grid.current?.activeRow, column = grid.current?.activeColumn
        if (row && (column === 'side' || column === 'ledger' || column === 'amount')) lastOrigin.current = { cell: { row, column } }
      }, 0)
    }
    // `close` does not bubble: caught on the way down.
    document.addEventListener('close', onClose, true)
    holder.addEventListener('focusin', onFocus)
    holder.addEventListener('focusout', onBlur)
    return () => { document.removeEventListener('close', onClose, true); holder.removeEventListener('focusin', onFocus); holder.removeEventListener('focusout', onBlur) }
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
    if (context.column === 'amount' && needsBills(line)) {
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

  /** After a line's bills are accepted and the panel has closed: on at once, inside the accept key's handler. */
  function moveOnAfterBills(row: string) {
    if (lockedNow()) return
    flushSync(() => continueAfter(row))
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
        onAccept={rows => { edit({ type: 'bills', row: row.key, rows }) }} onClosed={() => moveOnAfterBills(row.key)} close={close} />
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
  /** Closes the date field and returns the cursor inside the key's own handler, so keys typed straight after land there. */
  function closeDate() {
    flushSync(() => { setDateText(null); setDateError(undefined) })
    flushSync(() => focus(afterDate(dateOrigin.current)))
  }
  function applyDate() {
    const parsed = parseEntryDate(dateRef.current ?? '', now().date)
    if ('error' in parsed) { setDateError(parsed.error); return }
    const problem = entryDateProblem(parsed.value, company, workingDate)
    if (problem) { setDateError(problem); return }
    let changed = false
    flushSync(() => { changed = edit({ type: 'date', date: parsed.value }) })
    if (!changed) return
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
    // Saving from the question: the cursor leaves the question (and its focused button) before it goes.
    if (promptHolder.current?.contains(document.activeElement)) savingSpot.current?.focus()
    setPrompt(false)
    const problem = problemBeforeSave()
    if (problem) { showProblem(problem); return }
    const sent = now()
    const expected = number
    // While the save runs, keys typed are not kept: the cursor waits on the "Saving…" line, which says so, never in a
    // read-only field; the next voucher's first field takes it as soon as the answer comes.
    savingSpot.current?.focus()
    const pending = draft.save(voucherType.id)
    if (pending) settle(await pending, sent, expected)
  }

  /** "Check and retry": the cursor waits on the "Saving…" line while the alert is away, and comes back with it. */
  async function retry() {
    const sent = now()
    const expected = number
    savingSpot.current?.focus()
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
      // Warning codes this screen does not know (a later slice's) are ignored, never a failure.
      const notes = savedNotes(warnings)
      // Rendered at once with the next voucher (same type, layout and date), the cursor on its first field (observed).
      flushSync(() => {
        setSaved(`Saved ${kindTitles[sent.kind].toLowerCase()} No. ${voucher.number ?? 'none'} dated ${longDate(voucher.date)}${differs}.${notes}`)
        setNotice('')
        setDateText(null); setDateError(undefined)
        setRefresh(value => value + 1)
      })
      flushSync(() => focus(firstField()))
      onWorkingDate(voucher.date)
      // The reports' cached last voucher date is stale now (the day book would open on the old day).
      forgetDefaults(company.id)
      return
    }
    // Editable again (a refusal, a limit, a denial): the cursor goes where the answer points, else back to the narration.
    if (result.kind !== 'refused' && result.kind !== 'limited' && result.kind !== 'denied') return
    if (draft.current().phase !== 'editing') return
    const place = result.kind === 'refused' ? refusalPlace(result.code) : 'alert'
    if (place !== 'date' && place !== 'difference' && place !== 'cash-rule' && place !== 'bills') focusSoon({ field: 'narration' })
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
    if (!(await startNewVoucher(draft.current, confirm, draft.discard, blankDraft(kind, layout, date)))) return
    // A new voucher: its expected number is read again.
    setTyping(false); setRefresh(value => value + 1); focusSoon(firstField())
  }
  function restoreKept() {
    if (!draft.restore()) return
    setSaved(''); setTyping(false)
    // A voucher whose outcome is unknown comes back locked, its alert's "Check and retry" taking the cursor (autoFocus).
    if (draft.current().phase === 'editing') focusSoon(firstField())
  }
  async function dropKept() {
    if (canTakeStored(draft.current()) || offersSaved(draft.current())) await dropKeptDraft(draft.current, confirm, draft.drop)
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
  // Claimed in every state, so classic Ctrl+A never selects the page; while the voucher is locked it does nothing.
  useAppCommand('entry.accept', () => { if (!lockedNow()) void save() }, { allowInTextInput: true })
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
  const savedNotice = kept?.phase === 'saved'
  const keptText = !kept ? '' : `${kept.phase === 'editing' ? 'The unsaved' : 'A'} ${kindTitles[kept.draft.kind].toLowerCase()} dated ${longDate(kept.draft.date)}, kept at ${new Date(kept.savedAt).toLocaleTimeString()}${kept.phase === 'unknown' ? ', got no definite answer to its save: it may already be in the books. Restore it to check and retry under its own key.' : kept.phase === 'conflict' ? ', was not saved: its key is already used by a voucher with other content.' : ', is kept in this tab.'}`
  const summary = `${title} dated ${longDate(state.date)}${state.layout === 'single' ? `, ${amountText(total, exponent)} ${state.kind === 'payment' ? 'from' : 'into'} ${ledgerById.get(state.account)?.name ?? 'the account'}` : ''}, ${bodyLines(state, exponent).length} lines.`

  return <Stack gap={5} ref={root}>
    <PageHeader eyebrow={`Voucher entry · ${layoutTitles[state.layout]}`} title={title}
      description={`${number === null ? 'Number to be given on saving' : `No. ${number} (expected)`} · ${entryDateLabel(state.date)}`} />
    {kept && savedNotice && <Alert tone='success' title='A voucher was saved after its screen was left'
      actions={<Button size='sm' variant='secondary' disabled={!offersSaved(draft.machine)} onClick={() => void dropKept()}>Dismiss</Button>}>
      The {kindTitles[kept.draft.kind].toLowerCase()} dated {longDate(kept.draft.date)} was saved ({kept.message}); its answer arrived after the screen was left, so there is nothing to retry.
    </Alert>}
    {kept && !savedNotice && <Alert tone='info' title={kept.phase === 'editing' ? 'A voucher was being entered before you signed in again' : kept.phase === 'conflict' ? 'A voucher that was not saved is kept in this tab' : 'A voucher whose save is not settled is kept in this tab'}
      actions={<Inline gap={2}><Button size='sm' disabled={!canTake} onClick={restoreKept}>Restore it</Button><Button size='sm' variant='secondary' disabled={!canTake} onClick={() => void dropKept()}>Discard it</Button></Inline>}>
      {keptText}{canTake ? '' : ' Save or leave the voucher on screen first: a kept voucher can be restored or discarded only while the one on screen is empty.'}
    </Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    {alert?.phase === 'unknown' && <Alert tone='danger' title='Not known whether it was saved'
      actions={<Inline gap={2}><Button ref={retryButton} size='sm' autoFocus onClick={() => void retry()}>Check and retry</Button><Button size='sm' variant='secondary' onClick={() => void cancel()}>Leave</Button></Inline>}>
      No definite answer came ({alert.message}), so this voucher may or may not be in the books. Check and retry sends the same voucher under the same key: the server saves it once, or answers that it already has it.
      {alert.note && ` The last retry was answered "${alert.note}", which says nothing about the first send, so it stays as it is.`}
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
    {/* The cursor's place while a save runs: named, not editable, so keys typed then are visibly not kept anywhere. */}
    <Stack ref={savingSpot} tabIndex={-1} aria-label={draft.busy ? `Saving the ${title.toLowerCase()}; keys typed now are not kept` : undefined}>
      <StatusLine live='polite' busy={draft.busy}>{draft.busy ? 'Saving…' : announced || ' '}</StatusLine>
    </Stack>
    <TypeList open={typeList} current={state.kind} onPick={switchType} onClose={() => setTypeList(false)} />
    {layoutsOf(state.kind).length > 1 && <ModeList open={modeList} current={state.layout} onPick={switchLayout} onClose={() => setModeList(false)} />}
    <DialogKeys name='Confirm' open={!!dialog}>{dialog}</DialogKeys>
  </Stack>
}
