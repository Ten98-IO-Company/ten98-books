import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/masters_/chart-of-accounts')({ component: () => <NotBuilt icon='book' section='The chart of accounts' singular /> })
