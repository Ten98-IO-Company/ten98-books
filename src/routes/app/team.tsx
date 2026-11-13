import { Alert } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { TeamPanel } from '../../components/TeamPanel'
import { useApp } from '../../lib/app-context'

export const Route = createFileRoute('/app/team')({ component: Team })

function Team() {
  const { me, workspace, unauthorized, reloadCompanies } = useApp()
  if (workspace.role !== 'owner' && workspace.role !== 'admin') return <Alert tone='info'>Only workspace owners and admins manage the team.</Alert>
  return <TeamPanel key={workspace.id} workspaceId={workspace.id} userId={me.user.id} onChanged={() => void reloadCompanies()} onUnauthorized={unauthorized} />
}
