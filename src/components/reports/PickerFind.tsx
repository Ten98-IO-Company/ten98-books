import { Field, Input, ShortcutScope, Text } from '@ten98/ui'
import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { contextTitles } from '../../lib/commands'
import { useAppCommand } from '../KeyboardShell'

/**
 * The find field of a report's chooser (the ledger list, the cost centre list). It has focus when the page opens, so
 * typing narrows the list at once; the first line of the narrowed list is the highlighted one and Enter opens it (the
 * table owns that), and a list that narrowed to nothing says so. While the field has focus Escape is the list's cancel
 * (the registry keeps Escape for a text field otherwise): typed text is cleared first, and with none the field gives
 * Escape back to the registry, so the report's usual back runs (a go-to or a drill-down returns where it should).
 */
export function PickerFind({ label, noun, filter, onFilter, matches }: {
  label: string
  /** What the list holds, for "No <noun> matches." */
  noun: string
  filter: string
  onFilter: (text: string) => void
  /** Lines the narrowed list shows. */
  matches: number
}) {
  const id = useId()
  const [focused, setFocused] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  return <>
    <Field label={label} htmlFor={`${id}find`} description='Type to narrow the list; Enter opens the highlighted line.'>
      <Input ref={field} id={`${id}find`} type='search' value={filter} autoComplete='off' autoFocus
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => onFilter(event.target.value)} />
    </Field>
    {filter.trim() !== '' && matches === 0 && <Text role='status' tone='muted'>No {noun} matches.</Text>}
    {focused && <ShortcutScope name={contextTitles.list}><FieldEscape filter={filter} clear={() => onFilter('')} field={field} /></ShortcutScope>}
  </>
}

/** True while this component re-sends Escape, so a registry that still held the command cannot send it round again. */
let resending = false

function FieldEscape({ filter, clear, field }: { filter: string; clear: () => void; field: { current: HTMLInputElement | null } }) {
  useAppCommand('list.cancel', () => {
    if (filter) return clear()
    if (resending) return
    // Nothing typed: Escape goes back. The registry hands a text field's Escape to this command only, and the shell's back
    // is not reachable from here, so leave the field (this scope goes with its focus) and press Escape again where
    // nav.back owns it. A go-to return and a drill-down trail therefore work as from any other focus.
    resending = true
    try {
      flushSync(() => field.current?.blur()) // the scope is gone before the key is sent again
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
    } finally { resending = false }
  }, { allowInTextInput: true, label: filter ? 'Clear the filter' : 'Go back' })
  return null
}
