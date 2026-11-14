import { createFileRoute } from '@tanstack/react-router'
import { NewMasterChoice } from '../../components/masters/MasterPicker'
import { underSearch } from '../../lib/masters'

export const Route = createFileRoute('/app/c/$companyId/masters_/new/')({
  validateSearch: underSearch,
  component: () => <NewMasterChoice under={Route.useSearch().under} />,
})
