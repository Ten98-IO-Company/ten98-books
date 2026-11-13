import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/masters_/new')({ component: () => <NotBuilt icon='book' section='New master' singular /> })
