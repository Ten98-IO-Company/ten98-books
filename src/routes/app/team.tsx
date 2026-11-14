import { Alert, StatusLine } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { TeamPanel } from '../../components/TeamPanel'
import { useApp } from '../../lib/app-context'

/** The members of the current company: a company is a workspace, so its team is the workspace team (D-03). */
export const Route = createFileRoute('/app/team')({ component: Team })

function Team() {
  const { me, companies, current, unauthorized, reloadCompanies } = useApp()
  if (companies === null) return <StatusLine busy>Loading companies…</StatusLine>
  if (!current) return <Alert tone='info'>You do not belong to any company yet.</Alert>
  if (current.role !== 'owner' && current.role !== 'admin') return <Alert tone='info'>Only the company's owners and admins manage its team.</Alert>
  return <TeamPanel key={current.id} workspaceId={current.id} userId={me.user.id} onChanged={() => void reloadCompanies()} onUnauthorized={unauthorized} />
}
