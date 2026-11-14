import { createFileRoute } from '@tanstack/react-router'
import { CostHistory } from '../../components/masters/CostScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/history/cost-centre/$centreId')({ component: () => <CostHistory kind='cost-centre' id={Route.useParams().centreId} /> })
