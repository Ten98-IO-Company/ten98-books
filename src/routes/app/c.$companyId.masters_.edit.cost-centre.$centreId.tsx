import { createFileRoute } from '@tanstack/react-router'
import { AlterCost } from '../../components/masters/CostScreens'
import { costMoveSearch } from '../../lib/cost-centre-forms'

export const Route = createFileRoute('/app/c/$companyId/masters_/edit/cost-centre/$centreId')({
  validateSearch: costMoveSearch,
  component: () => <AlterCost kind='cost-centre' id={Route.useParams().centreId} move={Route.useSearch().move === true} />,
})
