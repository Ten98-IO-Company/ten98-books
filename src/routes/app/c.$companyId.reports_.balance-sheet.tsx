import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/reports_/balance-sheet')({ component: () => <NotBuilt icon='chart' section='The balance sheet' singular /> })
