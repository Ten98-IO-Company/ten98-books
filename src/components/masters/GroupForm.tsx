import { Alert, Button, Field, Form, FormActions, Input, KeyHint, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useCompany } from '../../lib/app-context'
import type { Nature } from '../../lib/ledger'
import {
  emptyGroupForm, groupChoices, groupDeleteReason, groupFields, groupFormOf, groupFormReducer, groupPath, groupPayload, isolate, natureLockReason, natureSingular,
  parentReason, primaryChoice, resolveLookup, validateGroupForm, type Choice, type GroupField, type GroupFormAction, type GroupFormValues, type GroupRow, type LedgerRow,
} from '../../lib/masters'
import { EntryScope, entryText, FailureAlert, focusEntryField, focusFirstInvalid, nextEntryField, SaveConfirm, useEntryCommands, useLeave, useMasterRequest } from './entry'
import { rememberGroup, setFlash } from './flash'
import { LookupField } from './LookupField'
import { useCanWrite } from './useCanWrite'

const natureChoices: Choice[] = (['asset', 'liability', 'income', 'expense'] as const).map(value => ({ value, label: natureSingular[value] }))
const yesNo: Choice[] = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]

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

type LookupName = 'parentId' | 'nature' | 'grossProfit'
const lookupOrder: readonly LookupName[] = ['parentId', 'nature', 'grossProfit']

/** Create group and alter group: one form, in a fixed keyboard order, with the rules the page can see explained in place. */
export function GroupForm(props: MasterFormProps<GroupRow>) {
  return <EntryScope><GroupFormBody {...props} /></EntryScope>
}

function GroupFormBody({ groups, ledgers, existing, initialGroupId, reloadData }: MasterFormProps<GroupRow>) {
  const company = useCompany()
  const navigate = useNavigate()
  // The screens that render this form wait for the role, so it is known here; anything but a writer reads only.
  const readOnly = !useCanWrite()
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
  // A name another master already has is an error on the Name field, found by the server's code.
  useEffect(() => {
    if (failure?.code !== 'duplicate_name') return
    setErrors(previous => ({ ...previous, name: failure.message }))
    focusEntryField(form.current, 'name')
  }, [failure])
  const leave = useLeave({ to: '/app/c/$companyId/masters/chart-of-accounts', params: { companyId: company.id } })

  const parentChoices = useMemo(() => groupChoices(groups, { primary: true, reason: existing ? candidate => parentReason(existing, candidate, groups, ledgers) : undefined }), [groups, ledgers, existing])
  const parentIds = useMemo(() => new Set(parentChoices.filter(choice => !choice.disabled).map(choice => choice.value)), [parentChoices])
  const natureLock = existing ? natureLockReason(existing, groups, ledgers) : null
  const deleteReason = existing ? groupDeleteReason(existing, groups, ledgers) : null
  const fields = groupFields(values)
  // A new entry is dirty once something is typed (the kept parent after a save is not an edit); an alter once it differs.
  const dirty = existing ? JSON.stringify(values) !== JSON.stringify(initial.current) : values.name.trim() !== '' || values.secondLanguageName.trim() !== ''
  const parent = groups.find(group => group.id === values.parentId)
  const parentName = parent ? groupPath(groups, parent.id).join(' › ') : 'Primary'

  // What each lookup offers, how a chosen value changes the form, and what a blank field says.
  const lookups: Record<LookupName, { options: Choice[]; current: (from: GroupFormValues) => string; actions: (value: string, from: GroupFormValues) => GroupFormAction[]; blank: string }> = {
    parentId: {
      options: parentChoices, current: from => from.parentId, blank: 'Choose the group this one sits under, or Primary.',
      // Moving a group to the top keeps its own nature unless the form already names one.
      actions: (value, from) => [{ type: 'set', field: 'parentId', value }, ...value === primaryChoice && existing && !from.nature ? [{ type: 'set', field: 'nature', value: existing.nature } as const] : []],
    },
    nature: { options: natureChoices, current: from => from.nature, actions: value => [{ type: 'set', field: 'nature', value: value as Nature }], blank: 'Choose the nature of a primary group.' },
    grossProfit: { options: yesNo, current: from => from.grossProfit ? 'yes' : 'no', actions: value => [{ type: 'set', field: 'grossProfit', value: value === 'yes' }], blank: 'Choose Yes or No.' },
  }

  /** Applies what was typed in one lookup to `from`: its single matching choice, or an error on that field (null). */
  function settle(field: LookupName, text: string, from: GroupFormValues): GroupFormValues | null {
    const lookup = lookups[field]
    const result = resolveLookup(lookup.options, text, lookup.current(from))
    const error = 'error' in result ? result.error : result.value === '' ? lookup.blank : ''
    if (error) { setErrors(previous => ({ ...previous, [field]: error })); return null }
    setErrors(previous => ({ ...previous, [field]: undefined }))
    if ('error' in result || result.value === lookup.current(from)) return from
    let next = from
    for (const action of lookup.actions(result.value, from)) { next = groupFormReducer(next, action); dispatch(action) }
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
  function prepare(): GroupFormValues | null {
    let next = values
    for (const field of lookupOrder) {
      const text = entryText(form.current, field)
      if (text === null || !groupFields(next).includes(field)) continue
      const settled = settle(field, text, next)
      if (!settled) { focusEntryField(form.current, field); return null }
      next = settled
    }
    const found = validateGroupForm(next, parentIds)
    setErrors(found)
    if (Object.keys(found).length) { focusFirstInvalid(form.current, found); return null }
    return next
  }

  async function save() {
    if (readOnly) return
    const ready = prepare()
    if (!ready) return
    const body = groupPayload(ready, existing?.revision)
    const result = await run(() => api<{ group: GroupRow }>(existing ? `/api/companies/${company.id}/groups/${existing.id}` : `/api/companies/${company.id}/groups`, { method: 'POST', body }))
    if (!result) return
    const done = result.group
    const where = done.parentId ? `under ${groupPath([...groups, done], done.parentId).join(' › ')}` : `as a primary ${natureSingular[done.nature].toLowerCase()} group`
    const message = `Saved group “${done.name}” ${where}.`
    if (existing) { setFlash(message); leave(); return }
    if (ready.parentId !== primaryChoice) rememberGroup(company.id, ready.parentId)
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
    if (readOnly || !prepare()) return
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
    form, readOnly,
    onLeaveField: (name, text) => name in lookups ? settle(name as LookupName, text, values) !== null : true,
    onLastField: askToSave, onAccept: () => void save(), onCancel: () => void cancel(),
    onDelete: existing && !readOnly && !deleteReason ? () => void remove() : undefined,
    onHistory: existing ? () => void navigate({ to: '/app/c/$companyId/masters/history/group/$groupId', params: { companyId: company.id, groupId: existing.id } }) : undefined,
  })

  const set = (field: 'name' | 'secondLanguageName') => (event: { target: { value: string } }) => dispatch({ type: 'set', field, value: event.target.value })
  const choose = (field: LookupName) => (value: string) => { for (const action of lookups[field].actions(value, values)) dispatch(action); setErrors(previous => ({ ...previous, [field]: undefined })) }
  return <Stack gap={6}>
    <PageHeader eyebrow='Masters' title={existing ? <>Alter group {isolate(existing.name)}</> : 'Create group'}
      description={readOnly ? 'How this group is set up. Changing it needs an owner, admin or editor; its history is open to you.'
        : existing ? 'Change the group, then press Enter on the last field to save.' : 'Fill in the fields in order and press Enter after each. The form is ready for the next group after every save.'} />
    {readOnly && <Alert tone='info'>Viewers can read the chart but not change it.</Alert>}
    {saved && <StatusLine tone='success' live='polite'>{saved}</StatusLine>}
    <FailureAlert failure={failure?.code === 'duplicate_name' ? null : failure} onReload={reloadData} />
    {confirming && <SaveConfirm title={existing ? 'Save the changes?' : 'Save this group?'} description={`“${values.name.trim()}” under ${parentName}.`}
      onConfirm={() => { setConfirming(false); void save() }} onCancel={keepEditing} />}
    <Form ref={form} onSubmit={() => undefined} busy={busy} gap={4} fieldErrors={errors} aria-label={existing ? 'Alter group' : 'Create group'}>
      <Stack data-entry-field='name'>
        <Field label='Name' error={errors.name} required><Input value={values.name} onChange={set('name')} maxLength={120} autoComplete='off' autoFocus={!readOnly} disabled={readOnly} /></Field>
      </Stack>
      <Stack data-entry-field='secondLanguageName'>
        <Field label='Name in a second language' description='Optional, for example the Arabic name.' error={errors.secondLanguageName}>
          <Input value={values.secondLanguageName} onChange={set('secondLanguageName')} maxLength={120} dir='auto' autoComplete='off' disabled={readOnly} />
        </Field>
      </Stack>
      <Stack data-entry-field='parentId'>
        <LookupField label='Under' options={parentChoices} value={values.parentId} disabled={readOnly} required error={errors.parentId}
          description={values.parentId === primaryChoice ? 'A primary group sits at the top of the chart and has its own nature.' : parent ? `Takes the nature of its parent: ${natureSingular[parent.nature]}.` : 'Type to filter. Each group shows where it sits.'}
          placeholder='Choose a group' emptyMessage='No group matches.' onValueChange={choose('parentId')} onTypedEnter={(text, advance) => typedEnter('parentId', text, advance)} />
      </Stack>
      {fields.includes('nature') && <Stack data-entry-field='nature'>
        <LookupField label='Nature' options={natureChoices} value={values.nature} disabled={readOnly || natureLock !== null} required error={errors.nature}
          description={natureLock ?? 'Asset, liability, income or expense. Every sub-group below takes it.'} placeholder='Choose a nature' onValueChange={choose('nature')} onTypedEnter={(text, advance) => typedEnter('nature', text, advance)} />
      </Stack>}
      {fields.includes('grossProfit') && <Stack data-entry-field='grossProfit'>
        <LookupField label='Counts towards gross profit' options={yesNo} value={values.grossProfit ? 'yes' : 'no'} disabled={readOnly} error={errors.grossProfit}
          description='Direct income and direct expense groups are usually set to Yes.' onValueChange={choose('grossProfit')} onTypedEnter={(text, advance) => typedEnter('grossProfit', text, advance)} />
      </Stack>}
      {existing && !readOnly && deleteReason && <Text tone='muted' size='sm'>Delete is unavailable: {deleteReason}</Text>}
      <FormActions>
        {!readOnly && <Button type='button' onClick={() => void save()} disabled={busy}>Save <KeyHint command='entry.accept' /></Button>}
        <Button type='button' variant='secondary' autoFocus={readOnly} onClick={() => void cancel()}>{readOnly ? 'Back' : 'Leave'} <KeyHint command='entry.cancel' /></Button>
        {existing && !readOnly && !deleteReason && <Button type='button' variant='danger' onClick={() => void remove()} disabled={busy}>Delete <KeyHint command='entry.delete' /></Button>}
      </FormActions>
    </Form>
    {dialog}
  </Stack>
}
