import { Alert, Button, Card, Inline, RadioGroup, Stack, StatusLine, Text } from '@ten98/ui'
import { defaultKeymap, isKeymapName, keymapDescriptions, keymapNames, keymapTitles, type KeymapName } from '../lib/keymaps'

const otherKeymap = keymapNames.find(name => name !== defaultKeymap)!
import { useKeyboard } from './KeyboardShell'

/** Asks once which keymap to use. It blocks nothing: the default keys work while it is shown. `onChosen` runs only after a successful save, to give focus back to the page as the prompt and its focused button go away; on failure the prompt stays, with its error, and keeps focus. */
export function KeymapPrompt({ onChosen }: { onChosen?: () => void }) {
  const { chosen, saving, error, choose } = useKeyboard()
  if (chosen !== false) return null
  const pick = (keymap: KeymapName) => void choose(keymap).then(saved => { if (saved) onChosen?.() })
  return <Alert tone='info' title='Choose your keyboard shortcuts'
    actions={<Inline gap={2}>
      <Button size='sm' loading={saving} onClick={() => pick(defaultKeymap)}>Keep {keymapTitles[defaultKeymap].toLowerCase()} keys</Button>
      <Button size='sm' variant='secondary' disabled={saving} onClick={() => pick(otherKeymap)}>Switch to {keymapTitles[otherKeymap].toLowerCase()} keys</Button>
    </Inline>}>
    <Stack gap={1}>
      <Text>{keymapTitles[defaultKeymap]} keys are on now. {keymapDescriptions[defaultKeymap]}</Text>
      <Text>{keymapTitles[otherKeymap]}: {keymapDescriptions[otherKeymap]}</Text>
      <Text size='sm' tone='muted'>You can change this at any time on your Account page.</Text>
      {error && <Text size='sm' tone='danger'>{error}</Text>}
    </Stack>
  </Alert>
}

/** The Account page's keymap choice; a change is saved at once. */
export function KeymapSettings() {
  const { keymap, chosen, saving, error, choose, openHelp } = useKeyboard()
  return <Card as='section' title='Keyboard shortcuts' description='Choose the keys this application answers to. Your choice follows you to every device you sign in on.'
    actions={<Button size='sm' variant='secondary' onClick={openHelp}>Show all shortcuts</Button>}>
    <Stack gap={3}>
      <RadioGroup name='keymap' legend='Keymap' value={keymap} disabled={saving}
        options={keymapNames.map(name => ({ value: name, label: keymapTitles[name], description: keymapDescriptions[name] }))}
        onValueChange={value => { if (isKeymapName(value) && value !== keymap) void choose(value) }} />
      {saving && <StatusLine busy>Saving…</StatusLine>}
      {!saving && chosen === false && <StatusLine>Not chosen yet: the {keymapTitles[defaultKeymap].toLowerCase()} keys apply.</StatusLine>}
      {error && <Alert tone='danger'>{error}</Alert>}
    </Stack>
  </Card>
}
