import { createFileRoute } from '@tanstack/react-router'
import { CreateMaster } from '../../components/masters/MasterScreens'
import { underSearch } from '../../lib/masters'

export const Route = createFileRoute('/app/c/$companyId/masters_/new/ledger')({
  validateSearch: underSearch,
  component: () => <CreateMaster kind='ledger' under={Route.useSearch().under} />,
})
