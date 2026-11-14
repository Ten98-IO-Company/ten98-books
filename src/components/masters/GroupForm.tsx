import { Alert, Button, Combobox, Field, Form, FormActions, Input, KeyHint, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useApp, useCompany } from '../../lib/app-context'
import type { Nature } from '../../lib/ledger'
import {
  emptyGroupForm, groupChoices, groupDeleteReason, groupFields, groupFormOf, groupFormReducer, groupPath, groupPayload, natureLockReason, natureSingular,
  parentReason, primaryChoice, validateGroupForm, type GroupField, type GroupRow, type LedgerRow, isolate } from '../../lib/masters'
import { EntryScope, FailureAlert, focusEntryField, focusFirstInvalid, SaveConfirm, useEntryCommands, useLeave, useMasterRequest } from './entry'
import { rememberGroup, setFlash } from './flash'

const natureChoices = (['asset', 'liability', 'income', 'expense'] as const).map(value => ({ value, label: natureSingular[value] }))
const yesNo = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]

export type MasterFormProps<T> = {
  groups: GroupRow[]
  ledgers: LedgerRow[]
  /** Present when altering. */
  existing?: T
  /** Where a new entry starts. */
  initialGroupId?: string
  /** Refetches the company's groups and ledgers. */
  reloadData: () => void
}

/** Create group and alter group: one form, in a fixed keyboard order, with the rules the page can see explained in place. */
export function GroupForm(props: MasterFormProps<GroupRow>) {
  return <EntryScope><GroupFormBody {...props} /></EntryScope>
}

function GroupFormBody({ groups, ledgers, existing, initialGroupId, reloadData }: MasterFormProps<GroupRow>) {
  const company = useCompany()
  const { workspace } = useApp()
  const navigate = useNavigate()
  const readOnly = workspace.role === 'viewer'
  const form = useRef<HTMLFormElement>(null)
  const [values, dispatch] = useReducer(groupFormReducer, undefined, () => existing ? groupFormOf(existing) : emptyGroupForm(initialGroupId ?? ''))
  const initial = useRef(values)
  const [errors, setErrors] = useState<Partial<Record<GroupField, string>>>({})
  const [saved, setSaved] = useState('')
  const [confirming, setConfirming] = useState(false)
  // The form locks its fields while a request runs; focus returns to Name once it lifts, ready for the next entry.
  const refocus = useRef(false)
  const { busy, failure, run } = useMasterRequest()
  const [confirm, dialog] = useConfirmDialog()
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; focusEntryField(form.current, 'name') } }, [busy])
  const leave = useLeave({ to: '/app/c/$companyId/masters/chart-of-accounts', params: { companyId: company.id } })

  const parentChoices = useMemo(() => groupChoices(groups, { primary: true, reason: existing ? candidate => parentReason(existing, candidate, groups, ledgers) : undefined }), [groups, ledgers, existing])
  const natureLock = existing ? natureLockReason(existing, groups, ledgers) : null
  const deleteReason = existing ? groupDeleteReason(existing, groups, ledgers) : null
  const fields = groupFields(values)
  const dirty = JSON.stringify(values) !== JSON.stringify(initial.current)
  const parent = groups.find(group => group.id === values.parentId)
  const parentName = parent ? groupPath(groups, parent.id).join(' › ') : 'Primary'

  async function save() {
    if (readOnly || busy) return
    const found = validateGroupForm(values)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return }
    const body = groupPayload(values, existing?.revision)
    const result = await run(() => api<{ group: GroupRow }>(existing ? `/api/companies/${company.id}/groups/${existing.id}` : `/api/companies/${company.id}/groups`, { method: 'POST', body }))
    if (!result) return
    const saved = result.group
    const where = saved.parentId ? `under ${groupPath([...groups, saved], saved.parentId).join(' › ')}` : `as a primary ${natureSingular[saved.nature].toLowerCase()} group`
    const message = `Saved group “${saved.name}” ${where}.`
    if (existing) { setFlash(message); leave(); return }
    if (values.parentId !== primaryChoice) rememberGroup(company.id, values.parentId)
    setSaved(message)
    dispatch({ type: 'saved' })
    reloadData()
    refocus.current = true
  }

  async function remove() {
    if (!existing || readOnly || deleteReason) return
    if (!await confirm({ title: `Delete the group “${existing.name}”?`, description: 'The group is removed from the chart. Its history stays available.', confirmLabel: 'Delete group', danger: true })) return
    const done = await run(() => api(`/api/companies/${company.id}/groups/${existing.id}/delete`, { method: 'POST', body: { revision: existing.revision } }))
    if (done) { setFlash(`Deleted group “${existing.name}”.`); leave() }
  }

  function askToSave() {
    if (readOnly) return
    const found = validateGroupForm(values)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return }
    setConfirming(true)
  }

  function keepEditing() {
    setConfirming(false)
    focusEntryField(form.current, fields[fields.length - 1])
  }

  async function cancel() {
    if (confirming) { keepEditing(); return }
    if (dirty && !readOnly && !await confirm({ title: 'Leave without saving?', description: 'What you entered on this screen is not saved.', confirmLabel: 'Leave', cancelLabel: 'Keep editing' })) return
    leave()
  }

  useEntryCommands({
    form, onLastField: () => void askToSave(), onAccept: () => void save(), onCancel: () => void cancel(),
    onDelete: existing && !readOnly && !deleteReason ? () => void remove() : undefined,
    onHistory: existing ? () => void navigate({ to: '/app/c/$companyId/masters/history/group/$groupId', params: { companyId: company.id, groupId: existing.id } }) : undefined,
  })

  const set = (field: 'name' | 'secondLanguageName') => (event: { target: { value: string } }) => dispatch({ type: 'set', field, value: event.target.value })
  return <Stack gap={6}>
    <PageHeader eyebrow='Masters' title={existing ? <>Alter group {isolate(existing.name)}</> : 'Create group'}
      description={existing ? 'Change the group, then press Enter on the last field to save.' : 'Fill in the fields in order and press Enter after each. The form is ready for the next group after every save.'} />
    {readOnly && <Alert tone='info'>Viewers can read the chart but not change it.</Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    <FailureAlert failure={failure} onReload={reloadData} />
    {confirming && <SaveConfirm title={existing ? 'Save the changes?' : 'Save this group?'} description={`“${values.name.trim()}” under ${parentName}.`}
      onConfirm={() => { setConfirming(false); void save() }} onCancel={keepEditing} />}
    <Form ref={form} onSubmit={() => undefined} busy={busy} gap={4} fieldErrors={errors} aria-label={existing ? 'Alter group' : 'Create group'}>
      <Stack data-entry-field='name'>
        <Field label='Name' error={errors.name} required><Input value={values.name} onChange={set('name')} maxLength={120} autoComplete='off' autoFocus disabled={readOnly} /></Field>
      </Stack>
      <Stack data-entry-field='secondLanguageName'>
        <Field label='Name in a second language' description='Optional, for example the Arabic name.' error={errors.secondLanguageName}>
          <Input value={values.secondLanguageName} onChange={set('secondLanguageName')} maxLength={120} dir='auto' autoComplete='off' disabled={readOnly} />
        </Field>
      </Stack>
      <Stack data-entry-field='parentId'>
        <Combobox allowCustom={false} label='Under' options={parentChoices} value={values.parentId} disabled={readOnly} required error={errors.parentId}
          description={values.parentId === primaryChoice ? 'A primary group sits at the top of the chart and has its own nature.' : parent ? `Takes the nature of its parent: ${natureSingular[parent.nature]}.` : 'Type to filter. Each group shows where it sits.'}
          placeholder='Choose a group' emptyMessage='No group matches.'
          onValueChange={value => {
            dispatch({ type: 'set', field: 'parentId', value })
            if (value === primaryChoice && existing && !values.nature) dispatch({ type: 'set', field: 'nature', value: existing.nature })
          }} />
      </Stack>
      {fields.includes('nature') && <Stack data-entry-field='nature'>
        <Combobox allowCustom={false} label='Nature' options={natureChoices} value={values.nature} disabled={readOnly || natureLock !== null} required error={errors.nature}
          description={natureLock ?? 'Asset, liability, income or expense. Every sub-group below takes it.'} placeholder='Choose a nature'
          onValueChange={value => dispatch({ type: 'set', field: 'nature', value: value as Nature })} />
      </Stack>}
      {fields.includes('grossProfit') && <Stack data-entry-field='grossProfit'>
        <Combobox allowCustom={false} label='Counts towards gross profit' options={yesNo} value={values.grossProfit ? 'yes' : 'no'} disabled={readOnly}
          description='Direct income and direct expense groups are usually set to Yes.' onValueChange={value => dispatch({ type: 'set', field: 'grossProfit', value: value === 'yes' })} />
      </Stack>}
      {existing && deleteReason && <Text tone='muted' size='sm'>Delete is unavailable: {deleteReason}</Text>}
      <FormActions>
        {!readOnly && <Button type='button' onClick={() => void save()} disabled={busy}>Save <KeyHint command='entry.accept' /></Button>}
        <Button type='button' variant='secondary' onClick={() => void cancel()}>{readOnly ? 'Back' : 'Leave'} <KeyHint command='entry.cancel' /></Button>
        {existing && !readOnly && !deleteReason && <Button type='button' variant='danger' onClick={() => void remove()} disabled={busy}>Delete <KeyHint command='entry.delete' /></Button>}
      </FormActions>
    </Form>
    {dialog}
  </Stack>
}
