import { Alert, Badge, Button, Inline, KeyHint, PageHeader, Stack, StatusLine, Text, useConfirmDialog } from '@ten98/ui'
import { DialogKeys, useAppCommand } from '../KeyboardShell'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useApp, useCompany } from '../../lib/app-context'
import { buildCostRows, categoryDeleteReason, categoryUse, centrePath, type CostCategoryRow, type CostListRow } from '../../lib/cost-centre-forms'
import { isolate } from '../../lib/masters'
import { FailureAlert, useMasterRequest } from './entry'
import { takeFlash } from './flash'
import { ListScope, MasterList, type ListEntry } from './MasterList'
import { useCanWrite } from './useCanWrite'
import { useCostData } from './useCostData'

/** Where the cursor was per company in this tab, so coming back from an alter screen lands on the same row. */
const lastCursor = new Map<string, string>()

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`
const allocates = (category: CostCategoryRow) => `Used on ${categoryUse(category)}`

/** One row of the list; the accessible name says where the row sits, because a flat list cannot show nesting by structure. */
function entryOf(row: CostListRow, centres: Parameters<typeof centrePath>[0]): ListEntry {
  if (row.kind === 'category') {
    const { category } = row
    return {
      key: row.key, cursor: true, depth: 1,
      label: `Cost category ${category.name}${category.systemKey ? ', built-in' : ''}, ${count(row.centres, 'centre', 'centres')}, ${allocates(category)}`,
      content: active => <Inline as='div' gap={2} align='center'>
        <Text weight='semibold' tone={active ? 'accent' : 'default'}>{isolate(category.name)}</Text>
        {category.secondLanguageName && <Text tone='muted' size='sm'>{isolate(category.secondLanguageName)}</Text>}
        {category.systemKey && <Badge>Built-in</Badge>}
        <Text tone='muted' size='sm'>{count(row.centres, 'centre', 'centres')} · {allocates(category)}</Text>
      </Inline>,
    }
  }
  const { centre } = row
  const under = centre.parentId ? centrePath(centres, centre.parentId).join(' › ') : ''
  const away = row.parent ? `under ${row.parent.name}, which is in ${row.parent.categoryName}` : ''
  return {
    key: row.key, cursor: true, depth: row.depth,
    label: `Cost centre ${centre.name}, in ${centre.categoryName}${under ? `, under ${under}` : ''}${row.subCentres ? `, ${count(row.subCentres, 'sub-centre', 'sub-centres')}` : ''}`,
    content: active => <Inline as='div' gap={2} align='center'>
      <Text tone={active ? 'accent' : 'default'}>{isolate(centre.name)}</Text>
      {centre.secondLanguageName && <Text tone='muted' size='sm'>{isolate(centre.secondLanguageName)}</Text>}
      {row.subCentres > 0 && <Text tone='muted' size='sm'>{count(row.subCentres, 'sub-centre', 'sub-centres')}</Text>}
      {away && <Text tone='muted' size='sm'>{isolate(away)}</Text>}
    </Inline>,
  }
}

/** Cost categories with their centres as a tree, the company's cost centres switch, and the actions on a row. */
export function CostCentreList() {
  return <ListScope><ListBody /></ListScope>
}

function ListBody() {
  const company = useCompany()
  const navigate = useNavigate()
  const { current } = useApp()
  const writer = useCanWrite()
  const canWrite = writer === true
  // Only an owner or an admin switches the feature; the server refuses anyone else as not found.
  const canSwitch = current?.role === 'owner' || current?.role === 'admin'
  const { categories, centres, enabled, error, reload } = useCostData(company.id)
  const [active, setActive] = useState<string | null>(() => lastCursor.get(company.id) ?? null)
  const [message, setMessage] = useState(takeFlash)
  const { busy, failure, run } = useMasterRequest()
  const [confirm, dialog] = useConfirmDialog()
  const rows = useMemo(() => categories && centres ? buildCostRows(categories, centres) : [], [categories, centres])
  const entries = useMemo(() => rows.map(row => entryOf(row, centres ?? [])), [rows, centres])
  const row = rows.find(item => item.key === active) ?? rows[0]
  const latest = useRef({ row })
  latest.current = { row }
  // A closed dialog and a reload can leave focus on the page; it returns to the list, where the cursor is.
  const list = useRef<HTMLElement>(null)
  const focusList = () => { window.setTimeout(() => list.current?.focus(), 0) }

  const move = (key: string) => { lastCursor.set(company.id, key); setActive(key) }
  const open = (kind: 'edit' | 'history' | 'move', target: CostListRow) => {
    lastCursor.set(company.id, target.key)
    const params = { companyId: company.id }
    if (target.kind === 'category') void navigate(kind === 'history'
      ? { to: '/app/c/$companyId/masters/history/cost-category/$categoryId', params: { ...params, categoryId: target.id } }
      : { to: '/app/c/$companyId/masters/edit/cost-category/$categoryId', params: { ...params, categoryId: target.id } })
    else void navigate(kind === 'history'
      ? { to: '/app/c/$companyId/masters/history/cost-centre/$centreId', params: { ...params, centreId: target.id } }
      : { to: '/app/c/$companyId/masters/edit/cost-centre/$centreId', params: { ...params, centreId: target.id }, search: kind === 'move' ? { move: true } : {} })
  }
  // A new centre starts in the highlighted category, or beside the highlighted centre (same category, same parent).
  const createCentre = () => {
    const target = latest.current.row
    const search = !target ? {} : target.kind === 'category' ? { category: target.id } : { category: target.centre.categoryId, ...target.parent === null && target.centre.parentId ? { parent: target.centre.parentId } : {} }
    void navigate({ to: '/app/c/$companyId/masters/new/cost-centre', params: { companyId: company.id }, search })
  }
  const createCategory = () => void navigate({ to: '/app/c/$companyId/masters/new/cost-category', params: { companyId: company.id } })

  const reason = row?.kind === 'category' ? categoryDeleteReason(row.category) : null

  async function remove() {
    const target = latest.current.row
    if (!target || !canWrite || busy || (target.kind === 'category' && categoryDeleteReason(target.category))) return
    const centre = target.kind === 'centre'
    const name = centre ? target.centre.name : target.category.name
    const revision = centre ? target.centre.revision : target.category.revision
    const noun = centre ? 'cost centre' : 'cost category'
    if (!await confirm({ title: `Delete the ${noun} “${name}”?`, description: `The ${noun} is removed. Its history stays available. ${centre ? 'A centre that holds sub-centres or is used in vouchers' : 'A category that holds centres or is used in vouchers'} cannot be deleted.`, confirmLabel: `Delete ${noun}`, danger: true })) { focusList(); return }
    const next = rows[rows.indexOf(target) + 1] ?? rows[rows.indexOf(target) - 1]
    setMessage('')
    const done = await run(() => api(`/api/companies/${company.id}/${centre ? 'cost-centres' : 'cost-categories'}/${target.id}/delete`, { method: 'POST', body: { revision } }))
    focusList()
    // A refusal can mean the list is out of date (changed by someone else, already gone): read it again.
    if (!done) { reload(); return }
    if (next) move(next.key)
    setMessage(`Deleted ${noun} “${name}”.`)
    reload()
  }

  async function toggle() {
    if (!canSwitch || busy || enabled === null) return
    const next = !enabled
    if (!next && !await confirm({ title: 'Switch cost centres off?', description: 'Vouchers stop asking for cost centres and new allocations are dropped. What is already saved stays, and the reports still count it.', confirmLabel: 'Switch off', danger: true })) { focusList(); return }
    setMessage('')
    const done = await run(() => api(`/api/companies/${company.id}/cost-centres-setting`, { method: 'POST', body: { enabled: next } }))
    focusList()
    if (!done) return
    setMessage(`Cost centres are now ${next ? 'on' : 'off'} for this company.`)
    reload()
  }

  useAppCommand('list.create', createCentre, { enabled: canWrite && categories !== null })
  useAppCommand('list.delete', () => void remove(), { enabled: canWrite && row !== undefined && !reason })
  useAppCommand('list.history', () => { if (row) open('history', row) }, { enabled: row !== undefined })
  useAppCommand('list.move', () => { if (row?.kind === 'centre') open('move', row) }, { enabled: canWrite && row?.kind === 'centre' })
  useAppCommand('list.switch', () => void toggle(), { enabled: canSwitch && enabled !== null })

  return <Stack gap={4}>
    <PageHeader eyebrow='Masters' title='Cost categories and centres'
      description={categories && centres ? `${count(categories.length, 'category', 'categories')} and ${count(centres.length, 'centre', 'centres')}. Use the arrow keys, then Enter to alter the highlighted row.` : 'Loading…'}
      actions={canWrite ? <Inline gap={2}>
        <Button variant='secondary' onClick={createCentre}>Create cost centre</Button>
        <Button variant='secondary' onClick={createCategory}>Create cost category</Button>
      </Inline> : undefined} />
    {enabled === false && <Alert tone='info' title='Cost centres are switched off for this company'
      actions={canSwitch ? <Button size='sm' onClick={() => void toggle()} disabled={busy}>Switch on <KeyHint command='list.switch' /></Button> : undefined}>
      Vouchers do not ask for cost centres until they are switched on. You can set up categories and centres now.{canSwitch ? '' : ' Ask an owner or admin to switch them on.'}
    </Alert>}
    {enabled === true && <Inline gap={2} align='center'>
      <Text tone='muted'>Cost centres are on: vouchers ask for them on ledgers that take them.</Text>
      {canSwitch && <Button size='sm' variant='ghost' onClick={() => void toggle()} disabled={busy}>Switch off <KeyHint command='list.switch' /></Button>}
    </Inline>}
    {writer === false && <Alert tone='info'>Viewers can read cost categories and centres but not change them.</Alert>}
    {message && <StatusLine tone='success' live='polite'>{message}</StatusLine>}
    <FailureAlert failure={failure} onReload={reload} />
    {error && <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>Cost categories and centres could not be loaded: {error}</Alert>}
    {categories && centres && <MasterList label='Cost categories and centres' entries={entries} active={row?.key ?? null} onActiveChange={move} openHint='Enter to alter' focusList listRef={list}
      onOpen={key => { const target = rows.find(item => item.key === key); if (target) open('edit', target) }} />}
    {categories && centres && centres.length === 0 && <Text tone='muted'>No cost centres yet.{canWrite && <> Create the first with the button above or <KeyHint command='list.create' />.</>}</Text>}
    {canWrite && reason && <Text tone='muted' size='sm'>Delete is unavailable for the highlighted row: {reason}</Text>}
    <DialogKeys name='Confirm' open={!!dialog}>{dialog}</DialogKeys>
  </Stack>
}
