import { createFileRoute } from '@tanstack/react-router'
import { CostCentreList } from '../../components/masters/CostCentreList'

export const Route = createFileRoute('/app/c/$companyId/masters_/cost-centres')({ component: CostCentreList })
