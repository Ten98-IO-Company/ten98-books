import { createFileRoute } from '@tanstack/react-router'
import { NotBuilt } from '../../components/NotBuilt'

export const Route = createFileRoute('/app/c/$companyId/vouchers')({ component: () => <NotBuilt icon='file' section='Vouchers' /> })
