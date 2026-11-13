import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/settings')({ component: () => <NotBuilt icon='settings' section='Company settings' /> })
