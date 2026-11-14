import { Alert, Button, DataTable, EmptyState, PageHeader, Stack, StatusLine, Text } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp, useCompany } from '../../lib/app-context'
import { actionTitles, describeChanges, type RevisionRow, isolate } from '../../lib/masters'
import { EntryScope, useLeave } from './entry'
import { rememberedGroup } from './flash'
import { GroupForm } from './GroupForm'
import { LedgerForm } from './LedgerForm'
import { useMasterData } from './useMasterData'
import { useAppCommand } from '../KeyboardShell'

export type MasterKind = 'group' | 'ledger'

/**
 * The group a new entry starts under: the one the chart highlighted (`under`), else the last one used in this tab,
 * else the seeded Current Assets group (found by its built-in key, never its name), else none.
 */
function startGroup(companyId: string, groups: { id: string; systemKey: string | null }[], under?: string): string {
  const known = (id: string | undefined) => id !== undefined && groups.some(group => group.id === id) ? id : undefined
  return known(under) ?? known(rememberedGroup(companyId)) ?? groups.find(group => group.systemKey === 'current_assets')?.id ?? ''
}

/** `/masters/new/group` and `/masters/new/ledger`. */
export function CreateMaster({ kind, under }: { kind: MasterKind; under?: string }) {
  const company = useCompany()
  const { workspace } = useApp()
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  if (workspace.role === 'viewer') return <Alert tone='info'>Viewers cannot create masters. Ask a workspace owner, admin or editor.</Alert>
  if (error) return <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>The chart could not be loaded: {error}</Alert>
  if (!groups || !ledgers) return <StatusLine busy>Loading the chart…</StatusLine>
  const initialGroupId = startGroup(company.id, groups, under)
  return kind === 'group'
    ? <GroupForm groups={groups} ledgers={ledgers} initialGroupId={initialGroupId} reloadData={reload} />
    : <LedgerForm groups={groups} ledgers={ledgers} initialGroupId={initialGroupId} reloadData={reload} />
}

/** `/masters/edit/group/$id` and `/masters/edit/ledger/$id`. The form is keyed by the revision, so a reload replaces what was typed. */
export function AlterMaster({ kind, id }: { kind: MasterKind; id: string }) {
  const company = useCompany()
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  if (error) return <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>The chart could not be loaded: {error}</Alert>
  if (!groups || !ledgers) return <StatusLine busy>Loading…</StatusLine>
  const wanted = id.toLowerCase()
  if (kind === 'group') {
    const existing = groups.find(group => group.id === wanted)
    return existing ? <GroupForm key={existing.revision} groups={groups} ledgers={ledgers} existing={existing} reloadData={reload} /> : <Missing kind='group' />
  }
  const existing = ledgers.find(ledger => ledger.id === wanted)
  return existing ? <LedgerForm key={existing.revision} groups={groups} ledgers={ledgers} existing={existing} reloadData={reload} /> : <Missing kind='ledger' />
}

function Missing({ kind }: { kind: MasterKind }) {
  const company = useCompany()
  const navigate = useNavigate()
  return <EmptyState icon='book' title={`This ${kind} was not found`} description='It may have been deleted. The chart shows what exists.'
    action={<Button variant='secondary' onClick={() => void navigate({ to: '/app/c/$companyId/masters/chart-of-accounts', params: { companyId: company.id } })}>Open the chart of accounts</Button>} />
}

/** `/masters/history/group/$id` and `.../ledger/$id`: who changed the master, when and what. */
export function MasterHistory({ kind, id }: { kind: MasterKind; id: string }) {
  return <EntryScope><HistoryBody kind={kind} id={id} /></EntryScope>
}

function HistoryBody({ kind, id }: { kind: MasterKind; id: string }) {
  const company = useCompany()
  const { me, unauthorized } = useApp()
  const exponent = company.currencyMinorUnits as MoneyExponent
  const leave = useLeave({ to: '/app/c/$companyId/masters/chart-of-accounts', params: { companyId: company.id } })
  const { groups, ledgers } = useMasterData(company.id)
  const [revisions, setRevisions] = useState<RevisionRow[] | null>(null)
  const [error, setError] = useState('')
  const wanted = id.toLowerCase()
  // Esc on a history screen goes back one level, to the row it was opened from.
  useAppCommand('entry.cancel', leave, { allowInTextInput: true })

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    api<{ revisions: RevisionRow[] }>(`/api/companies/${company.id}/${kind}s/${wanted}/revisions`, { signal: controller.signal })
      .then(result => setRevisions(result.revisions))
      .catch(cause => { if (controller.signal.aborted) return; if (cause instanceof ApiError && cause.status === 401) unauthorized(); else setError(errMsg(cause)) })
    return () => controller.abort()
  }, [company.id, kind, wanted])

  const name = (kind === 'group' ? groups?.find(group => group.id === wanted)?.name : ledgers?.find(ledger => ledger.id === wanted)?.name)
    ?? ((revisions?.at(-1)?.after ?? revisions?.at(-1)?.before) as { name?: string } | null | undefined)?.name
  const groupName = (groupId: string) => groups?.find(group => group.id === groupId)?.name ?? null
  const formatter = useMemo(() => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: company.timeZone }), [company.timeZone])
  const rows = useMemo(() => [...(revisions ?? [])].reverse(), [revisions])

  return <Stack gap={4}>
    <PageHeader eyebrow='Masters' title={name ? <>History of {isolate(name)}</> : `History of this ${kind}`}
      description={`Every change to this ${kind}, newest first. Times are in ${company.timeZone}. Press Escape to go back.`}
      actions={<Button variant='secondary' autoFocus onClick={leave}>Back</Button>} />
    {error && <Alert tone='danger'>The history could not be loaded: {error}</Alert>}
    {!revisions && !error && <StatusLine busy>Loading the history…</StatusLine>}
    {revisions && <DataTable<RevisionRow> ariaLabel={`History of this ${kind}`} rows={rows} rowKey={row => row.id} searchable={false} sortable={false} pagination={false} density='compact' responsive='stack'
      emptyTitle='No history yet' emptyDescription={`Nothing has changed this ${kind}.`}
      columns={[
        { key: 'when', header: 'When', render: row => <Text as='time' dateTime={row.at}>{formatter.format(new Date(row.at))}</Text>, wrap: true },
        // The log keeps who by id; names are not exposed to every role yet, so the signed-in user sees their own entries as "You".
        { key: 'who', header: 'Who', render: row => row.actorId === me.user.id ? `You (${me.user.name || me.user.email})` : 'Another member', wrap: true },
        { key: 'action', header: 'What happened', render: row => actionTitles[row.action] },
        { key: 'changes', header: 'Details', wrap: true, minWidth: 'lg', render: row => {
          const lines = describeChanges(row, exponent, groupName)
          return lines.length ? <Stack as='ul' gap={0}>{lines.map(line => <Stack as='li' key={line}>{isolate(line)}</Stack>)}</Stack> : <Text tone='muted'>No visible change</Text>
        } },
      ]} />}
  </Stack>
}
