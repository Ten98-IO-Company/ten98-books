import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/reports_/profit-and-loss')({ component: () => <NotBuilt icon='chart' section='The profit and loss report' singular /> })
