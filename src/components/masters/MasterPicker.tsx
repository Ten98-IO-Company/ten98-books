import { Alert, Badge, Button, Inline, Input, PageHeader, Stack, StatusLine, Text } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { useCompany } from '../../lib/app-context'
import { centrePath } from '../../lib/cost-centre-forms'
import { groupPath, type GroupRow, type LedgerRow, isolate } from '../../lib/masters'
import { rememberedChoice, takeFlash } from './flash'
import { useAppCommand } from '../KeyboardShell'
import { ListScope, MasterList, type ListEntry } from './MasterList'
import { useCanWrite } from './useCanWrite'
import { useCostData } from './useCostData'
import { useMasterData } from './useMasterData'

/** `/masters/new`: choose what to create. */
export function NewMasterChoice({ under }: { under?: string }) {
  return <ListScope><NewMasterBody under={under} /></ListScope>
}

const choices = [
  { key: 'group', title: 'Group', note: 'A heading in the chart that holds sub-groups and ledgers.' },
  { key: 'ledger', title: 'Ledger', note: 'An account that vouchers post to, with an optional opening balance.' },
  { key: 'cost-category', title: 'Cost category', note: 'A way of grouping cost centres, such as by project or by branch.' },
  { key: 'cost-centre', title: 'Cost centre', note: 'A place or purpose that income and expense lines can be split over, in a cost category.' },
] as const

const createRoutes = {
  group: '/app/c/$companyId/masters/new/group', ledger: '/app/c/$companyId/masters/new/ledger',
  'cost-category': '/app/c/$companyId/masters/new/cost-category', 'cost-centre': '/app/c/$companyId/masters/new/cost-centre',
} as const

function NewMasterBody({ under }: { under?: string }) {
  const company = useCompany()
  const canWrite = useCanWrite()
  const navigate = useNavigate()
  const [active, setActive] = useState<string>(() => rememberedChoice(company.id))
  const entries = useMemo<ListEntry[]>(() => choices.map(choice => ({
    key: choice.key, cursor: true, depth: 1, label: choice.title,
    content: <Inline as='div' gap={2} align='baseline'><Text weight='semibold'>{choice.title}</Text><Text tone='muted' size='sm'>{choice.note}</Text></Inline>,
  })), [])
  // Only groups and ledgers start under the group the chart was on.
  const open = (key: string) => void navigate(key === 'group' || key === 'ledger'
    ? { to: createRoutes[key], params: { companyId: company.id }, search: under ? { under } : {} }
    : { to: createRoutes[key as 'cost-category' | 'cost-centre'], params: { companyId: company.id }, search: {} })
  if (canWrite === undefined) return <StatusLine busy>Loading…</StatusLine>
  if (!canWrite) return <Stack gap={4}><PageHeader eyebrow='Masters' title='Create a master' /><Alert tone='info'>Viewers cannot create masters. Ask an owner, admin or editor of the company.</Alert></Stack>
  return <Stack gap={4}>
    <PageHeader eyebrow='Masters' title='Create a master' description='Choose what to create with the arrow keys, then press Enter.' />
    <MasterList label='What to create' entries={entries} active={active} onActiveChange={setActive} onOpen={open} openHint='Enter to create' focusList />
  </Stack>
}

/** `/masters/edit`: a search field over a list of every group and ledger; Up, Down and Enter work from the field, Enter opens the highlighted one. */
export function EditMasterPicker() {
  return <ListScope><PickerBody /></ListScope>
}

type Candidate = { key: string; kind: 'group' | 'ledger' | 'cost-category' | 'cost-centre'; id: string; name: string; second: string | null; where: string; builtIn: boolean }
const kindTitles = { group: 'Group', ledger: 'Ledger', 'cost-category': 'Cost category', 'cost-centre': 'Cost centre' } as const

const normalise = (text: string) => text.toLocaleLowerCase()

function PickerBody() {
  const company = useCompany()
  // A viewer opens a master read-only, so the list says open, not alter; the keys are the same.
  const verb = useCanWrite() === false ? 'open' : 'alter'
  const navigate = useNavigate()
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  const cost = useCostData(company.id)
  const [query, setQuery] = useState('')
  const [message] = useState(takeFlash)
  const [active, setActive] = useState<string | null>(null)
  const list = useRef<HTMLElement>(null)
  const candidates = useMemo<Candidate[]>(() => groups && ledgers ? [
    ...groups.map((group: GroupRow) => ({ key: `group:${group.id}`, kind: 'group' as const, id: group.id, name: group.name, second: group.secondLanguageName, builtIn: group.systemKey !== null,
      where: group.parentId === null ? 'Primary group' : `In ${groupPath(groups, group.parentId).join(' › ')}` })),
    ...ledgers.map((ledger: LedgerRow) => ({ key: `ledger:${ledger.id}`, kind: 'ledger' as const, id: ledger.id, name: ledger.name, second: ledger.secondLanguageName, builtIn: ledger.systemKey !== null,
      where: ledger.groupId === null ? 'Outside every group' : `In ${groupPath(groups, ledger.groupId).join(' › ')}` })),
    ...(cost.categories ?? []).map(category => ({ key: `cost-category:${category.id}`, kind: 'cost-category' as const, id: category.id, name: category.name, second: category.secondLanguageName, builtIn: category.systemKey !== null, where: 'Groups cost centres' })),
    ...(cost.centres ?? []).map(centre => ({ key: `cost-centre:${centre.id}`, kind: 'cost-centre' as const, id: centre.id, name: centre.name, second: centre.secondLanguageName, builtIn: false,
      where: centre.parentId ? `In ${centre.categoryName}, under ${centrePath(cost.centres ?? [], centre.parentId).join(' › ')}` : `In ${centre.categoryName}` })),
  ].sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base', numeric: true }) || left.key.localeCompare(right.key)) : [], [groups, ledgers, cost.categories, cost.centres])
  const shown = useMemo(() => {
    const needle = normalise(query.trim())
    return needle ? candidates.filter(item => normalise(`${item.name} ${item.second ?? ''} ${item.where}`).includes(needle)) : candidates
  }, [candidates, query])
  const entries = useMemo<ListEntry[]>(() => shown.map(item => ({
    key: item.key, cursor: true, depth: 1, label: `${kindTitles[item.kind]} ${item.name}`,
    content: <Inline as='div' gap={2} align='center'>
      <Text weight='semibold'>{isolate(item.name)}</Text>
      {item.second && <Text tone='muted' size='sm'>{isolate(item.second)}</Text>}
      <Badge tone={item.kind === 'group' ? 'accent' : 'neutral'}>{kindTitles[item.kind]}</Badge>
      {item.builtIn && <Badge>Built-in</Badge>}
      <Text tone='muted' size='sm'>{item.where}</Text>
    </Inline>,
  })), [shown])
  const current = shown.find(item => item.key === active) ?? shown[0]
  // Escape (list.cancel, so the bar lists it): clear the filter; with nothing to clear move to the list, where the next one goes back.
  useAppCommand('list.cancel', () => {
    if (query) setQuery('')
    else if (document.activeElement !== list.current) list.current?.focus()
    else void navigate({ to: '/app/c/$companyId', params: { companyId: company.id } })
  }, { allowInTextInput: true })
  const open = (key: string) => {
    const item = shown.find(candidate => candidate.key === key)
    if (!item) return
    const params = { companyId: company.id }
    if (item.kind === 'group') void navigate({ to: '/app/c/$companyId/masters/edit/group/$groupId', params: { ...params, groupId: item.id } })
    else if (item.kind === 'ledger') void navigate({ to: '/app/c/$companyId/masters/edit/ledger/$ledgerId', params: { ...params, ledgerId: item.id } })
    else if (item.kind === 'cost-category') void navigate({ to: '/app/c/$companyId/masters/edit/cost-category/$categoryId', params: { ...params, categoryId: item.id } })
    else void navigate({ to: '/app/c/$companyId/masters/edit/cost-centre/$centreId', params: { ...params, centreId: item.id }, search: {} })
  }
  return <Stack gap={4}>
    <PageHeader eyebrow='Masters' title={verb === 'open' ? 'Open a master' : 'Alter a master'} description='Type to filter by name, move with the Up and Down keys, then press Enter to open the highlighted master.' />
    {message && <StatusLine tone='success' live='polite'>{message}</StatusLine>}
    {error && <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>The chart could not be loaded: {error}</Alert>}
    {cost.error && <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={cost.reload}>Try again</Button>}>Cost categories and centres could not be loaded: {cost.error}</Alert>}
    <Input type='search' aria-label='Filter masters' placeholder='Type to filter by name' value={query} autoComplete='off' autoFocus
      onChange={event => setQuery(event.target.value)} />
    <Text size='sm' tone='muted' aria-live='polite'>{query ? `${shown.length} ${shown.length === 1 ? 'match' : 'matches'}` : 'Escape clears the filter, then moves to the list; Escape again goes back.'}</Text>
    {groups && ledgers && <MasterList label='Masters' entries={entries} active={current?.key ?? null} onActiveChange={setActive} onOpen={open}
      openHint={`Enter to ${verb}`} searchField listRef={list} emptyMessage='No master matches the filter.' />}
  </Stack>
}
