import { Button, Inline, KeyHint, useShortcutCommands } from '@ten98/ui'
import { barCommands, type CommandContext } from '../lib/commands'

/**
 * The commands available right now, each a button with its key in the active keymap. It reads the live registry, so a
 * screen's commands appear while that screen is mounted. Movement keys and menu letters stay off the bar (commands.ts).
 * `contexts` narrows the bar, for example to a list screen's own commands.
 */
export function ContextActionBar({ label = 'Available commands', contexts }: { label?: string; contexts?: readonly CommandContext[] }) {
  const shown = barCommands(useShortcutCommands(), contexts)
  if (!shown.length) return null
  return <Inline as='section' aria-label={label} gap={2}>
    {shown.map(command => <Button key={command.id} variant='ghost' size='sm' onClick={command.run}>
      {command.label} <KeyHint command={command.id} />
    </Button>)}
  </Inline>
}
