import { createFileRoute } from '@tanstack/react-router'
import { MasterHistory } from '../../components/masters/MasterScreens'

export const Route = createFileRoute('/app/c/$companyId/masters_/history/ledger/$ledgerId')({ component: () => <MasterHistory kind='ledger' id={Route.useParams().ledgerId} /> })
