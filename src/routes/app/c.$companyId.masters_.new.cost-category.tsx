import { createFileRoute } from '@tanstack/react-router'
import { CreateCost } from '../../components/masters/CostScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/new/cost-category')({ component: () => <CreateCost kind='cost-category' /> })
