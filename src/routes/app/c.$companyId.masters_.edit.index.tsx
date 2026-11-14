import { createFileRoute } from '@tanstack/react-router'
import { EditMasterPicker } from '../../components/masters/MasterPicker'

export const Route = createFileRoute('/app/c/$companyId/masters_/edit/')({ component: EditMasterPicker })
