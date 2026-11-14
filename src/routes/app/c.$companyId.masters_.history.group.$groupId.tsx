import { createFileRoute } from '@tanstack/react-router'
import { MasterHistory } from '../../components/masters/MasterScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/history/group/$groupId')({ component: () => <MasterHistory kind='group' id={Route.useParams().groupId} /> })
