import { Field, Input, ShortcutScope, Text } from '@ten98/ui'
import { useId, useRef, useState, type MutableRefObject } from 'react'
import { contextTitles } from '../../lib/commands'
import { pickerEnter } from '../../lib/reports'
import { useAppCommand } from '../KeyboardShell'

/**
 * The find field of a report's chooser (the ledger list, the cost centre list): the state of the typed text and of the
 * "nothing chosen yet" prompt, and what Enter does (`pickerEnter`). The field has focus when the page opens, so typing
 * narrows at once; Enter opens the highlighted line only once the user has narrowed the list or moved the highlight,
 * and otherwise says nothing was chosen instead of opening the first line unseen.
 */
export function usePickerFind(highlight: string | undefined, onHighlight: (key: string | undefined) => void) {
  const [filter, setFilter] = useState('')
  const [prompt, setPrompt] = useState(false)
  return {
    filter,
    onFilter: (text: string) => { setFilter(text); setPrompt(false); onHighlight(undefined) },
    /** For the table's `onHighlight`: moving the highlight is a choice, so the prompt goes. */
    onMove: (key: string) => { setPrompt(false); onHighlight(key) },
    prompt,
    /** Enter on a line: runs `open` once something was chosen, else shows the prompt. */
    choose: (open: () => void) => { if (pickerEnter({ filter, highlight }) === 'open') open(); else setPrompt(true) },
  }
}

/**
 * The find field. While it has focus Escape is the list's cancel (the registry keeps Escape for a text field otherwise):
 * the first press clears typed text, and with none moves focus to the list (`focusRows`), where Escape is the report's
 * usual back, so a go-to or a drill-down returns where it should. This is the ladder of the alter list.
 */
export function PickerFind({ label, description, filter, onFilter, prompt, focusRows }: {
  label: string
  description: string
  filter: string
  onFilter: (text: string) => void
  prompt: boolean
  /** Set by the table: moves focus to its highlighted line. */
  focusRows: MutableRefObject<(() => void) | null>
}) {
  const id = useId()
  const [focused, setFocused] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  return <>
    <Field label={label} htmlFor={`${id}find`} description={description}>
      <Input ref={field} id={`${id}find`} type='search' value={filter} autoComplete='off' autoFocus
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => onFilter(event.target.value)} />
    </Field>
    {prompt && <Text role='status' tone='muted'>Nothing chosen yet. Type to narrow the list, or press Down to pick a line.</Text>}
    {focused && <ShortcutScope name={contextTitles.list}><FieldEscape filter={filter} clear={() => onFilter('')} leave={() => focusRows.current?.()} /></ShortcutScope>}
  </>
}

function FieldEscape({ filter, clear, leave }: { filter: string; clear: () => void; leave: () => void }) {
  useAppCommand('list.cancel', () => { if (filter) clear(); else leave() }, { allowInTextInput: true, label: filter ? 'Clear the filter' : 'Move to the list' })
  return null
}
