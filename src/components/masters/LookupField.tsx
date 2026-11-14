import { Combobox, Stack, type ComboboxProps } from '@ten98/ui'
import { isChoice, type Choice } from '../../lib/masters'

/**
 * A lookup whose value is always one of its options. The stock combobox can hand its text back as the value, and on
 * Enter it closes its list and drops typed text that no row was highlighted for, without a word. Here anything that is
 * not an enabled option is ignored, and Enter on typed text with no highlighted row goes to `onTypedEnter` first (the
 * form picks the one choice the text names, or shows an error on this field): it returns true when it handled the key.
 * What the text means is also decided when the field is left or the form is saved (`resolveLookup` in src/lib/masters.ts).
 */
export function LookupField({ options, onValueChange, onTypedEnter, ...rest }: Omit<ComboboxProps, 'options' | 'allowCustom'> & {
  options: readonly Choice[]
  onTypedEnter?: (text: string) => boolean
}) {
  return <Stack as='div' onKeyDownCapture={event => {
    const input = event.target as HTMLInputElement
    if (event.key !== 'Enter' || !onTypedEnter || input.getAttribute('role') !== 'combobox') return
    if (input.getAttribute('aria-expanded') !== 'true' || input.getAttribute('aria-activedescendant')) return
    if (onTypedEnter(input.value)) { event.preventDefault(); event.stopPropagation() }
  }}>
    {/* allowCustom is true only so the field's own `error` shows (the stock combobox hides it for closed lists unless its own check fails); the guard below keeps free text from ever becoming a value. */}
    <Combobox {...rest} options={[...options]} allowCustom
      onValueChange={value => { if (isChoice(options, value)) onValueChange(value) }} />
  </Stack>
}
