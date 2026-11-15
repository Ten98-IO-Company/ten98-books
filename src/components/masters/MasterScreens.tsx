import { Alert, Button, DataTable, DisplayFormatProvider, EmptyState, PageHeader, Stack, StatusLine, Text, useDisplayFormat } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import type { MoneyExponent } from '@ten98/runtime/browser'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp, useCompany } from '../../lib/app-context'
import { describeLedgerCostChange } from '../../lib/cost-centre-forms'
import { actionTitles, actorLabel, describeChanges, type RevisionRow, isolate } from '../../lib/masters'
import { useLeave } from './entry'
import { rememberChoice, rememberedGroup } from './flash'
import { GroupForm } from './GroupForm'
import { LedgerForm } from './LedgerForm'
import { useCanWrite } from './useCanWrite'
import { useMasterData } from './useMasterData'
import { useBackOverride } from '../KeyboardShell'

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
  const canWrite = useCanWrite()
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  // Remembered so the choice list comes back on what was being created.
  useEffect(() => rememberChoice(company.id, kind), [company.id, kind])
  if (canWrite === undefined) return <StatusLine busy>Loading…</StatusLine>
  if (!canWrite) return <Alert tone='info'>Viewers cannot create masters. Ask an owner, admin or editor of the company.</Alert>
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
  const canWrite = useCanWrite()
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  if (error) return <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>The chart could not be loaded: {error}</Alert>
  if (!groups || !ledgers || canWrite === undefined) return <StatusLine busy>Loading…</StatusLine>
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
  const company = useCompany()
  const exponent = company.currencyMinorUnits as MoneyExponent
  const { groups, ledgers } = useMasterData(company.id)
  const wanted = id.toLowerCase()
  const name = kind === 'group' ? groups?.find(group => group.id === wanted)?.name : ledgers?.find(ledger => ledger.id === wanted)?.name
  const groupName = (groupId: string) => groups?.find(group => group.id === groupId)?.name ?? null
  return <RevisionHistory noun={kind} path={`${kind}s/${wanted}`} name={name} back={{ to: '/app/c/$companyId/masters/chart-of-accounts', params: { companyId: company.id } }}
    describe={row => [...describeChanges(row, exponent, groupName), ...describeLedgerCostChange(row)]} />
}

/**
 * The history of one master (`path` is its collection and id under the company, such as `groups/<id>`): who changed it,
 * when and what, newest first. `name` is the master's present name when the screen knows it; a deleted one is named from
 * its last entry. Escape (the shell's go-back command, the only Escape command here) returns to the row it was opened from.
 */
export function RevisionHistory(props: HistoryProps) {
  const company = useCompany()
  return <DisplayFormatProvider locale='en-GB' timeZone={company.timeZone}><RevisionTable {...props} /></DisplayFormatProvider>
}

type HistoryProps = { noun: string; path: string; name?: string; back: { to: string; params: Record<string, string> }; describe: (row: RevisionRow) => string[] }

function RevisionTable({ noun, path, name, back, describe }: HistoryProps) {
  const company = useCompany()
  const { dateTime } = useDisplayFormat()
  const { me, unauthorized } = useApp()
  const leave = useLeave(back)
  const [revisions, setRevisions] = useState<RevisionRow[] | null>(null)
  const [error, setError] = useState('')
  useBackOverride(leave)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    api<{ revisions: RevisionRow[] }>(`/api/companies/${company.id}/${path}/revisions`, { signal: controller.signal })
      .then(result => setRevisions(result.revisions))
      .catch(cause => { if (controller.signal.aborted) return; if (cause instanceof ApiError && cause.status === 401) unauthorized(); else setError(errMsg(cause)) })
    return () => controller.abort()
  }, [company.id, path])

  const shownName = name ?? ((revisions?.at(-1)?.after ?? revisions?.at(-1)?.before) as { name?: string } | null | undefined)?.name
  const rows = useMemo(() => [...(revisions ?? [])].reverse(), [revisions])

  return <Stack gap={4}>
    <PageHeader eyebrow='Masters' title={shownName ? <>History of {isolate(shownName)}</> : `History of this ${noun}`}
      description={`Every change to this ${noun}, newest first. Times are in ${company.timeZone}. Press Escape to go back.`}
      actions={<Button variant='secondary' autoFocus onClick={leave}>Back</Button>} />
    {error && <Alert tone='danger'>The history could not be loaded: {error}</Alert>}
    {!revisions && !error && <StatusLine busy>Loading the history…</StatusLine>}
    {revisions && <DataTable<RevisionRow> ariaLabel={`History of this ${noun}`} rows={rows} rowKey={row => row.id} searchable={false} sortable={false} pagination={false} density='compact' responsive='stack'
      emptyTitle='No history yet' emptyDescription={`Nothing has changed this ${noun}.`}
      columns={[
        { key: 'when', header: 'When', render: row => <Text as='time' dateTime={row.at}>{dateTime(row.at)}</Text>, wrap: true },
        // The server names every member; `actorName` is null once that user no longer exists.
        { key: 'who', header: 'Who', render: row => actorLabel(row.actorId, row.actorName, me.user), wrap: true },
        { key: 'action', header: 'What happened', render: row => actionTitles[row.action] },
        { key: 'changes', header: 'Details', wrap: true, minWidth: 'lg', render: row => {
          const lines = describe(row)
          return lines.length ? <Stack as='ul' gap={0}>{lines.map(line => <Stack as='li' key={line}>{isolate(line)}</Stack>)}</Stack> : <Text tone='muted'>No visible change</Text>
        } },
      ]} />}
  </Stack>
}
