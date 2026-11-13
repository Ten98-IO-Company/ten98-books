import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/reports_/day-book')({ component: () => <NotBuilt icon='file' section='The day book' singular /> })
