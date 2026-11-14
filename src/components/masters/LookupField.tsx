import { chordFromEvent, Combobox, Stack, useShortcutCommands, type ComboboxProps } from '@ten98/ui'
import { isChoice, lookupKeyAction, type Choice } from '../../lib/masters'

/**
 * A lookup whose value is always one of its options. The stock combobox can hand its text back as the value, and on
 * Enter it closes its list and drops typed text that no row was highlighted for, without a word. Here anything that is
 * not an enabled option is ignored, and Enter on typed text with no highlighted row goes to `onTypedEnter` first (the
 * form picks the one choice the text names, or shows an error on this field).
 * What the text means is also decided when the field is left or the form is saved (`resolveLookup` in src/lib/masters.ts).
 *
 * The stock combobox also keeps every Escape to itself, even with its list closed, and a list that is open swallows the
 * keys the form binds to accept, so what each key does is decided by `lookupKeyAction` (src/lib/masters.ts) and handed on
 * through the shortcut registry: a closed lookup's Escape runs `entry.cancel`; a chord bound to `entry.accept` in the
 * active keymap (read from the registry, whatever it is) first picks the highlighted row or settles the typed text, then
 * accepts once.
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
    const accept = registered.find(command => command.id === 'entry.accept' && command.enabled)
    const highlighted = input.getAttribute('aria-activedescendant')
    const action = lookupKeyAction({ chord: chordFromEvent(event.nativeEvent), open: input.getAttribute('aria-expanded') === 'true', highlighted: !!highlighted, acceptKeys: accept?.keys ?? [] })
    if (action === 'ignore') return
    event.preventDefault(); event.stopPropagation()
    if (action === 'cancel') { registered.find(command => command.id === 'entry.cancel' && command.enabled)?.run(); return }
    if (action === 'pick-text') { onTypedEnter?.(input.value, true); return }
    if (action === 'accept-row') {
      // The combobox picks on click; the pick settles before accept runs.
      if (highlighted) document.getElementById(highlighted)?.click()
    } else if (onTypedEnter?.(input.value, false) === 'error') return
    window.setTimeout(() => accept?.run(), 0)
  }}>
    {/* allowCustom is true only so the field's own `error` shows (the stock combobox hides it for closed lists unless its own check fails); the guard below keeps free text from ever becoming a value. */}
    <Combobox {...rest} options={[...options]} allowCustom
      onValueChange={value => { if (isChoice(options, value)) onValueChange(value) }} />
  </Stack>
}
