import { createFileRoute } from '@tanstack/react-router'
import { AlterMaster } from '../../components/masters/MasterScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/edit/ledger/$ledgerId')({ component: () => <AlterMaster kind='ledger' id={Route.useParams().ledgerId} /> })
