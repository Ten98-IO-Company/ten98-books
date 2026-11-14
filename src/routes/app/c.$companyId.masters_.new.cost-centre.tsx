import { createFileRoute } from '@tanstack/react-router'
import { CreateCost } from '../../components/masters/CostScreens'
import { costCreateSearch } from '../../lib/cost-centre-forms'

export const Route = createFileRoute('/app/c/$companyId/masters_/new/cost-centre')({
  validateSearch: costCreateSearch,
  component: () => { const search = Route.useSearch(); return <CreateCost kind='cost-centre' category={search.category} parent={search.parent} /> },
})
