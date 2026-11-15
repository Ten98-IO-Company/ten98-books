import { Alert, Button, EmptyState, PageHeader, Stack, StatusLine } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useCompany } from '../../lib/app-context'
import { describeCostChanges } from '../../lib/cost-centre-forms'
import { CostCategoryForm } from './CostCategoryForm'
import { CostCentreForm } from './CostCentreForm'
import { rememberChoice, rememberedCostCategory } from './flash'
import { RevisionHistory } from './MasterScreens'
import { useCanWrite } from './useCanWrite'
import { useCostData } from './useCostData'

export type CostKind = 'cost-category' | 'cost-centre'

const loadFailed = (error: string, reload: () => void) =>
  <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>Cost categories and centres could not be loaded: {error}</Alert>

/**
 * `/masters/new/cost-category` and `/masters/new/cost-centre`. A new centre starts in the category the list was on
 * (`category`), else the last one used in this tab, else the built-in category, and under `parent` when the list was on a centre.
 */
export function CreateCost({ kind, category, parent }: { kind: CostKind; category?: string; parent?: string }) {
  const company = useCompany()
  const canWrite = useCanWrite()
  const { categories, centres, error, reload } = useCostData(company.id)
  // Remembered so the choice list comes back on what was being created.
  useEffect(() => rememberChoice(company.id, kind), [company.id, kind])
  if (canWrite === undefined) return <StatusLine busy>Loading…</StatusLine>
  if (!canWrite) return <Stack gap={4}><PageHeader eyebrow='Masters' title={kind === 'cost-category' ? 'Create cost category' : 'Create cost centre'} /><Alert tone='info'>Viewers cannot create masters. Ask an owner, admin or editor of the company.</Alert></Stack>
  if (error) return loadFailed(error, reload)
  if (!categories || !centres) return <StatusLine busy>Loading cost categories…</StatusLine>
  if (kind === 'cost-category') return <CostCategoryForm reloadData={reload} />
  const known = (id: string | undefined) => id !== undefined && categories.some(item => item.id === id) ? id : undefined
  const parentCentre = centres.find(centre => centre.id === parent)
  const initialCategoryId = parentCentre?.categoryId ?? known(category) ?? known(rememberedCostCategory(company.id)) ?? categories.find(item => item.systemKey)?.id ?? categories[0]?.id ?? ''
  return <CostCentreForm categories={categories} centres={centres} initialCategoryId={initialCategoryId} initialParentId={parentCentre?.id} start='categoryId' reloadData={reload} />
}

/** `/masters/edit/cost-category/$id` and `/masters/edit/cost-centre/$id`; `move` starts a centre's cursor on its category. The form is keyed by the revision, so a reload replaces what was typed. */
export function AlterCost({ kind, id, move }: { kind: CostKind; id: string; move?: boolean }) {
  const company = useCompany()
  const canWrite = useCanWrite()
  const { categories, centres, error, reload } = useCostData(company.id)
  if (error) return loadFailed(error, reload)
  if (!categories || !centres || canWrite === undefined) return <StatusLine busy>Loading…</StatusLine>
  const wanted = id.toLowerCase()
  if (kind === 'cost-category') {
    const existing = categories.find(item => item.id === wanted)
    return existing ? <CostCategoryForm key={existing.revision} existing={existing} reloadData={reload} /> : <Missing what='cost category' />
  }
  const existing = centres.find(item => item.id === wanted)
  return existing ? <CostCentreForm key={existing.revision} categories={categories} centres={centres} existing={existing} start={move ? 'categoryId' : 'name'} reloadData={reload} /> : <Missing what='cost centre' />
}

function Missing({ what }: { what: string }) {
  const company = useCompany()
  const navigate = useNavigate()
  return <EmptyState icon='book' title={`This ${what} was not found`} description='It may have been deleted. The list shows what exists.'
    action={<Button variant='secondary' onClick={() => void navigate({ to: '/app/c/$companyId/masters/cost-centres', params: { companyId: company.id } })}>Open cost categories and centres</Button>} />
}

/** `/masters/history/cost-category/$id` and `.../cost-centre/$id`: who changed it, when and what. */
export function CostHistory({ kind, id }: { kind: CostKind; id: string }) {
  const company = useCompany()
  const { categories, centres } = useCostData(company.id)
  const wanted = id.toLowerCase()
  const name = (kind === 'cost-category' ? categories?.find(item => item.id === wanted) : centres?.find(item => item.id === wanted))?.name
  const centreName = (centreId: string) => centres?.find(centre => centre.id === centreId)?.name ?? null
  return <RevisionHistory noun={kind === 'cost-category' ? 'cost category' : 'cost centre'} path={`${kind === 'cost-category' ? 'cost-categories' : 'cost-centres'}/${wanted}`} name={name}
    back={{ to: '/app/c/$companyId/masters/cost-centres', params: { companyId: company.id } }}
    describe={row => describeCostChanges(row, centreName)} />
}
