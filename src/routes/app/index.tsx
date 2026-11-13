import { Button, EmptyState, StatusLine } from '@ten98/ui'
import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router'
import { useApp } from '../../lib/app-context'

/** Opens the workspace's first company, or explains that the workspace has none yet. */
export const Route = createFileRoute('/app/')({ component: CompaniesStart })

function CompaniesStart() {
  const { workspace, companies } = useApp()
  const navigate = useNavigate()
  if (companies === null) return <StatusLine busy>Loading companies…</StatusLine>
  if (companies[0]) return <Navigate to='/app/c/$companyId' params={{ companyId: companies[0].id }} replace />
  const canCreate = workspace.role !== 'viewer'
  return <EmptyState icon='building' title={`${workspace.name} has no companies yet`}
    description={canCreate ? 'A company is one set of books with its own base currency and financial year. Create one to start.' : 'Ask a workspace owner, admin or editor to create the first company.'}
    action={canCreate ? <Button onClick={() => void navigate({ to: '/app/companies/new' })}>Create company</Button> : undefined} />
}
