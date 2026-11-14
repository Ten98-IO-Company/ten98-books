import { Badge, Icon, Inline, ShortcutScope, Stack, Text } from '@ten98/ui'
import { memo, useCallback, useEffect, useId, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { contextTitles } from '../../lib/commands'
import { useAppCommand } from '../KeyboardShell'

export type ListEntry = {
  key: string
  /** Rows a cursor can rest on; others (section headings) label the rows that follow them. */
  cursor: boolean
  /** 1 for the top level; indents the row. Nesting is also stated in `label`, which a flat list cannot express by structure. */
  depth: number
  /** What the row shows; a function receives whether the row is the highlighted one. */
  content: ReactNode | ((active: boolean) => ReactNode)
  /** Right-hand text such as an amount. */
  trailing?: ReactNode
  /** The row's accessible name, including where it sits when `content` alone would not say. */
  label?: string
}

/** The list context for a screen: its commands (movement, open, create, delete, history) register inside it. */
export function ListScope({ children }: { children: ReactNode }) {
  return <ShortcutScope name={contextTitles.list}>{children}</ShortcutScope>
}

/**
 * A list of masters driven by the shortcut registry in the list context (inside a `ListScope`): Up, Down, Home and End
 * move the highlight, Enter opens it. Focus stays on the list and the highlighted row is its active descendant, like the
 * company menu. It is a listbox with labelled groups (section headings stay exposed to assistive technology); the chart is
 * not an expandable tree, so no tree semantics are claimed.
 *
 * To be replaced by the keyboard list component requested from the design system (@ten98/ui has no list with
 * registry-driven movement, group headings and an active row today). Entries must be a stable array (memoised by the
 * caller) so a move re-renders two rows, not hundreds. `searchField` is true when a search field above the list owns the
 * focus: Up, Down and Enter then run from it, while Home and End keep moving its caret.
 */
export function MasterList({ label, entries, active, onActiveChange, onOpen, openHint = 'Enter to open', searchField = false, listRef, focusList = false, emptyMessage }: {
  label: string
  entries: readonly ListEntry[]
  active: string | null
  onActiveChange: (key: string) => void
  onOpen: (key: string) => void
  /** Shown beside the highlighted row, so the highlight cannot be missed. */
  openHint?: string
  searchField?: boolean
  /** The list element, so the screen can move focus to it. */
  listRef?: RefObject<HTMLElement | null>
  /** Moves focus to the list when it mounts. */
  focusList?: boolean
  emptyMessage?: ReactNode
}) {
  const id = useId()
  const own = useRef<HTMLElement>(null)
  const list = listRef ?? own
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
  useAppCommand('list.next', () => move(position.current + 1), { repeat: true, allowInTextInput: searchField })
  useAppCommand('list.previous', () => move(position.current - 1), { repeat: true, allowInTextInput: searchField })
  useAppCommand('list.first', () => move(0))
  useAppCommand('list.last', () => move(latest.current.cursors.length - 1))
  useAppCommand('list.open', () => { const row = latest.current.cursors[position.current]; if (row) latest.current.onOpen(row.key) }, { allowInTextInput: searchField })

  const current = cursors[index]?.key ?? null
  useEffect(() => { if (focusList) list.current?.focus() }, [focusList, list])
  useEffect(() => { if (current) document.getElementById(`${id}${current}`)?.scrollIntoView({ block: 'nearest' }) }, [current, id])
  const pick = useCallback((key: string) => latest.current.onOpen(key), [])
  const highlight = useCallback((key: string) => latest.current.onActiveChange(key), [])

  // A heading starts a labelled group of the rows after it.
  const sections = useMemo(() => {
    const out: { heading?: ListEntry; rows: ListEntry[] }[] = []
    for (const entry of entries) {
      if (!entry.cursor) out.push({ heading: entry, rows: [] })
      else { if (!out.length) out.push({ rows: [] }); out[out.length - 1].rows.push(entry) }
    }
    return out
  }, [entries])

  const row = (entry: ListEntry) => <Row key={entry.key} id={`${id}${entry.key}`} entry={entry} active={entry.key === current} hint={openHint} onPick={pick} onHighlight={highlight} />
  return <Stack as='div' role='listbox' ref={list} tabIndex={0} aria-label={label} aria-activedescendant={current ? `${id}${current}` : undefined} gap={1}>
    {entries.length === 0 && <Text tone='muted'>{emptyMessage ?? 'Nothing to show.'}</Text>}
    {sections.map((section, at) => section.heading
      ? <Stack as='div' role='group' key={section.heading.key} aria-labelledby={`${id}${section.heading.key}`} gap={1}>
        <Text as='div' id={`${id}${section.heading.key}`} size='sm' weight='semibold' tone='muted'>{section.heading.content as ReactNode}</Text>
        {section.rows.map(row)}
      </Stack>
      : <Stack as='div' key={`rows-${at}`} gap={1}>{section.rows.map(row)}</Stack>)}
  </Stack>
}

const Row = memo(function Row({ id, entry, active, hint, onPick, onHighlight }: {
  id: string; entry: ListEntry; active: boolean; hint: string; onPick: (key: string) => void; onHighlight: (key: string) => void
}) {
  return <Inline as='div' id={id} role='option' aria-selected={active} aria-label={entry.label} gap={2} align='center' justify='between' wrap={false}
    onClick={() => onPick(entry.key)} onMouseMove={active ? undefined : () => onHighlight(entry.key)}>
    <Inline as='div' gap={2} align='center' wrap={false}>
      <Text as='span' aria-hidden='true'>{' '.repeat(Math.max(0, entry.depth - 1))}</Text>
      {active ? <Icon name='chevron-right' size={16} aria-hidden='true' /> : <Text as='span' aria-hidden='true'>{' '}</Text>}
      {typeof entry.content === 'function' ? entry.content(active) : entry.content}
    </Inline>
    <Inline as='div' gap={2} align='center' wrap={false}>
      {entry.trailing}
      {/* The highlight is stated in words and colour, not by a marker alone; assistive technology has aria-selected. */}
      {active && <Badge tone='accent' aria-hidden='true'>{hint}</Badge>}
    </Inline>
  </Inline>
})
