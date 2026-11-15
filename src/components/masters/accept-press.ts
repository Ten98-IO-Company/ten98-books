/**
 * What a key press on the "Save this?" panel (SaveConfirm in ./entry.tsx) does. Only a fresh press answers it: a key held
 * down repeats, and a repeat of the Enter that carried the cursor through the last field must not save what that press
 * only asked about (the voucher screen reuses the panel, where it would post a voucher). A browser activates a focused
 * button from the Enter keydown, repeats included, so the repeat is swallowed (the caller calls `preventDefault`) rather than left alone.
 * - `swallow`: a repeating Enter, Y or N: nothing happens;
 * - `accept` / `keep-editing`: a fresh Y or N;
 * - `native`: everything else, left to the browser (a fresh Enter activates the focused button as it always did; Escape is the form's own command).
 */
export type AcceptPress = 'swallow' | 'accept' | 'keep-editing' | 'native'

export function acceptPress(event: { key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): AcceptPress {
  if (event.ctrlKey || event.altKey || event.metaKey) return 'native'
  const key = event.key.toLowerCase()
  if (key !== 'enter' && key !== 'y' && key !== 'n') return 'native'
  if (event.repeat) return 'swallow'
  return key === 'y' ? 'accept' : key === 'n' ? 'keep-editing' : 'native'
}
