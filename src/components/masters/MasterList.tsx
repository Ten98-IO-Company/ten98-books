import { Icon, Inline, ShortcutScope, Stack, Text } from '@ten98/ui'
import { memo, useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { contextTitles } from '../../lib/commands'
import { useAppCommand } from '../KeyboardShell'

export type ListEntry = {
  key: string
  /** Rows a cursor can rest on; others (section headings) only label what follows. */
  cursor: boolean
  /** 1 for the top level; drives the tree's levels and the indentation. */
  depth: number
  content: ReactNode
  /** Right-hand text such as an amount. */
  trailing?: ReactNode
  /** The row's name for assistive technology when `content` is not plain text. */
  label?: string
}

/**
 * A list or tree of masters driven by the shortcut registry in the list context (inside a `ListScope`): Up, Down, Home and End move the
 * highlight, Enter opens it. Focus stays on the list and the highlighted row is its active descendant, like the company
 * menu. A list with `onQueryChange` also filters as the user types on it (printable keys act only while the list has
 * focus, WCAG 2.1.4); Backspace edits the text and Escape clears it before it can leave the screen. Entries must be a stable array (memoised by the caller) so a move re-renders two rows, not hundreds.
 */
/** The list context for a screen: its commands (movement, open, create, delete, history) register inside it. */
export function ListScope({ children }: { children: ReactNode }) {
  return <ShortcutScope name={contextTitles.list}>{children}</ShortcutScope>
}

export function MasterList({ label, entries, active, onActiveChange, onOpen, query, onQueryChange, focusList = false, emptyMessage }: {
  label: string
  entries: readonly ListEntry[]
  active: string | null
  onActiveChange: (key: string) => void
  onOpen: (key: string) => void
  /** Type-ahead filter text, kept by the caller. With `onQueryChange`, printable keys typed on the focused list build it. */
  query?: string
  onQueryChange?: (query: string) => void
  /** Moves focus to the list when it first has entries. */
  focusList?: boolean
  emptyMessage?: ReactNode
}) {
  const id = useId()
  const list = useRef<HTMLElement>(null)
  const cursors = entries.filter(entry => entry.cursor)
  const index = Math.max(0, cursors.findIndex(entry => entry.key === active))
  // Commands read the position from a ref, so keys pressed faster than React renders still move one step each.
  const position = useRef(index)
  position.current = index
  const latest = useRef({ cursors, onActiveChange, onOpen })
  latest.current = { cursors, onActiveChange, onOpen }
  const move = (to: number) => {
    const { cursors: rows, onActiveChange: change } = latest.current
    if (!rows.length) return
    position.current = Math.min(rows.length - 1, Math.max(0, to))
    change(rows[position.current].key)
  }
  useAppCommand('list.next', () => move(position.current + 1), { repeat: true })
  useAppCommand('list.previous', () => move(position.current - 1), { repeat: true })
  useAppCommand('list.first', () => move(0))
  useAppCommand('list.last', () => move(latest.current.cursors.length - 1))
  useAppCommand('list.open', () => { const row = latest.current.cursors[position.current]; if (row) latest.current.onOpen(row.key) })

  // Type-ahead: the text lives with the caller, the keys are read here, on the focused list only.
  const typed = (event: KeyboardEvent<HTMLElement>) => {
    if (!onQueryChange || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
    const text = query ?? ''
    if (event.key === 'Escape' && text) onQueryChange('')
    else if (event.key === 'Backspace' && text) onQueryChange(text.slice(0, -1))
    else if (event.key.length === 1 && (event.key !== ' ' || text)) onQueryChange(text + event.key)
    else return
    // Handled here: the shortcut layer above must not also run Escape (leave) or Space (scroll) for this key.
    event.preventDefault(); event.stopPropagation()
  }

  const current = cursors[index]?.key ?? null
  const hasEntries = entries.length > 0
  useEffect(() => { if (focusList) list.current?.focus() }, [focusList, hasEntries])
  useEffect(() => { if (current) document.getElementById(`${id}${current}`)?.scrollIntoView({ block: 'nearest' }) }, [current, id])
  const pick = useCallback((key: string) => latest.current.onOpen(key), [])
  const highlight = useCallback((key: string) => latest.current.onActiveChange(key), [])

  const none = <Text tone='muted'>{emptyMessage ?? 'Nothing to show.'}</Text>
  // A filtered-out list keeps its focusable frame so Backspace can still widen the filter.
  if (!hasEntries && !onQueryChange) return none
  return <Stack as='div' role='tree' ref={list} tabIndex={0} aria-label={label} onKeyDown={typed} aria-activedescendant={current ? `${id}${current}` : undefined} gap={1}>
    {!hasEntries && none}
    {entries.map(entry => <Row key={entry.key} id={`${id}${entry.key}`} entry={entry} active={entry.key === current} onPick={pick} onHighlight={highlight} />)}
  </Stack>
}

const Row = memo(function Row({ id, entry, active, onPick, onHighlight }: { id: string; entry: ListEntry; active: boolean; onPick: (key: string) => void; onHighlight: (key: string) => void }) {
  if (!entry.cursor) return <Text as='div' role='presentation' size='sm' weight='semibold' tone='muted'>{entry.content}</Text>
  return <Inline as='div' id={id} role='treeitem' aria-level={entry.depth} aria-selected={active} aria-label={entry.label} gap={2} align='center' justify='between' wrap={false}
    onClick={() => onPick(entry.key)} onMouseMove={active ? undefined : () => onHighlight(entry.key)}>
    <Inline as='div' gap={2} align='center' wrap={false}>
      <Text as='span' aria-hidden='true'>{'\u2003'.repeat(Math.max(0, entry.depth - 1))}</Text>
      {active ? <Icon name='chevron-right' size={16} aria-hidden='true' /> : <Text as='span' aria-hidden='true'>{'\u2003'}</Text>}
      {entry.content}
    </Inline>
    {entry.trailing}
  </Inline>
})
