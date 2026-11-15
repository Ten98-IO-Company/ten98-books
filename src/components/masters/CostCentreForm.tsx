import { Alert, Button, Field, Form, FormActions, Input, KeyHint, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { DialogKeys, useAriaKeys } from '../KeyboardShell'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useCompany } from '../../lib/app-context'
import {
  categoryChoices, centreFormOf, centreFormReducer, centrePayload, centrePath, chooseCategory, chooseParent, emptyCentreForm, parentChoices, topLevelChoice, validateCentreForm,
  type CentreField, type CentreFormAction, type CentreFormValues, type CostCategoryRow, type CostCentreRow,
} from '../../lib/cost-centre-forms'
import { isolate } from '../../lib/masters'
import { EntryScope, FailureAlert, focusEntryField, focusFirstInvalid, nextEntryField, SaveConfirm, useEntryCommands, useLeave, useLeaveGuard, useMasterRequest } from './entry'
import { rememberCostCategory, setFlash } from './flash'
import { LookupField } from './LookupField'
import { useCanWrite } from './useCanWrite'
import { useEntryLookups, type LookupSpec } from './useEntryLookups'

type LookupName = 'categoryId' | 'parentId'
const lookupOrder: readonly LookupName[] = ['categoryId', 'parentId']

/**
 * Create cost centre and alter cost centre, and with it moving a centre: the category comes first (as the reference asks
 * it), then the name, then what the centre sits under, offered from the centres of the chosen category.
 */
export function CostCentreForm(props: { categories: CostCategoryRow[]; centres: CostCentreRow[]; existing?: CostCentreRow; initialCategoryId?: string; initialParentId?: string; /** The field the cursor starts on. */ start: 'categoryId' | 'name'; reloadData: () => void }) {
  return <EntryScope><CostCentreFormBody {...props} /></EntryScope>
}

function CostCentreFormBody({ categories, centres, existing, initialCategoryId, initialParentId, start, reloadData }: Parameters<typeof CostCentreForm>[0]) {
  const company = useCompany()
  const navigate = useNavigate()
  // The screens that render this form wait for the role, so it is known here; anything but a writer reads only.
  const readOnly = !useCanWrite()
  const form = useRef<HTMLFormElement>(null)
  const [values, dispatch] = useReducer(centreFormReducer, undefined, () => existing ? centreFormOf(existing) : emptyCentreForm(initialCategoryId ?? '', initialParentId ?? topLevelChoice))
  const initial = useRef(values)
  const [errors, setErrors] = useState<Partial<Record<CentreField, string>>>({})
  const [saved, setSaved] = useState('')
  const [confirming, setConfirming] = useState(false)
  // The form locks its fields while a request runs; focus returns to Name once it lifts, ready for the next entry.
  const refocus = useRef(false)
  const { busy, failure, run } = useMasterRequest()
  const [confirm, dialog] = useConfirmDialog()
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; focusEntryField(form.current, 'name') } }, [busy])
  // A new centre starts on the first field, the category, as the reference does, and so does a move; an alter starts on the name. A viewer's starts on Back.
  useEffect(() => { if (!readOnly) focusEntryField(form.current, start) }, [readOnly, start])
  // A name another centre already has (names are shared by all categories) is an error on the Name field, found by the server's code.
  useEffect(() => {
    if (failure?.code !== 'duplicate_name') return
    setErrors(previous => ({ ...previous, name: failure.message }))
    focusEntryField(form.current, 'name')
  }, [failure])
  const leave = useLeave({ to: '/app/c/$companyId/masters/cost-centres', params: { companyId: company.id } })

  const categoryOptions = useMemo(() => categoryChoices(categories), [categories])
  const parentOptions = useMemo(() => parentChoices(centres, values.categoryId, existing), [centres, values.categoryId, existing])
  const categoryIds = useMemo(() => new Set(categoryOptions.map(choice => choice.value)), [categoryOptions])
  const parentIds = useMemo(() => new Set(parentOptions.map(choice => choice.value)), [parentOptions])
  // A new entry is dirty once something is typed (the kept category and parent after a save are not an edit); an alter once it differs.
  const dirty = existing ? JSON.stringify(values) !== JSON.stringify(initial.current) : values.name.trim() !== '' || values.secondLanguageName.trim() !== ''
  const guard = useLeaveGuard(dirty && !readOnly, () => confirm({ title: 'Leave without saving?', description: 'What you entered on this screen is not saved.', confirmLabel: 'Leave', cancelLabel: 'Keep editing', initialFocus: 'cancel' }))
  const acceptKeys = useAriaKeys('entry.accept'), deleteKeys = useAriaKeys('entry.delete')
  const category = categories.find(item => item.id === values.categoryId)
  const parent = centres.find(centre => centre.id === values.parentId)

  const specs: Record<LookupName, LookupSpec<CentreFormValues, CentreFormAction>> = {
    categoryId: {
      options: categoryOptions, current: from => from.categoryId, blank: 'Choose the cost category this centre belongs to.',
      actions: (value, from) => [{ type: 'load', values: chooseCategory(from, value, centres, existing) }],
    },
    parentId: {
      options: parentOptions, current: from => from.parentId, blank: 'Choose the centre this one sits under, or the top level.',
      actions: (value, from) => [{ type: 'load', values: chooseParent(from, value, centres) }],
    },
  }
  const lookups = useEntryLookups({
    form, values, reduce: centreFormReducer, dispatch, specs, order: lookupOrder, setErrors,
    advance: field => { const next = nextEntryField(form.current, field); if (next === 'confirm') askToSave(); else focusEntryField(form.current, next) },
  })

  /** The form as it will be saved: every lookup settled from the text on screen and every field checked, or null with the problem shown. */
  function prepare(): CentreFormValues | null {
    const settled = lookups.settleAll()
    if (!settled) return null
    const found = validateCentreForm(settled, categoryIds, parentIds)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return null }
    return settled
  }

  async function save() {
    if (readOnly) return
    const ready = prepare()
    if (!ready) return
    const result = await run(() => api<{ costCentre: CostCentreRow }>(existing ? `/api/companies/${company.id}/cost-centres/${existing.id}` : `/api/companies/${company.id}/cost-centres`,
      { method: 'POST', body: centrePayload(ready, existing?.revision) }))
    if (!result) return
    const done = result.costCentre
    const where = done.parentId ? `under ${centrePath([...centres.filter(centre => centre.id !== done.id), done], done.parentId).join(' › ')} in ${done.categoryName}` : `in ${done.categoryName}`
    const message = `Saved cost centre “${done.name}” ${where}.`
    if (existing) { setFlash(message); guard.pass(leave); return }
    rememberCostCategory(company.id, ready.categoryId)
    setSaved(message)
    dispatch({ type: 'saved' })
    reloadData()
    refocus.current = true
  }

  async function remove() {
    if (!existing || readOnly) return
    if (!await confirm({ title: `Delete the cost centre “${existing.name}”?`, description: 'The centre is removed. Its history stays available. A centre that holds sub-centres or is used in vouchers cannot be deleted.', confirmLabel: 'Delete cost centre', danger: true, initialFocus: 'cancel' })) return
    const done = await run(() => api(`/api/companies/${company.id}/cost-centres/${existing.id}/delete`, { method: 'POST', body: { revision: existing.revision } }))
    if (done) { setFlash(`Deleted cost centre “${existing.name}”.`); guard.pass(leave) }
  }

  function askToSave() {
    if (readOnly || !prepare()) return
    setConfirming(true)
  }

  function keepEditing() {
    setConfirming(false)
    focusEntryField(form.current, 'parentId')
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
    onDelete: existing && !readOnly ? () => void remove() : undefined,
    onHistory: existing ? () => void navigate({ to: '/app/c/$companyId/masters/history/cost-centre/$centreId', params: { companyId: company.id, centreId: existing.id } }) : undefined,
  })

  const set = (field: 'name' | 'secondLanguageName') => (event: { target: { value: string } }) => { dispatch({ type: 'set', field, value: event.target.value }); setErrors(previous => ({ ...previous, [field]: undefined })) }
  const choose = (field: LookupName) => (value: string) => { for (const action of specs[field].actions(value, values)) dispatch(action); setErrors(previous => ({ ...previous, [field]: undefined })) }
  const summary = `“${values.name.trim()}” in ${category?.name ?? 'no category'}${parent ? `, under ${parent.name}` : ''}.`
  return <Stack gap={6}>
    <PageHeader eyebrow='Masters' title={existing ? <>Alter cost centre {isolate(existing.name)}</> : 'Create cost centre'}
      description={readOnly ? 'How this cost centre is set up. Changing it needs an owner, admin or editor; its history is open to you.'
        : existing ? 'Change the centre, or move it by choosing another category or parent, then press Enter on the last field to save.' : 'Fill in the fields in order and press Enter after each. The form is ready for the next centre after every save, with the category kept.'} />
    {readOnly && <Alert tone='info'>Viewers can read cost centres but not change them.</Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    <FailureAlert failure={failure?.code === 'duplicate_name' ? null : failure} onReload={reloadData} />
    {confirming && <SaveConfirm title={existing ? 'Save the changes?' : 'Save this cost centre?'} description={summary} onConfirm={() => { setConfirming(false); void save() }} onCancel={keepEditing} />}
    <Form ref={form} onSubmit={() => undefined} busy={busy} gap={4} fieldErrors={errors} aria-label={existing ? 'Alter cost centre' : 'Create cost centre'}>
      <Stack data-entry-field='categoryId'>
        <LookupField label='Cost category' options={categoryOptions} value={values.categoryId} disabled={readOnly} required error={errors.categoryId}
          description={existing ? 'Choose another category to move this centre. Vouchers already saved keep the category they were saved with; reports follow the centre.' : 'Type to filter. Every centre belongs to one category.'}
          placeholder='Choose a category' emptyMessage='No category matches.' onValueChange={choose('categoryId')} onTypedEnter={(text, advance) => lookups.typedEnter('categoryId', text, advance)} />
      </Stack>
      <Stack data-entry-field='name'>
        <Field label='Name' description='Unique across all categories.' error={errors.name} required><Input value={values.name} onChange={set('name')} maxLength={120} autoComplete='off' disabled={readOnly} /></Field>
      </Stack>
      <Stack data-entry-field='secondLanguageName'>
        <Field label='Name in a second language' description='Optional, for example the Arabic name.' error={errors.secondLanguageName}>
          <Input value={values.secondLanguageName} onChange={set('secondLanguageName')} maxLength={120} dir='auto' autoComplete='off' disabled={readOnly} />
        </Field>
      </Stack>
      <Stack data-entry-field='parentId'>
        <LookupField label='Under' options={parentOptions} value={values.parentId} disabled={readOnly} required error={errors.parentId}
          description={parent ? `A centre under another goes in that centre’s category: ${parent.categoryName}.` : 'The top level, or a centre of the chosen category. Type to filter.'}
          placeholder='Choose a centre' emptyMessage='No centre matches.' onValueChange={choose('parentId')} onTypedEnter={(text, advance) => lookups.typedEnter('parentId', text, advance)} />
      </Stack>
      {existing && !readOnly && existing.inUse && <Text tone='muted' size='sm'>This centre holds sub-centres or is used in vouchers: it can be moved and renamed, but a delete is refused.</Text>}
      <FormActions>
        {!readOnly && <Button type='button' onClick={() => void save()} disabled={busy} aria-keyshortcuts={acceptKeys}>Save <KeyHint command='entry.accept' /></Button>}
        <Button type='button' variant='secondary' autoFocus={readOnly} onClick={() => void cancel()}>{readOnly ? 'Back' : 'Leave'} <KeyHint command='entry.cancel' /></Button>
        {existing && !readOnly && <Button type='button' variant='danger' onClick={() => void remove()} disabled={busy} aria-keyshortcuts={deleteKeys}>Delete <KeyHint command='entry.delete' /></Button>}
      </FormActions>
    </Form>
    <DialogKeys name='Confirm' open={!!dialog}>{dialog}</DialogKeys>
  </Stack>
}
