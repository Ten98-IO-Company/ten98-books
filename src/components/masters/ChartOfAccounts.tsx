import { Alert, Badge, Button, EmptyState, Inline, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useCompany } from '../../lib/app-context'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { buildChartRows, displayAmount, groupDeleteReason, isCursorRow, isolate, ledgerDeleteReason, type ChartRow, type GroupRow } from '../../lib/masters'
import { takeFlash } from './flash'
import { ListScope, MasterList, type ListEntry } from './MasterList'
import { useAppCommand } from '../KeyboardShell'
import { useMasterRequest, FailureAlert } from './entry'
import { useCanWrite } from './useCanWrite'
import { useMasterData } from './useMasterData'

/** Where the cursor was per company in this tab, so coming back from an alter screen lands on the same row. */
const lastCursor = new Map<string, string>()

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`

/** One row of the list. The accessible name says where the row sits, because a flat list cannot show nesting by structure. */
function entryOf(row: ChartRow, exponent: MoneyExponent, byId: Map<string, GroupRow>): ListEntry {
  if (row.kind === 'heading') return { key: row.key, cursor: false, depth: 0, content: `${row.label} · ${count(row.groups, 'group', 'groups')}, ${count(row.ledgers, 'ledger', 'ledgers')}` }
  if (row.kind === 'group') {
    const { group } = row
    const parent = group.parentId ? byId.get(group.parentId)?.name : undefined
    const holds = [row.groups ? count(row.groups, 'sub-group', 'sub-groups') : '', row.ledgers ? count(row.ledgers, 'ledger', 'ledgers') : ''].filter(Boolean).join(' · ') || 'Empty'
    return {
      key: row.key, cursor: true, depth: row.depth,
      label: `Group ${group.name}${parent ? `, in ${parent}` : ', primary'}${group.systemKey ? ', built-in' : ''}, ${holds}`,
      content: active => <Inline as='div' gap={2} align='center'>
        <Text weight='semibold' tone={active ? 'accent' : 'default'}>{isolate(group.name)}</Text>
        {group.secondLanguageName && <Text tone='muted' size='sm'>{isolate(group.secondLanguageName)}</Text>}
        {group.systemKey && <Badge>Built-in</Badge>}
        <Text tone='muted' size='sm'>{holds}</Text>
      </Inline>,
    }
  }
  const { ledger } = row
  const empty = ledger.opening.amount.replace(/[0.]/g, '') === ''
  const opening = empty ? 'no opening balance' : `opening balance ${displayAmount(ledger.opening.amount, exponent)} ${ledger.opening.side === 'Dr' ? 'debit' : 'credit'}`
  return {
    key: row.key, cursor: true, depth: row.depth,
    label: `Ledger ${ledger.name}${ledger.groupId ? `, in ${byId.get(ledger.groupId)?.name ?? 'a group'}` : ', outside every group'}${ledger.systemKey ? ', built-in' : ''}, ${opening}`,
    content: active => <Inline as='div' gap={2} align='center'>
      <Text tone={active ? 'accent' : 'default'}>{isolate(ledger.name)}</Text>
      {ledger.secondLanguageName && <Text tone='muted' size='sm'>{isolate(ledger.secondLanguageName)}</Text>}
      {ledger.systemKey && <Badge>Built-in</Badge>}
    </Inline>,
    trailing: empty ? <Text tone='muted' size='sm'>No opening balance</Text> : <Text numeric dir='ltr'>{displayAmount(ledger.opening.amount, exponent)} {ledger.opening.side}</Text>,
  }
}

/** The chart of accounts: groups and ledgers as an indented tree under their nature. */
export function ChartOfAccounts() {
  return <ListScope><ChartBody /></ListScope>
}

function ChartBody() {
  const company = useCompany()
  const navigate = useNavigate()
  const exponent = company.currencyMinorUnits as MoneyExponent
  const canWrite = useCanWrite() === true
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  const [active, setActive] = useState<string | null>(() => lastCursor.get(company.id) ?? null)
  const [message, setMessage] = useState(takeFlash)
  const { busy, failure, run } = useMasterRequest()
  const [confirm, dialog] = useConfirmDialog()
  const rows = useMemo(() => groups && ledgers ? buildChartRows(groups, ledgers) : [], [groups, ledgers])
  const entries = useMemo(() => { const byId = new Map((groups ?? []).map(group => [group.id, group])); return rows.map(row => entryOf(row, exponent, byId)) }, [rows, groups, exponent])
  const cursors = rows.filter(isCursorRow)
  const current = cursors.find(row => row.key === active) ?? cursors[0]
  const latest = useRef({ current })
  latest.current = { current }

  const move = (key: string) => { lastCursor.set(company.id, key); setActive(key) }
  const go = (kind: 'edit' | 'history', row: NonNullable<typeof current>) => {
    lastCursor.set(company.id, row.key)
    if (kind === 'edit') void navigate(row.kind === 'group'
      ? { to: '/app/c/$companyId/masters/edit/group/$groupId', params: { companyId: company.id, groupId: row.id } }
      : { to: '/app/c/$companyId/masters/edit/ledger/$ledgerId', params: { companyId: company.id, ledgerId: row.id } })
    else void navigate(row.kind === 'group'
      ? { to: '/app/c/$companyId/masters/history/group/$groupId', params: { companyId: company.id, groupId: row.id } }
      : { to: '/app/c/$companyId/masters/history/ledger/$ledgerId', params: { companyId: company.id, ledgerId: row.id } })
  }

  const reason = !current || !groups || !ledgers ? null
    : current.kind === 'group' ? groupDeleteReason(current.group, groups, ledgers) : ledgerDeleteReason(current.ledger)

  async function remove() {
    const row = latest.current.current
    if (!row || !canWrite || busy || reason) return
    const name = row.kind === 'group' ? row.group.name : row.ledger.name
    const revision = row.kind === 'group' ? row.group.revision : row.ledger.revision
    if (!await confirm({ title: `Delete the ${row.kind} “${name}”?`, description: `The ${row.kind} is removed from the chart. Its history stays available.${row.kind === 'ledger' ? ' A ledger used in vouchers cannot be deleted.' : ''}`, confirmLabel: `Delete ${row.kind}`, danger: true })) return
    const next = cursors[cursors.indexOf(row) + 1] ?? cursors[cursors.indexOf(row) - 1]
    const done = await run(() => api(`/api/companies/${company.id}/${row.kind === 'group' ? 'groups' : 'ledgers'}/${row.id}/delete`, { method: 'POST', body: { revision } }))
    if (!done) return
    if (next) move(next.key)
    setMessage(`Deleted ${row.kind} “${name}”.`)
    reload()
  }

  // The group (or the ledger's group) under the cursor is where a new master starts.
  const under = current ? current.kind === 'group' ? current.id : current.ledger.groupId ?? undefined : undefined
  useAppCommand('list.create', () => void navigate({ to: '/app/c/$companyId/masters/new', params: { companyId: company.id }, search: under ? { under } : {} }), { enabled: canWrite })
  useAppCommand('list.delete', () => void remove(), { enabled: canWrite && current !== undefined && !reason })
  useAppCommand('list.history', () => { if (current) go('history', current) }, { enabled: current !== undefined })

  return <Stack gap={4}>
    <PageHeader eyebrow='Masters' title='Chart of accounts'
      description={groups && ledgers ? `${count(groups.length, 'group', 'groups')} and ${count(ledgers.length, 'ledger', 'ledgers')}. Use the arrow keys, then Enter to alter the highlighted row.` : 'Loading the chart…'}
      actions={canWrite ? <Button variant='secondary' onClick={() => void navigate({ to: '/app/c/$companyId/masters/new', params: { companyId: company.id }, search: under ? { under } : {} })}>Create</Button> : undefined} />
    {!canWrite && <Alert tone='info'>Viewers can read the chart but not change it.</Alert>}
    {message && <StatusLine tone='success' live='polite'>{message}</StatusLine>}
    <FailureAlert failure={failure} />
    {error && <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>The chart could not be loaded: {error}</Alert>}
    {groups && ledgers && (rows.length
      ? <MasterList label='Chart of accounts' entries={entries} active={current?.key ?? null} onActiveChange={move} openHint='Enter to alter' focusList
        onOpen={key => { const row = cursors.find(item => item.key === key); if (row) go('edit', row) }} />
      : <EmptyState icon='book' title='The chart is empty' description='Create a group or a ledger to start.' />)}
    {canWrite && reason && <Text tone='muted' size='sm'>Delete is unavailable for the highlighted row: {reason}</Text>}
    {dialog}
  </Stack>
}
