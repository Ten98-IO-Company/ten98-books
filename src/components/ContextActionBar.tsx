import { Button, Inline, KeyHint, useShortcutCommands } from '@ten98/ui'
import { commandOf, isCommandId, type CommandContext } from '../lib/commands'

/**
 * The commands available right now, each a button with its key in the active keymap. It reads the live registry, so a
 * screen's commands appear while that screen is mounted. Movement keys and menu letters stay off the bar (commands.ts).
 * `contexts` narrows the bar, for example to a list screen's own commands.
 */
export function ContextActionBar({ label = 'Available commands', contexts }: { label?: string; contexts?: readonly CommandContext[] }) {
  const seen = new Set<string>()
  const shown = useShortcutCommands().filter(command => {
    if (!command.enabled || !isCommandId(command.id) || seen.has(command.id)) return false
    const definition = commandOf(command.id)
    if (definition.bar === false || (contexts && !contexts.includes(definition.context))) return false
    seen.add(command.id)
    return true
  })
  if (!shown.length) return null
  return <Inline as='section' aria-label={label} gap={2}>
    {shown.map(command => <Button key={command.id} variant='ghost' size='sm' onClick={command.run}>
      {command.label} <KeyHint command={command.id} />
    </Button>)}
  </Inline>
}
