import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/reports')({ component: () => <NotBuilt icon='chart' section='Reports' /> })
