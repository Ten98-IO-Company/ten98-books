import { createFileRoute } from '@tanstack/react-router'
import { ChartOfAccounts } from '../../components/masters/ChartOfAccounts'

export const Route = createFileRoute('/app/c/$companyId/masters_/chart-of-accounts')({ component: ChartOfAccounts })
