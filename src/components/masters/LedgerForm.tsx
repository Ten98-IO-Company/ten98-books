import { Alert, Button, Card, Combobox, DescriptionList, Field, Form, FormActions, Input, KeyHint, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useApp, useCompany } from '../../lib/app-context'
import type { TrialBalance } from '../../lib/ledger'
import {
  displayAmount, effectiveSide, emptyLedgerForm, groupChoices, groupPath, ledgerDeleteReason, ledgerFormOf, ledgerFormReducer, ledgerGroupReason, ledgerPayload,
  natureSingular, openingLocked, sideTitles, validateLedgerForm, type LedgerField, type LedgerRow, isolate } from '../../lib/masters'
import type { Wire } from '../../lib/money'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { EntryScope, FailureAlert, focusEntryField, focusFirstInvalid, SaveConfirm, useEntryCommands, useLeave, useMasterRequest } from './entry'
import { rememberGroup, setFlash } from './flash'
import type { MasterFormProps } from './GroupForm'

const sideChoices = [{ value: 'Dr', label: `Dr · ${sideTitles.Dr}` }, { value: 'Cr', label: `Cr · ${sideTitles.Cr}` }]

/** Create ledger and alter ledger: the group, an opening balance with its side, and a running total of the openings. */
export function LedgerForm(props: MasterFormProps<LedgerRow>) {
  return <EntryScope><LedgerFormBody {...props} /></EntryScope>
}

type OpeningTotals = Wire<TrialBalance>

/** The company's opening balances in total and their difference, from the trial balance (screens never add balances themselves). */
function useOpeningTotals(companyId: string, booksBeginning: string) {
  const [totals, setTotals] = useState<OpeningTotals | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const reload = useCallback(() => {
    api<{ trialBalance: OpeningTotals }>(`/api/companies/${companyId}/trial-balance?from=${booksBeginning}&to=${booksBeginning}`)
      .then(result => { setTotals(result.trialBalance); setUnavailable(false) }).catch(() => setUnavailable(true))
  }, [companyId, booksBeginning])
  useEffect(reload, [reload])
  return { totals, unavailable, reload }
}

function LedgerFormBody({ groups, existing, initialGroupId, reloadData }: MasterFormProps<LedgerRow>) {
  const company = useCompany()
  const { workspace } = useApp()
  const navigate = useNavigate()
  const exponent = company.currencyMinorUnits as MoneyExponent
  const readOnly = workspace.role === 'viewer'
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
  const leave = useLeave({ to: '/app/c/$companyId/masters/chart-of-accounts', params: { companyId: company.id } })

  const outsideGroups = existing?.systemKey === 'profit_and_loss'
  const locked = openingLocked(company)
  const groupOptions = useMemo(() => groupChoices(groups, { reason: candidate => ledgerGroupReason(existing ?? null, candidate, groups) }), [groups, existing])
  const deleteReason = existing ? ledgerDeleteReason(existing) : null
  const group = groups.find(item => item.id === values.groupId)
  const side = effectiveSide(values, groups)
  const dirty = JSON.stringify(values) !== JSON.stringify(initial.current)
  const where = group ? groupPath(groups, group.id).join(' › ') : 'no group'

  async function save() {
    if (readOnly || busy) return
    const found = validateLedgerForm(values, exponent, outsideGroups)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return }
    const body = ledgerPayload(values, groups, exponent, existing?.revision)
    const result = await run(() => api<{ ledger: LedgerRow }>(existing ? `/api/companies/${company.id}/ledgers/${existing.id}` : `/api/companies/${company.id}/ledgers`, { method: 'POST', body }))
    if (!result) return
    const ledger = result.ledger
    const opening = ledger.opening.amount.replace(/[0.]/g, '') === '' ? '' : ` with an opening balance of ${displayAmount(ledger.opening.amount, exponent)} ${ledger.opening.side}`
    const message = `Saved ledger “${ledger.name}”${ledger.groupId ? ` under ${groupPath(groups, ledger.groupId).join(' › ')}` : ''}${opening}.`
    if (existing) { setFlash(message); leave(); return }
    rememberGroup(company.id, values.groupId)
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
    if (readOnly) return
    const found = validateLedgerForm(values, exponent, outsideGroups)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return }
    setConfirming(true)
  }
  const summary = () => `“${values.name.trim()}” under ${where}. ${values.amount.trim() === '' ? 'No opening balance' : `Opening balance ${displayAmount(values.amount.trim(), exponent)} ${side}`}.`

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
    form, onLastField: () => void askToSave(), onAccept: () => void save(), onCancel: () => void cancel(),
    onDelete: existing && !readOnly && !deleteReason ? () => void remove() : undefined,
    onHistory: existing ? () => void navigate({ to: '/app/c/$companyId/masters/history/ledger/$ledgerId', params: { companyId: company.id, ledgerId: existing.id } }) : undefined,
  })

  const set = (field: 'name' | 'secondLanguageName' | 'amount') => (event: { target: { value: string } }) => dispatch({ type: 'set', field, value: event.target.value })
  const lockNote = `Opening balances are locked: the books are locked through ${company.lockedThrough}.`
  return <Stack gap={6}>
    <PageHeader eyebrow='Masters' title={existing ? <>Alter ledger {isolate(existing.name)}</> : 'Create ledger'}
      description={existing ? 'Change the ledger, then press Enter on the last field to save.' : 'Fill in the fields in order and press Enter after each. The form is ready for the next ledger after every save, with the group kept.'} />
    {readOnly && <Alert tone='info'>Viewers can read the chart but not change it.</Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    <FailureAlert failure={failure} onReload={reloadData} />
    {confirming && <SaveConfirm title={existing ? 'Save the changes?' : 'Save this ledger?'} description={summary()}
      onConfirm={() => { setConfirming(false); void save() }} onCancel={keepEditing} />}
    <Form ref={form} onSubmit={() => undefined} busy={busy} gap={4} fieldErrors={errors} aria-label={existing ? 'Alter ledger' : 'Create ledger'}>
      <Stack data-entry-field='name'>
        <Field label='Name' error={errors.name} required><Input value={values.name} onChange={set('name')} maxLength={120} autoComplete='off' autoFocus disabled={readOnly} /></Field>
      </Stack>
      <Stack data-entry-field='secondLanguageName'>
        <Field label='Name in a second language' description='Optional, for example the Arabic name.' error={errors.secondLanguageName}>
          <Input value={values.secondLanguageName} onChange={set('secondLanguageName')} maxLength={120} dir='auto' autoComplete='off' disabled={readOnly} />
        </Field>
      </Stack>
      <Stack data-entry-field='groupId'>
        <Combobox allowCustom={false} label='Group' options={groupOptions} value={values.groupId} disabled={readOnly || outsideGroups} required={!outsideGroups} error={errors.groupId}
          description={outsideGroups ? 'The profit and loss ledger stays outside every group.' : group ? `Nature: ${natureSingular[group.nature]}. New balances default to ${group.nature === 'liability' || group.nature === 'income' ? 'credit' : 'debit'}.` : 'Type to filter. Each group shows where it sits.'}
          placeholder='Choose a group' emptyMessage='No group matches.'
          onValueChange={value => dispatch({ type: 'set', field: 'groupId', value })} />
      </Stack>
      <Stack data-entry-field='amount'>
        <Field label='Opening balance' description={locked ? lockNote : `Optional, as of ${company.booksBeginning}, in ${company.baseCurrency} with ${exponent} decimal places.`} error={errors.amount}>
          <Input value={values.amount} onChange={set('amount')} inputMode='decimal' autoComplete='off' placeholder={exponent === 0 ? '0' : `0.${'0'.repeat(exponent)}`} disabled={readOnly || locked} />
        </Field>
      </Stack>
      <Stack data-entry-field='side'>
        <Combobox allowCustom={false} label='Debit or credit' options={sideChoices} value={side} disabled={readOnly || locked} error={errors.side}
          description='Follows the group’s nature until you choose.' onValueChange={value => dispatch({ type: 'side', value: value === 'Cr' ? 'Cr' : 'Dr' })} />
      </Stack>
      {existing && deleteReason && <Text tone='muted' size='sm'>Delete is unavailable: {deleteReason}</Text>}
      <FormActions>
        {!readOnly && <Button type='button' onClick={() => void save()} disabled={busy}>Save <KeyHint command='entry.accept' /></Button>}
        <Button type='button' variant='secondary' onClick={() => void cancel()}>{readOnly ? 'Back' : 'Leave'} <KeyHint command='entry.cancel' /></Button>
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
