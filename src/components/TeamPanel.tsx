import { Alert, Button, StatusLine, TeamFlow } from '@ten98/ui'
import { mayManageWorkspaceMember, type WorkspaceRole } from '@ten98/runtime/browser'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { assignableRoles, inviteResultText, inviteRoleOptions, type InviteResult } from '../lib/team-roles'

type Member = { userId: string; name: string; email: string; role: WorkspaceRole }
type Invitation = { id: string; email: string; role: WorkspaceRole; expiresAt: string }
type Team = { workspace: { id: string; name: string; twoFactorRequired: boolean }; role: 'owner' | 'admin'; members: Member[]; invitations: Invitation[]; emailConfigured: boolean }
type Issued = { invitation: Invitation; inviteUrl: string; email?: 'accepted' | 'failed' | 'disabled' }

/** Request adapter around the shared TeamFlow over the workspace-team controller routes (owners and admins). */
export function TeamPanel({ workspaceId, userId, onChanged, onUnauthorized }: { workspaceId: string; userId: string; onChanged: () => void; onUnauthorized: () => void }) {
  const [team, setTeam] = useState<Team | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inviteLink, setInviteLink] = useState<{ id: string; url: string } | undefined>()
  const lock = useRef(false), mounted = useRef(true)
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`

  async function load() {
    setLoadError('')
    try { const value = await api<Team>(`${base}/team`); if (mounted.current) setTeam(value) }
    catch (e) { if (!mounted.current) return; if (e instanceof ApiError && e.status === 401) onUnauthorized(); else { setTeam(null); setLoadError(errMsg(e)) } }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [workspaceId])

  /** One change at a time; the team is re-read after every outcome so the flow never shows a guessed state. */
  async function run(action: () => Promise<string | void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { const message = await action(); if (mounted.current && message) setNotice(message); onChanged() }
    catch (e) { if (!mounted.current) return; if (e instanceof ApiError && e.status === 401) { onUnauthorized(); return } setError(errMsg(e)) }
    finally { lock.current = false; if (mounted.current) { setBusy(false); await load() } }
  }
  const post = <T,>(path: string, body: unknown = {}) => api<T>(`${base}${path}`, { method: 'POST', body })
  const issued = (kind: InviteResult['kind'], result: Issued) => {
    setInviteLink({ id: result.invitation.id, url: result.inviteUrl })
    return inviteResultText({ kind, delivery: result.email ?? 'disabled', email: result.invitation.email })
  }

  if (!team) return loadError
    ? <Alert tone='danger' actions={<Button variant='secondary' onClick={() => void load()}>Reload team</Button>}>{loadError}</Alert>
    : <StatusLine busy>Loading team…</StatusLine>

  const owner = team.role === 'owner'
  return <TeamFlow title={`${team.workspace.name} team`} description='Invite people, set their roles and decide whether two-factor authentication is required.'
    currentUserId={userId} busy={busy} error={error || undefined} notice={notice ? { tone: 'info', text: notice } : undefined}
    members={team.members.map(member => ({ id: member.userId, name: member.name, email: member.email, role: member.role }))}
    roles={inviteRoleOptions(team.role)}
    assignableRoles={target => target.id !== userId && mayManageWorkspaceMember(team.role, target.role) ? assignableRoles(team.role) : []}
    invitations={team.invitations.map(invitation => ({ ...invitation, status: 'pending' }))}
    inviteLink={inviteLink} onDismissInviteLink={() => setInviteLink(undefined)}
    onInvite={({ email, role }) => run(async () => issued('create', await post<Issued>('/invitations', { email, role })))}
    onRoleChange={({ id, role }) => run(async () => { await post(`/members/${encodeURIComponent(id)}/role`, { role }) })}
    onRemove={({ id }) => run(async () => { await post(`/members/${encodeURIComponent(id)}/remove`) })}
    onRevokeInvitation={({ id }) => run(async () => { await post(`/invitations/${encodeURIComponent(id)}/revoke`) })}
    onResendInvitation={team.emailConfigured ? ({ id }) => run(async () => issued('resend', await post<Issued>(`/invitations/${encodeURIComponent(id)}/resend`))) : undefined}
    onRenewInvitationLink={({ id }) => run(async () => issued('new-link', await post<Issued>(`/invitations/${encodeURIComponent(id)}/new-link`)))}
    policy={owner ? { twoFactorRequired: team.workspace.twoFactorRequired, onChange: required => run(async () => { await post('/two-factor', { required }) }) } : undefined}
    ownership={owner ? {
      candidates: team.members.filter(member => member.userId !== userId).map(member => ({ value: member.userId, label: `${member.name} · ${member.email}` })),
      // The flow confirms the choice; the server rechecks it against the member's saved email.
      onTransfer: ({ userId: target }) => run(async () => {
        const member = team.members.find(item => item.userId === target)
        if (!member) throw new Error('That member is no longer in the company. Reload the team.')
        await post('/transfer-ownership', { targetUserId: member.userId, confirmationEmail: member.email.toLowerCase() })
        setInviteLink(undefined)
        return `Ownership moved to ${member.name}. You are now an admin.`
      }),
    } : undefined} />
}
