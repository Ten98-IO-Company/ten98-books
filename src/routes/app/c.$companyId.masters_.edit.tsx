import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/masters_/edit')({ component: () => <NotBuilt icon='book' section='Editing a master' singular /> })
