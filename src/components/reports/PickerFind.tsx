import { Field, Input, ShortcutScope, Text } from '@ten98/ui'
import { useEffect, useId, useRef, useState, type MutableRefObject } from 'react'
import { flushSync } from 'react-dom'
import { contextTitles } from '../../lib/commands'
import { chooserFilters, pickerEscape, restoredFilter } from '../../lib/reports'
import { useAppCommand } from '../KeyboardShell'
import type { TableControl } from './ReportTable'

/**
 * The find field of a report's chooser (the ledger list, the cost centre list). It has focus when the page opens, so
 * typing narrows the list at once; the first line of the narrowed list is the highlighted one and Enter opens it (the
 * table owns that), and a list that narrowed to nothing says so. While the field has focus it also owns the keys the
 * registry keeps for a text field otherwise: Down, Up, Home, End, PageUp and PageDown move the highlight in the list
 * (`controlRef`, focus stays in the field), and Escape is the list's cancel (`pickerEscape`): typed text is cleared first,
 * and with none the field gives Escape back to the registry, so the report's usual back runs.
 */
export function PickerFind({ label, noun, filter, onFilter, matches, controlRef }: {
  label: string
  /** What the list holds, for "No <noun> matches." */
  noun: string
  filter: string
  onFilter: (text: string) => void
  /** Lines the narrowed list shows. */
  matches: number
  /** The table's handle for moving its highlight. */
  controlRef: MutableRefObject<TableControl | null>
}) {
  const id = useId()
  const [focused, setFocused] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  // A page loaded from the address has its field focused by the browser before React attaches onFocus, so ask once.
  useEffect(() => { setFocused(document.activeElement === field.current) }, [])
  // The scope wraps the field: the registry looks first at the scopes around the focused element, and the report's own
  // scope (which binds the same keys but not for a text field) would otherwise answer before it.
  return <ShortcutScope name={contextTitles.list}>
    <Field label={label} htmlFor={`${id}find`} description='Type to narrow the list; the arrow keys move in it and Enter opens the highlighted line.'>
      <Input ref={field} id={`${id}find`} type='search' value={filter} autoComplete='off' autoFocus
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => onFilter(event.target.value)} />
    </Field>
    {filter.trim() !== '' && matches === 0 && <Text role='status' tone='muted'>No {noun} matches.</Text>}
    {focused && <>
      <FieldMoves controlRef={controlRef} />
      <FieldEscape filter={filter} clear={() => onFilter('')} field={field} />
    </>}
  </ShortcutScope>
}

/** The movement keys, run from the text field through the registry's list commands marked for a text field. */
function FieldMoves({ controlRef }: { controlRef: MutableRefObject<TableControl | null> }) {
  const move = (change: Parameters<TableControl['move']>[0]) => () => controlRef.current?.move(change)
  useAppCommand('list.next', move('next'), { allowInTextInput: true, repeat: true })
  useAppCommand('list.previous', move('previous'), { allowInTextInput: true, repeat: true })
  useAppCommand('list.first', move('first'), { allowInTextInput: true })
  useAppCommand('list.last', move('last'), { allowInTextInput: true })
  useAppCommand('report.page-down', move('page-down'), { allowInTextInput: true, repeat: true })
  useAppCommand('report.page-up', move('page-up'), { allowInTextInput: true, repeat: true })
  return null
}

/** True while this component re-sends Escape, so a registry that still held the command cannot send it round again. */
let resending = false

function FieldEscape({ filter, clear, field }: { filter: string; clear: () => void; field: { current: HTMLInputElement | null } }) {
  useAppCommand('list.cancel', () => {
    if (pickerEscape(filter) === 'clear') return clear()
    if (resending) return
    // Nothing typed: Escape goes back. The registry hands a text field's Escape to this command only, and the shell's back
    // is not reachable from here, so leave the field (this scope goes with its focus) and press Escape again where
    // nav.back owns it, so a go-to return and a drill-down trail work as from any other focus. A synthetic key is a
    // stopgap: it goes when the shell offers a way to run its back command from a field (`useGoBack`, asked of the shell).
    resending = true
    try {
      flushSync(() => field.current?.blur()) // the scope is gone before the key is sent again
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
    } finally { resending = false }
  }, { allowInTextInput: true, label: filter ? 'Clear the filter' : 'Go back' })
  return null
}

/**
 * The state of a chooser: the typed text (restored when coming back from a line opened from it, `hl` in the address, so
 * the list is as it was left), the table's handle for the find field's movement keys, and `remember`, called when a line
 * is opened, which keeps the text for that return.
 */
export function useChooser(companyId: string, chooser: 'ledger' | 'cost-centre', hl: string | undefined, onHighlight: (key: string | undefined) => void) {
  const key = `${companyId}:${chooser}`
  const [filter, setFilter] = useState(() => restoredFilter(chooserFilters, key, hl))
  const controlRef = useRef<TableControl | null>(null)
  return {
    filter, controlRef,
    onFilter: (text: string) => { setFilter(text); onHighlight(undefined) },
    remember: () => { chooserFilters.set(key, filter) },
  }
}
