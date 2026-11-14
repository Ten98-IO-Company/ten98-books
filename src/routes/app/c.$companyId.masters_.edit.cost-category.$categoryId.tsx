import { createFileRoute } from '@tanstack/react-router'
import { AlterCost } from '../../components/masters/CostScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/edit/cost-category/$categoryId')({ component: () => <AlterCost kind='cost-category' id={Route.useParams().categoryId} /> })
