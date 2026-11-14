import { createFileRoute } from '@tanstack/react-router'
import { AlterMaster } from '../../components/masters/MasterScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/edit/group/$groupId')({ component: () => <AlterMaster kind='group' id={Route.useParams().groupId} /> })
