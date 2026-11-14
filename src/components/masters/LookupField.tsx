import { Combobox, type ComboboxProps } from '@ten98/ui'
import { isChoice, type Choice } from '../../lib/masters'

/**
 * A lookup whose value is always one of its options. The stock combobox can hand its text back as the value; here
 * anything that is not an enabled option is ignored, and what the typed text means is decided when the field is left or
 * the form is saved (`resolveLookup` in src/lib/masters.ts), where a text that names no single choice is an error on this
 * field instead of a silent default.
 */
export function LookupField({ options, onValueChange, ...rest }: Omit<ComboboxProps, 'options' | 'allowCustom'> & { options: readonly Choice[] }) {
  return <Combobox {...rest} options={[...options]} allowCustom={false}
    onValueChange={value => { if (isChoice(options, value)) onValueChange(value) }} />
}
