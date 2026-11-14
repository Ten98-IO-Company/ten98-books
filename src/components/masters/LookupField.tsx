import { Combobox, Stack, useShortcutCommands, type ComboboxProps } from '@ten98/ui'
import { isChoice, type Choice } from '../../lib/masters'

/**
 * A lookup whose value is always one of its options. The stock combobox can hand its text back as the value, and on
 * Enter it closes its list and drops typed text that no row was highlighted for, without a word. Here anything that is
 * not an enabled option is ignored, and Enter on typed text with no highlighted row goes to `onTypedEnter` first (the
 * form picks the one choice the text names, or shows an error on this field).
 * What the text means is also decided when the field is left or the form is saved (`resolveLookup` in src/lib/masters.ts).
 *
 * The stock combobox also keeps every Escape to itself, even with its list closed, so the shortcut layer never sees it
 * and the screen could not be left from a lookup. With the list closed, Escape here runs the screen's `entry.cancel`
 * through the registry; with it open the combobox closes the list, as it should. Ctrl+Enter with the list open likewise
 * reaches `entry.accept` after the combobox has taken its pick.
 */
export function LookupField({ options, onValueChange, onTypedEnter, ...rest }: Omit<ComboboxProps, 'options' | 'allowCustom'> & {
  options: readonly Choice[]
  /** Typed text with no row highlighted, on Enter (`advance`) or the accept chord: 'picked' it, 'error' shown on the field, or 'unchanged'. */
  onTypedEnter?: (text: string, advance: boolean) => 'picked' | 'error' | 'unchanged'
}) {
  const registered = useShortcutCommands()
  return <Stack as='div' onKeyDownCapture={event => {
    const input = event.target as HTMLInputElement
    if (input.getAttribute('role') !== 'combobox') return
    const open = input.getAttribute('aria-expanded') === 'true'
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    if (event.key === 'Escape' && plain && !open) {
      const cancel = registered.find(command => command.id === 'entry.cancel' && command.enabled)
      if (cancel) { event.preventDefault(); event.stopPropagation(); cancel.run() }
      return
    }
    const unhighlighted = open && !input.getAttribute('aria-activedescendant')
    // Ctrl or Meta with Enter is the accept chord. With the list open the combobox consumes the key (picking the highlighted
    // row, if any) and then drops typed text that named no row, so the text is settled first, here, while it is still
    // there; accept runs right after, once the pick has settled, unless the text was an error.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && open) {
      const outcome = unhighlighted && onTypedEnter ? onTypedEnter(input.value, false) : 'unchanged'
      if (outcome === 'error') { event.preventDefault(); event.stopPropagation(); return }
      const accept = registered.find(command => command.id === 'entry.accept' && command.enabled)
      if (accept) window.setTimeout(() => accept.run(), 0)
      return
    }
    if (event.key !== 'Enter' || !onTypedEnter || !plain || !unhighlighted) return
    if (onTypedEnter(input.value, true) !== 'unchanged') { event.preventDefault(); event.stopPropagation() }
  }}>
    {/* allowCustom is true only so the field's own `error` shows (the stock combobox hides it for closed lists unless its own check fails); the guard below keeps free text from ever becoming a value. */}
    <Combobox {...rest} options={[...options]} allowCustom
      onValueChange={value => { if (isChoice(options, value)) onValueChange(value) }} />
  </Stack>
}
