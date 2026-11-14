import { Alert, Button, Card, DescriptionList, Field, Form, FormActions, Input, KeyHint, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { api } from '../../lib/api'
import { useCompany } from '../../lib/app-context'
import type { Side, TrialBalance } from '../../lib/ledger'
import {
  amountExample, displayAmount, effectiveSide, emptyLedgerForm, groupChoices, groupPath, isolate, ledgerDeleteReason, ledgerFormOf, ledgerFormReducer, ledgerGroupReason,
  ledgerPayload, natureSingular, openingLocked, plainAmount, resolveLookup, sideTitles, validateLedgerForm, type Choice, type LedgerField, type LedgerFormAction, type LedgerFormValues, type LedgerRow,
} from '../../lib/masters'
import type { Wire } from '../../lib/money'
import { EntryScope, entryText, FailureAlert, focusEntryField, focusFirstInvalid, nextEntryField, SaveConfirm, useEntryCommands, useLeave, useMasterRequest } from './entry'
import { rememberGroup, setFlash } from './flash'
import type { MasterFormProps } from './GroupForm'
import { LookupField } from './LookupField'
import { useCanWrite } from './useCanWrite'

const sideChoices: Choice[] = [{ value: 'Dr', label: `Dr · ${sideTitles.Dr}` }, { value: 'Cr', label: `Cr · ${sideTitles.Cr}` }]

type LookupName = 'groupId' | 'side'
const lookupOrder: readonly LookupName[] = ['groupId', 'side']

/** Create ledger and alter ledger: the group, an opening balance with its side, and a running total of the openings. */
export function LedgerForm(props: MasterFormProps<LedgerRow>) {
  return <EntryScope><LedgerFormBody {...props} /></EntryScope>
}

type OpeningTotals = Wire<TrialBalance>

/** The company's opening balances in total and their difference, from the trial balance (screens never add balances themselves). */
function useOpeningTotals(companyId: string, booksBeginning: string) {
  const [totals, setTotals] = useState<OpeningTotals | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    // Totals of another company must never show for this one: clear them, and ignore an answer that arrives late.
    const controller = new AbortController()
    setTotals(null); setUnavailable(false)
    api<{ trialBalance: OpeningTotals }>(`/api/companies/${companyId}/trial-balance?from=${booksBeginning}&to=${booksBeginning}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setTotals(result.trialBalance) })
      .catch(() => { if (!controller.signal.aborted) setUnavailable(true) })
    return () => controller.abort()
  }, [companyId, booksBeginning, attempt])
  const reload = useCallback(() => setAttempt(value => value + 1), [])
  return { totals, unavailable, reload }
}

function LedgerFormBody({ groups, existing, initialGroupId, reloadData }: MasterFormProps<LedgerRow>) {
  const company = useCompany()
  const navigate = useNavigate()
  const exponent = company.currencyMinorUnits as MoneyExponent
  // The screens that render this form wait for the role, so it is known here; anything but a writer reads only.
  const readOnly = !useCanWrite()
  const form = useRef<HTMLFormElement>(null)
  const [values, dispatch] = useReducer(ledgerFormReducer, undefined, () => existing ? ledgerFormOf(existing) : emptyLedgerForm(initialGroupId ?? ''))
  const initial = useRef(values)
  const [errors, setErrors] = useState<Partial<Record<LedgerField, string>>>({})
  const [saved, setSaved] = useState('')
  const [confirming, setConfirming] = useState(false)
  // The form locks its fields while a request runs; focus returns to Name once it lifts, ready for the next entry.
  const refocus = useRef(false)
  const { busy, failure, run } = useMasterRequest()
  const [confirm, dialog] = useConfirmDialog()
  const openings = useOpeningTotals(company.id, company.booksBeginning)
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; focusEntryField(form.current, 'name') } }, [busy])
  // A name another master already has is an error on the Name field, found by the server's code.
  useEffect(() => {
    if (failure?.code !== 'duplicate_name') return
    setErrors(previous => ({ ...previous, name: failure.message }))
    focusEntryField(form.current, 'name')
  }, [failure])
  const leave = useLeave({ to: '/app/c/$companyId/masters/chart-of-accounts', params: { companyId: company.id } })

  const outsideGroups = existing?.systemKey === 'profit_and_loss'
  const locked = openingLocked(company)
  const groupOptions = useMemo(() => groupChoices(groups, { reason: candidate => ledgerGroupReason(existing ?? null, candidate, groups) }), [groups, existing])
  const groupIds = useMemo(() => new Set(groupOptions.filter(choice => !choice.disabled).map(choice => choice.value)), [groupOptions])
  const deleteReason = existing ? ledgerDeleteReason(existing) : null
  const group = groups.find(item => item.id === values.groupId)
  const side = effectiveSide(values, groups)
  // A new entry is dirty once something is typed (the kept group after a save is not an edit); an alter once it differs.
  const dirty = existing ? JSON.stringify(values) !== JSON.stringify(initial.current) : values.name.trim() !== '' || values.secondLanguageName.trim() !== '' || values.amount.trim() !== ''
  const where = group ? groupPath(groups, group.id).join(' › ') : 'no group'

  const lookups: Record<LookupName, { options: Choice[]; current: (from: LedgerFormValues) => string; actions: (value: string) => LedgerFormAction[]; blank: string }> = {
    groupId: { options: groupOptions, current: from => from.groupId, actions: value => [{ type: 'set', field: 'groupId', value }], blank: 'Choose the group this ledger belongs to.' },
    side: { options: sideChoices, current: from => effectiveSide(from, groups), actions: value => [{ type: 'side', value: value as Side }], blank: 'Choose Dr or Cr.' },
  }

  /** Applies what was typed in one lookup to `from`: its single matching choice, or an error on that field (null). */
  function settle(field: LookupName, text: string, from: LedgerFormValues): LedgerFormValues | null {
    const lookup = lookups[field]
    const result = resolveLookup(lookup.options, text, lookup.current(from))
    const error = 'error' in result ? result.error : result.value === '' ? lookup.blank : ''
    if (error) { setErrors(previous => ({ ...previous, [field]: error })); return null }
    setErrors(previous => ({ ...previous, [field]: undefined }))
    if ('error' in result || result.value === lookup.current(from)) return from
    let next = from
    for (const action of lookup.actions(result.value)) { next = ledgerFormReducer(next, action); dispatch(action) }
    return next
  }

  /** Typed lookup text with no row highlighted, on Enter or the accept chord: pick the one choice it names or show the error here. */
  function typedEnter(field: LookupName, text: string, advance: boolean): 'picked' | 'error' | 'unchanged' {
    const lookup = lookups[field]
    const result = resolveLookup(lookup.options, text, lookup.current(values))
    if ('value' in result && result.value === lookup.current(values)) return 'unchanged'
    if (!settle(field, text, values)) return 'error'
    // On Enter a pick moves on, as after a highlighted row, once the new value is on screen.
    if (advance) window.setTimeout(() => { const next = nextEntryField(form.current, field); if (next === 'confirm') askToSave(); else focusEntryField(form.current, next) }, 0)
    return 'picked'
  }

  /** The form as it will be saved: every lookup settled from the text on screen and every field checked, or null with the problem shown. */
  function prepare(): LedgerFormValues | null {
    let next = values
    for (const field of lookupOrder) {
      const text = entryText(form.current, field)
      if (text === null || (field === 'groupId' && outsideGroups)) continue
      const settled = settle(field, text, next)
      if (!settled) { focusEntryField(form.current, field); return null }
      next = settled
    }
    const found = validateLedgerForm(next, exponent, groupIds, outsideGroups)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return null }
    return next
  }

  async function save() {
    if (readOnly) return
    const ready = prepare()
    if (!ready) return
    const body = ledgerPayload(ready, groups, exponent, existing?.revision)
    const result = await run(() => api<{ ledger: LedgerRow }>(existing ? `/api/companies/${company.id}/ledgers/${existing.id}` : `/api/companies/${company.id}/ledgers`, { method: 'POST', body }))
    if (!result) return
    const done = result.ledger
    const opening = done.opening.amount.replace(/[0.]/g, '') === '' ? '' : ` with an opening balance of ${displayAmount(done.opening.amount, exponent)} ${done.opening.side}`
    const message = `Saved ledger “${done.name}”${done.groupId ? ` under ${groupPath(groups, done.groupId).join(' › ')}` : ''}${opening}.`
    if (existing) { setFlash(message); leave(); return }
    rememberGroup(company.id, ready.groupId)
    setSaved(message)
    dispatch({ type: 'saved' })
    reloadData(); openings.reload()
    refocus.current = true
  }

  async function remove() {
    if (!existing || readOnly || deleteReason) return
    if (!await confirm({ title: `Delete the ledger “${existing.name}”?`, description: 'The ledger is removed from the chart. Its history stays available. A ledger used in vouchers cannot be deleted.', confirmLabel: 'Delete ledger', danger: true })) return
    const done = await run(() => api(`/api/companies/${company.id}/ledgers/${existing.id}/delete`, { method: 'POST', body: { revision: existing.revision } }))
    if (done) { setFlash(`Deleted ledger “${existing.name}”.`); leave() }
  }

  function askToSave() {
    if (readOnly || !prepare()) return
    setConfirming(true)
  }

  function keepEditing() {
    setConfirming(false)
    focusEntryField(form.current, 'side')
  }

  async function cancel() {
    if (confirming) { keepEditing(); return }
    if (dirty && !readOnly && !await confirm({ title: 'Leave without saving?', description: 'What you entered on this screen is not saved.', confirmLabel: 'Leave', cancelLabel: 'Keep editing' })) return
    leave()
  }

  useEntryCommands({
    form, readOnly,
    onLeaveField: (name, text) => name in lookups ? settle(name as LookupName, text, values) !== null : true,
    onLastField: askToSave, onAccept: () => void save(), onCancel: () => void cancel(),
    onDelete: existing && !readOnly && !deleteReason ? () => void remove() : undefined,
    onHistory: existing ? () => void navigate({ to: '/app/c/$companyId/masters/history/ledger/$ledgerId', params: { companyId: company.id, ledgerId: existing.id } }) : undefined,
  })

  const set = (field: 'name' | 'secondLanguageName' | 'amount') => (event: { target: { value: string } }) => dispatch({ type: 'set', field, value: event.target.value })
  const choose = (field: LookupName) => (value: string) => { for (const action of lookups[field].actions(value)) dispatch(action); setErrors(previous => ({ ...previous, [field]: undefined })) }
  const lockNote = `Opening balances are locked: the books are locked through ${company.lockedThrough}.`
  const summary = () => {
    const amount = plainAmount(values.amount)
    return `“${values.name.trim()}” under ${where}. ${amount === '' ? 'No opening balance' : `Opening balance ${displayAmount(amount, exponent)} ${side}`}.`
  }
  return <Stack gap={6}>
    <PageHeader eyebrow='Masters' title={existing ? <>Alter ledger {isolate(existing.name)}</> : 'Create ledger'}
      description={readOnly ? 'How this ledger is set up. Changing it needs an owner, admin or editor; its history is open to you.'
        : existing ? 'Change the ledger, then press Enter on the last field to save.' : 'Fill in the fields in order and press Enter after each. The form is ready for the next ledger after every save, with the group kept.'} />
    {readOnly && <Alert tone='info'>Viewers can read the chart but not change it.</Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    <FailureAlert failure={failure?.code === 'duplicate_name' ? null : failure} onReload={reloadData} />
    {confirming && <SaveConfirm title={existing ? 'Save the changes?' : 'Save this ledger?'} description={summary()} onConfirm={() => { setConfirming(false); void save() }} onCancel={keepEditing} />}
    <Form ref={form} onSubmit={() => undefined} busy={busy} gap={4} fieldErrors={errors} aria-label={existing ? 'Alter ledger' : 'Create ledger'}>
      <Stack data-entry-field='name'>
        <Field label='Name' error={errors.name} required><Input value={values.name} onChange={set('name')} maxLength={120} autoComplete='off' autoFocus={!readOnly} disabled={readOnly} /></Field>
      </Stack>
      <Stack data-entry-field='secondLanguageName'>
        <Field label='Name in a second language' description='Optional, for example the Arabic name.' error={errors.secondLanguageName}>
          <Input value={values.secondLanguageName} onChange={set('secondLanguageName')} maxLength={120} dir='auto' autoComplete='off' disabled={readOnly} />
        </Field>
      </Stack>
      <Stack data-entry-field='groupId'>
        <LookupField label='Group' options={groupOptions} value={values.groupId} disabled={readOnly || outsideGroups} required={!outsideGroups} error={errors.groupId}
          description={outsideGroups ? 'The profit and loss ledger stays outside every group.' : group ? `Nature: ${natureSingular[group.nature]}. New balances default to ${group.nature === 'liability' || group.nature === 'income' ? 'credit' : 'debit'}.` : 'Type to filter. Each group shows where it sits.'}
          placeholder='Choose a group' emptyMessage='No group matches.' onValueChange={choose('groupId')} onTypedEnter={(text, advance) => typedEnter('groupId', text, advance)} />
      </Stack>
      <Stack data-entry-field='amount'>
        <Field label='Opening balance' description={locked ? lockNote : `Optional, as of ${company.booksBeginning}, in ${company.baseCurrency}, for example ${amountExample(exponent)}.`} error={errors.amount}>
          <Input value={values.amount} onChange={set('amount')} inputMode='decimal' autoComplete='off' dir='ltr' placeholder={exponent === 0 ? '0' : `0.${'0'.repeat(exponent)}`} disabled={readOnly || locked} />
        </Field>
      </Stack>
      <Stack data-entry-field='side'>
        <LookupField label='Debit or credit' options={sideChoices} value={side} disabled={readOnly || locked} error={errors.side}
          description='Follows the group’s nature until you choose.' onValueChange={choose('side')} onTypedEnter={(text, advance) => typedEnter('side', text, advance)} />
      </Stack>
      {existing && !readOnly && deleteReason && <Text tone='muted' size='sm'>Delete is unavailable: {deleteReason}</Text>}
      <FormActions>
        {!readOnly && <Button type='button' onClick={() => void save()} disabled={busy}>Save <KeyHint command='entry.accept' /></Button>}
        <Button type='button' variant='secondary' autoFocus={readOnly} onClick={() => void cancel()}>{readOnly ? 'Back' : 'Leave'} <KeyHint command='entry.cancel' /></Button>
        {existing && !readOnly && !deleteReason && <Button type='button' variant='danger' onClick={() => void remove()} disabled={busy}>Delete <KeyHint command='entry.delete' /></Button>}
      </FormActions>
    </Form>
    <Card title='Opening balances of the company' description='Every ledger’s opening balance added up by the books. They may differ while you set up; saving is never blocked by it.' headingLevel={2}>
      {openings.totals
        ? <DescriptionList items={[
          { term: 'Total debit', description: displayAmount(openings.totals.totals.openingDebit, exponent) },
          { term: 'Total credit', description: displayAmount(openings.totals.totals.openingCredit, exponent) },
          { term: 'Difference', description: openings.totals.openingDifference.side === null ? 'None, the openings balance' : `${displayAmount(openings.totals.openingDifference.amount, exponent)} ${openings.totals.openingDifference.side}` },
        ]} />
        : <Text tone='muted'>{openings.unavailable ? 'The totals could not be loaded.' : 'Loading the totals…'}</Text>}
    </Card>
    {dialog}
  </Stack>
}
