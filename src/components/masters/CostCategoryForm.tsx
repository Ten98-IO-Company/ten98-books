import { Alert, Button, Field, Form, FormActions, Input, KeyHint, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { DialogKeys, useAriaKeys } from '../KeyboardShell'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useReducer, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useCompany } from '../../lib/app-context'
import {
  categoryDeleteReason, categoryFormOf, categoryUseLabels, categoryFormReducer, categoryPayload, emptyCategoryForm, validateCategoryForm,
  type CategoryField, type CategoryFormAction, type CategoryFormValues, type CostCategoryRow,
} from '../../lib/cost-centre-forms'
import { yesNo } from '../../lib/lookup-entry'
import { isolate } from '../../lib/masters'
import { EntryScope, FailureAlert, focusEntryField, focusFirstInvalid, nextEntryField, SaveConfirm, useEntryCommands, useLeave, useLeaveGuard, useMasterRequest } from './entry'
import { setFlash } from './flash'
import { LookupField } from './LookupField'
import { useCanWrite } from './useCanWrite'
import { useEntryLookups, type LookupSpec } from './useEntryLookups'

type LookupName = 'allocateRevenue' | 'allocateNonRevenue'
const lookupOrder: readonly LookupName[] = ['allocateRevenue', 'allocateNonRevenue']

const flagSpec = (field: LookupName, blank: string): LookupSpec<CategoryFormValues, CategoryFormAction> => ({
  options: yesNo, current: from => from[field] ? 'yes' : 'no', actions: value => [{ type: 'flag', field, value: value === 'yes' }], blank,
})

/** Create cost category and alter cost category: a name, an optional second-language name and the two allocation settings. */
export function CostCategoryForm(props: { existing?: CostCategoryRow; reloadData: () => void }) {
  return <EntryScope><CostCategoryFormBody {...props} /></EntryScope>
}

function CostCategoryFormBody({ existing, reloadData }: { existing?: CostCategoryRow; reloadData: () => void }) {
  const company = useCompany()
  const navigate = useNavigate()
  // The screens that render this form wait for the role, so it is known here; anything but a writer reads only.
  const readOnly = !useCanWrite()
  const form = useRef<HTMLFormElement>(null)
  const [values, dispatch] = useReducer(categoryFormReducer, undefined, () => existing ? categoryFormOf(existing) : emptyCategoryForm())
  const initial = useRef(values)
  const [errors, setErrors] = useState<Partial<Record<CategoryField, string>>>({})
  const [saved, setSaved] = useState('')
  const [confirming, setConfirming] = useState(false)
  // The form locks its fields while a request runs; focus returns to Name once it lifts, ready for the next entry.
  const refocus = useRef(false)
  const { busy, failure, run } = useMasterRequest()
  const [confirm, dialog] = useConfirmDialog()
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; focusEntryField(form.current, 'name') } }, [busy])
  // A name another category already has is an error on the Name field, found by the server's code.
  useEffect(() => {
    if (failure?.code !== 'duplicate_name') return
    setErrors(previous => ({ ...previous, name: failure.message }))
    focusEntryField(form.current, 'name')
  }, [failure])
  const leave = useLeave({ to: '/app/c/$companyId/masters/cost-centres', params: { companyId: company.id } })

  const deleteReason = existing ? categoryDeleteReason(existing) : null
  // A new entry is dirty once something is typed (the kept settings after a save are not an edit); an alter once it differs.
  const dirty = existing ? JSON.stringify(values) !== JSON.stringify(initial.current) : values.name.trim() !== '' || values.secondLanguageName.trim() !== ''
  const guard = useLeaveGuard(dirty && !readOnly, () => confirm({ title: 'Leave without saving?', description: 'What you entered on this screen is not saved.', confirmLabel: 'Leave', cancelLabel: 'Keep editing', initialFocus: 'cancel' }))
  const acceptKeys = useAriaKeys('entry.accept'), deleteKeys = useAriaKeys('entry.delete')

  const specs: Record<LookupName, LookupSpec<CategoryFormValues, CategoryFormAction>> = {
    allocateRevenue: flagSpec('allocateRevenue', 'Choose Yes or No.'),
    allocateNonRevenue: flagSpec('allocateNonRevenue', 'Choose Yes or No.'),
  }
  const lookups = useEntryLookups({
    form, values, reduce: categoryFormReducer, dispatch, specs, order: lookupOrder, setErrors,
    advance: field => { const next = nextEntryField(form.current, field); if (next === 'confirm') askToSave(); else focusEntryField(form.current, next) },
  })

  /** The form as it will be saved: every lookup settled from the text on screen and every field checked, or null with the problem shown. */
  function prepare(): CategoryFormValues | null {
    const settled = lookups.settleAll()
    if (!settled) return null
    const found = validateCategoryForm(settled)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return null }
    return settled
  }

  async function save() {
    if (readOnly) return
    const ready = prepare()
    if (!ready) return
    const result = await run(() => api<{ costCategory: CostCategoryRow }>(existing ? `/api/companies/${company.id}/cost-categories/${existing.id}` : `/api/companies/${company.id}/cost-categories`,
      { method: 'POST', body: categoryPayload(ready, existing?.revision) }))
    if (!result) return
    const message = `Saved cost category “${result.costCategory.name}”.`
    if (existing) { setFlash(message); guard.pass(leave); return }
    setSaved(message)
    dispatch({ type: 'saved' })
    reloadData()
    refocus.current = true
  }

  async function remove() {
    if (!existing || readOnly || deleteReason) return
    if (!await confirm({ title: `Delete the cost category “${existing.name}”?`, description: 'The category is removed. Its history stays available. A category that holds cost centres or is used in vouchers cannot be deleted.', confirmLabel: 'Delete category', danger: true, initialFocus: 'cancel' })) return
    const done = await run(() => api(`/api/companies/${company.id}/cost-categories/${existing.id}/delete`, { method: 'POST', body: { revision: existing.revision } }))
    if (done) { setFlash(`Deleted cost category “${existing.name}”.`); guard.pass(leave) }
  }

  function askToSave() {
    if (readOnly || !prepare()) return
    setConfirming(true)
  }

  function keepEditing() {
    setConfirming(false)
    focusEntryField(form.current, 'allocateNonRevenue')
  }

  async function cancel() {
    if (confirming) { keepEditing(); return }
    // Asks first when something was typed, before the address changes.
    await guard.leave(leave)
  }

  useEntryCommands({
    form, readOnly,
    onLeaveField: (name, text) => lookups.isLookup(name) ? lookups.settle(name, text, values) !== null : true,
    onLastField: askToSave, onAccept: () => void save(), onCancel: () => void cancel(),
    onDelete: existing && !readOnly && !deleteReason ? () => void remove() : undefined,
    onHistory: existing ? () => void navigate({ to: '/app/c/$companyId/masters/history/cost-category/$categoryId', params: { companyId: company.id, categoryId: existing.id } }) : undefined,
  })

  const set = (field: 'name' | 'secondLanguageName') => (event: { target: { value: string } }) => dispatch({ type: 'set', field, value: event.target.value })
  const choose = (field: LookupName) => (value: string) => { dispatch({ type: 'flag', field, value: value === 'yes' }); setErrors(previous => ({ ...previous, [field]: undefined })) }
  return <Stack gap={6}>
    <PageHeader eyebrow='Masters' title={existing ? <>Alter cost category {isolate(existing.name)}</> : 'Create cost category'}
      description={readOnly ? 'How this cost category is set up. Changing it needs an owner, admin or editor; its history is open to you.'
        : existing ? 'Change the category, then press Enter on the last field to save.' : 'Fill in the fields in order and press Enter after each. The form is ready for the next category after every save.'} />
    {readOnly && <Alert tone='info'>Viewers can read cost categories but not change them.</Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    <FailureAlert failure={failure?.code === 'duplicate_name' ? null : failure} onReload={reloadData} />
    {confirming && <SaveConfirm title={existing ? 'Save the changes?' : 'Save this cost category?'} description={`“${values.name.trim()}”.`}
      onConfirm={() => { setConfirming(false); void save() }} onCancel={keepEditing} />}
    <Form ref={form} onSubmit={() => undefined} busy={busy} gap={4} fieldErrors={errors} aria-label={existing ? 'Alter cost category' : 'Create cost category'}>
      <Stack data-entry-field='name'>
        <Field label='Name' error={errors.name} required><Input value={values.name} onChange={set('name')} maxLength={120} autoComplete='off' autoFocus={!readOnly} disabled={readOnly} /></Field>
      </Stack>
      <Stack data-entry-field='secondLanguageName'>
        <Field label='Name in a second language' description='Optional, for example the Arabic name.' error={errors.secondLanguageName}>
          <Input value={values.secondLanguageName} onChange={set('secondLanguageName')} maxLength={120} dir='auto' autoComplete='off' disabled={readOnly} />
        </Field>
      </Stack>
      <Stack data-entry-field='allocateRevenue'>
        <LookupField label={categoryUseLabels.allocateRevenue} options={yesNo} value={values.allocateRevenue ? 'yes' : 'no'} disabled={readOnly} error={errors.allocateRevenue}
          description='Whether the centres of this category can be allocated on income and expense ledgers. Saved with the category; vouchers do not check it yet.'
          onValueChange={choose('allocateRevenue')} onTypedEnter={(text, advance) => lookups.typedEnter('allocateRevenue', text, advance)} />
      </Stack>
      <Stack data-entry-field='allocateNonRevenue'>
        <LookupField label={categoryUseLabels.allocateNonRevenue} options={yesNo} value={values.allocateNonRevenue ? 'yes' : 'no'} disabled={readOnly} error={errors.allocateNonRevenue}
          description='The same for balance-sheet ledgers, such as assets and liabilities. Saved with the category; vouchers do not check it yet.'
          onValueChange={choose('allocateNonRevenue')} onTypedEnter={(text, advance) => lookups.typedEnter('allocateNonRevenue', text, advance)} />
      </Stack>
      {existing && !readOnly && deleteReason && <Text tone='muted' size='sm'>Delete is unavailable: {deleteReason}</Text>}
      <FormActions>
        {!readOnly && <Button type='button' onClick={() => void save()} disabled={busy} aria-keyshortcuts={acceptKeys}>Save <KeyHint command='entry.accept' /></Button>}
        <Button type='button' variant='secondary' autoFocus={readOnly} onClick={() => void cancel()}>{readOnly ? 'Back' : 'Leave'} <KeyHint command='entry.cancel' /></Button>
        {existing && !readOnly && !deleteReason && <Button type='button' variant='danger' onClick={() => void remove()} disabled={busy} aria-keyshortcuts={deleteKeys}>Delete <KeyHint command='entry.delete' /></Button>}
      </FormActions>
    </Form>
    <DialogKeys name='Confirm' open={!!dialog}>{dialog}</DialogKeys>
  </Stack>
}
