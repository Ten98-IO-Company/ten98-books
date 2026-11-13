import { Icon, Inline, KeyHint, ShortcutScope, Stack, Text, useCommandKeys } from '@ten98/ui'
import { useEffect, useId, useRef } from 'react'
import { contextTitles, type CommandId } from '../lib/commands'
import { useAppCommand } from './KeyboardShell'

export type KeyboardMenuItem = {
  /** The registry command whose key (the menu letter) opens this item. */
  command: CommandId
  label: string
  open: () => void
}
export type KeyboardMenuGroup = { id: string; label: string; items: readonly KeyboardMenuItem[] }

/**
 * A grouped menu driven by the shortcut registry in the company-home context. Focus stays on the menu and the
 * highlighted item is its active descendant, so Up, Down, Home, End, Enter and the menu letters reach the registry as
 * commands; the letters run only while the menu has focus (WCAG 2.1.4). The caller owns the highlight so it can restore
 * it when the user comes back.
 */
export function KeyboardMenu(props: {
  label: string
  groups: readonly KeyboardMenuGroup[]
  active: CommandId
  onActiveChange: (command: CommandId) => void
  /** Moves focus to the menu when it mounts and whenever this number changes; undefined leaves focus alone. */
  focusRequest?: number
}) {
  return <ShortcutScope name={contextTitles['company-home']} activation='focus'><MenuBody {...props} /></ShortcutScope>
}

function MenuBody({ label, groups, active, onActiveChange, focusRequest }: Parameters<typeof KeyboardMenu>[0]) {
  const id = useId()
  const menu = useRef<HTMLElement>(null)
  const items = groups.flatMap(group => group.items)
  const index = Math.max(0, items.findIndex(item => item.command === active))
  const highlight = (to: number) => onActiveChange(items[(to + items.length) % items.length].command)

  useAppCommand('menu.next', () => highlight(index + 1), { repeat: true })
  useAppCommand('menu.previous', () => highlight(index - 1), { repeat: true })
  useAppCommand('menu.first', () => highlight(0))
  useAppCommand('menu.last', () => highlight(items.length - 1))
  useAppCommand('menu.open', () => items[index].open())
  useEffect(() => { if (focusRequest !== undefined) menu.current?.focus() }, [focusRequest])

  return <Stack as='ul' ref={menu} role='menu' tabIndex={0} aria-label={label} aria-activedescendant={`${id}${items[index].command}`} gap={4}>
    {groups.map(group => <Stack as='li' role='none' key={group.id} gap={1}>
      <Text as='div' id={`${id}${group.id}`} size='sm' weight='semibold' tone='muted'>{group.label}</Text>
      <Stack as='ul' role='group' aria-labelledby={`${id}${group.id}`} gap={1}>
        {group.items.map(item => <MenuItem key={item.command} id={`${id}${item.command}`} item={item} active={item.command === items[index].command}
          onHighlight={() => onActiveChange(item.command)} />)}
      </Stack>
    </Stack>)}
  </Stack>
}

function MenuItem({ id, item, active, onHighlight }: { id: string; item: KeyboardMenuItem; active: boolean; onHighlight: () => void }) {
  useAppCommand(item.command, item.open)
  const keys = useCommandKeys(item.command)
  return <Inline as='li' id={id} role='menuitem' aria-keyshortcuts={keys.join(' ') || undefined} gap={2} align='center'
    onClick={item.open} onMouseMove={active ? undefined : onHighlight}>
    <KeyHint command={item.command} />
    <Text weight={active ? 'semibold' : 'regular'} tone={active ? 'accent' : 'default'}>{item.label}</Text>
    {active && <Icon name='chevron-right' size={16} aria-hidden='true' />}
  </Inline>
}
