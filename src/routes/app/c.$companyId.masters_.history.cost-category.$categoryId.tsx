import { createFileRoute } from '@tanstack/react-router'
import { CostHistory } from '../../components/masters/CostScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/history/cost-category/$categoryId')({ component: () => <CostHistory kind='cost-category' id={Route.useParams().categoryId} /> })
