import { Alert, Button, ShortcutScope } from '@ten98/ui'
import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import { contextTitles } from '../../lib/commands'
import { describeFailure, nextFieldAfter } from '../../lib/masters'
import { useAppCommand } from '../KeyboardShell'

/** The entry context for a master form: Enter, accept, cancel, delete and history register inside it. */
export function EntryScope({ children }: { children: ReactNode }) {
  return <ShortcutScope name={contextTitles.entry}>{children}</ShortcutScope>
}

// An open dialog or expanded popup (a lookup's list) owns Enter and Escape even when focus has moved outside it.
const popupOpen = () => document.querySelector('dialog[open], :popover-open, [role="combobox"][aria-expanded="true"]') !== null

const controlOf = (holder: Element | null | undefined) => holder?.querySelector<HTMLInputElement>('input:not([type="hidden"]), textarea, select') ?? null

/** Fields of the form in their fixed order: every element marked `data-entry-field` that can take focus. */
function entryFields(form: HTMLElement | null): { name: string; control: HTMLInputElement }[] {
  if (!form) return []
  return [...form.querySelectorAll<HTMLElement>('[data-entry-field]')].flatMap(holder => {
    const control = controlOf(holder)
    return control && !control.disabled ? [{ name: holder.dataset.entryField ?? '', control }] : []
  })
}

export function focusEntryField(form: HTMLElement | null, name: string) {
  const control = entryFields(form).find(field => field.name === name)?.control
  control?.focus()
  control?.select?.()
}

/** Focuses the first field of the form in keyboard order that has an error message showing. */
export function focusFirstInvalid(form: HTMLElement | null, errors: Partial<Record<string, string>>) {
  const first = entryFields(form).find(field => errors[field.name])
  if (first) focusEntryField(form, first.name)
}

/**
 * Enter-advances-field for an entry surface (D-05): Enter moves to the next field in order and, after the last one, calls
 * `onLastField` (which asks to save). A lookup with its list open keeps Enter for picking a row; the pick has settled by
 * the time this runs, so the same key then moves on, as it does in desktop accounting software.
 */
export function useEntryCommands(options: {
  form: RefObject<HTMLElement | null>
  onLastField: () => void
  onAccept: () => void
  onCancel: () => void
  onDelete?: () => void
  onHistory?: () => void
}) {
  const latest = useRef(options)
  latest.current = options
  useAppCommand('entry.next-field', () => {
    const { form, onLastField } = latest.current
    const fields = entryFields(form.current)
    const current = fields.find(field => field.control === document.activeElement)
    if (!current) return
    const next = nextFieldAfter(fields.map(field => field.name), current.name)
    if (next === 'confirm') onLastField(); else focusEntryField(form.current, next)
  }, { allowInTextInput: true })
  useAppCommand('entry.accept', () => latest.current.onAccept(), { allowInTextInput: true })
  // The registry delivers Escape from text fields too; a lookup's open list takes the key first.
  useAppCommand('entry.cancel', () => { if (!popupOpen()) latest.current.onCancel() }, { allowInTextInput: true })
  useAppCommand('entry.delete', () => latest.current.onDelete?.(), { enabled: options.onDelete !== undefined })
  useAppCommand('entry.history', () => latest.current.onHistory?.(), { enabled: options.onHistory !== undefined })
}

/** Leaves an entry screen one level: back to where the user came from, or to `fallback` after a direct visit. */
export function useLeave(fallback: { to: string; params: Record<string, string> }) {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()
  return useCallback(() => {
    if (canGoBack) router.history.back()
    else void navigate({ to: fallback.to, params: fallback.params } as never)
  }, [canGoBack, router, navigate, fallback.to, JSON.stringify(fallback.params)])
}

export type Failure = ReturnType<typeof describeFailure>

/** Runs one request for an entry screen: busy while it runs, its failure kept in plain language, a lost session handled. */
export function useMasterRequest() {
  const { unauthorized } = useApp()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setFailure(null)
    try { return await task() }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) unauthorized()
      else setFailure(describeFailure(cause instanceof ApiError ? cause.status : undefined, errMsg(cause)))
      return undefined
    } finally { setBusy(false) }
  }, [unauthorized])
  return { busy, failure, run, clear: () => setFailure(null) }
}

/** What went wrong, with a reload when someone else changed the master first. */
export function FailureAlert({ failure, onReload }: { failure: Failure | null; onReload?: () => void }) {
  if (!failure) return null
  return <Alert tone='danger' title={failure.stale ? 'Changed by someone else' : 'Not saved'}
    actions={failure.stale && onReload ? <Button size='sm' variant='secondary' onClick={onReload}>Reload the latest</Button> : undefined}>
    {failure.stale ? `${failure.message} Reloading replaces what you typed with the saved version.` : failure.message}
  </Alert>
}

/**
 * "Save this?" after Enter on the last field: an inline panel whose Save button takes focus, so Enter accepts and
 * Escape (the form's cancel command) keeps editing. Built here because the stock dialogs start on their close button.
 */
export function SaveConfirm({ title, description, onConfirm, onCancel }: { title: string; description: string; onConfirm: () => void; onCancel: () => void }) {
  return <Alert tone='info' title={title} actions={<>
    <Button autoFocus onClick={onConfirm}>Save</Button>
    <Button variant='secondary' onClick={onCancel}>Keep editing</Button>
  </>}>{description} Press Enter to save, or Escape to keep editing.</Alert>
}
