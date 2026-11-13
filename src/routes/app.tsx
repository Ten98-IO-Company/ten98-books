import { AccountMenu, Alert, AppShell, AppStateScreen, AppTopbar, Banner, SidebarFooter, SidebarNav, WorkspaceOnboarding, WorkspaceProjectSwitcher } from '@ten98/ui'
import type { NavLinkComponent, SidebarNavGroup, WorkspaceCreateValues } from '@ten98/ui'
import { AppBrand } from '@ten98/ui/app'
import { createFileRoute, Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { version } from '../../package.json'
import { AccountPresentationContext, useAccountPresentationState } from '../lib/account-presentation'
import { api, ApiError, errMsg } from '../lib/api'
import { AppContext, type AppState, type CompanySummary, type Me } from '../lib/app-context'

/** The signed-in shell (application-shell-auth-presentation): workspace and company switcher, sections, account menu. */
export const Route = createFileRoute('/app')({
  validateSearch: (search: Record<string, unknown>): { workspace?: string } => typeof search.workspace === 'string' ? { workspace: search.workspace } : {},
  component: AppLayout,
})

const ShellLink: NavLinkComponent = ({ href, ...props }) => <Link to={href} {...props} />

/** The company sections; each is its own child route of /app/c/$companyId. */
const sections = [
  { id: 'home', label: 'Home', icon: 'home', path: '' },
  { id: 'masters', label: 'Masters', icon: 'book', path: '/masters' },
  { id: 'vouchers', label: 'Vouchers', icon: 'file', path: '/vouchers' },
  { id: 'reports', label: 'Reports', icon: 'chart', path: '/reports' },
  { id: 'settings', label: 'Company settings', icon: 'settings', path: '/settings' },
] as const

function AppLayout() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  // Company ids are lowercase UUIDs; a pasted uppercase address names the same company.
  const companyId = (useParams({ strict: false }) as { companyId?: string }).companyId?.toLowerCase()
  const pathname = useRouterState({ select: state => state.location.pathname })
  const [me, setMe] = useState<Me | null>(null)
  const [loadError, setLoadError] = useState('')
  const [shownWorkspace, setShownWorkspace] = useState('')
  const [companies, setCompanies] = useState<CompanySummary[] | null>(null)
  const [companiesError, setCompaniesError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [appError, setAppError] = useState('')
  const companiesRequest = useRef(0)

  const unauthorized = useCallback(() => { void navigate({ to: '/' }) }, [navigate])

  const loadMe = useCallback(async () => {
    try { setMe(await api<Me>('/api/me')); setLoadError('') }
    catch (error) { if (error instanceof ApiError && error.status === 401) unauthorized(); else setLoadError(errMsg(error)) }
  }, [unauthorized])
  useEffect(() => { void loadMe() }, [loadMe])

  const workspace = me?.workspaces.find(item => item.id === (search.workspace ?? shownWorkspace)) ?? me?.workspaces[0]

  const reloadCompanies = useCallback(async () => {
    if (!workspace) return
    const request = ++companiesRequest.current
    setCompaniesError('')
    try {
      const result = await api<{ companies: CompanySummary[] }>(`/api/workspaces/${workspace.id}/companies`)
      if (request === companiesRequest.current) setCompanies(result.companies)
    } catch (error) {
      if (request !== companiesRequest.current) return
      if (error instanceof ApiError && error.status === 401) unauthorized(); else setCompaniesError(errMsg(error))
    }
  }, [workspace?.id, unauthorized])
  useEffect(() => { setCompanies(null); void reloadCompanies() }, [reloadCompanies])
  useEffect(() => setMenuOpen(false), [pathname])

  const state = useMemo<AppState | null>(() => me && workspace ? { me, workspace, companies, reloadCompanies, unauthorized, showWorkspace: setShownWorkspace } : null,
    [me, workspace, companies, reloadCompanies, unauthorized])

  async function signOut() {
    setSignOutBusy(true); setAppError('')
    try { await api('/api/auth/sign-out', { method: 'POST', body: {} }); void navigate({ to: '/' }) }
    catch (error) { if (error instanceof ApiError && error.status === 401) unauthorized(); else setAppError(`Could not sign out: ${errMsg(error)}`) }
    finally { setSignOutBusy(false) }
  }

  if (loadError) return <AppStateScreen state='error' title='Unable to load your account' message={loadError} onRetry={() => { setLoadError(''); void loadMe() }} />
  if (!me) return <AppStateScreen state='loading' message='Loading…' />
  if (!state || !workspace) return <WorkspaceSetup email={me.user.email} onSignOut={signOut} signOutBusy={signOutBusy}
    onCreate={async name => { const created = await api<{ workspace: { id: string } }>('/api/workspaces', { method: 'POST', body: { name } }); await loadMe(); void navigate({ to: '/app', search: { workspace: created.workspace.id } }) }} />

  const company = companies?.find(item => item.id === companyId)
  const base = company ? `/app/c/${company.id}` : ''
  const current = company ? sections.find(section => section.path && pathname.startsWith(base + section.path)) ?? sections[0] : undefined
  const groups: SidebarNavGroup[] = company ? [{ id: 'company', items: sections.map(section => ({ id: section.id, label: section.label, icon: section.icon, href: base + section.path, current: current?.id === section.id })) }] : []
  const manager = workspace.role === 'owner' || workspace.role === 'admin'
  const canCreate = manager || workspace.role === 'editor'
  const pageTitle = current?.label ?? (pathname.startsWith('/app/account') ? 'Your account' : pathname.startsWith('/app/team') ? 'Team' : pathname.startsWith('/app/companies/new') ? 'Create company' : 'Companies')

  return <AppContext value={state}><PresentationProvider userId={me.user.id} onUnauthorized={unauthorized}>
    <AppShell sidebarLabel='Application navigation' skipLinkLabel='Skip to main content' mainLabel='Main content' navigation={{ open: menuOpen, onOpenChange: setMenuOpen }}
      sidebar={<>
        <AppBrand product='Books' href='/app' />
        <WorkspaceProjectSwitcher linkComponent={ShellLink}
          workspaces={me.workspaces.map(item => ({ id: item.id, name: item.name, initials: item.name.slice(0, 2).toUpperCase(), roleLabel: `${item.role} workspace` }))}
          projects={companies} workspaceId={workspace.id} projectId={company?.id ?? null}
          onWorkspaceChange={id => { setShownWorkspace(id); void navigate({ to: '/app', search: { workspace: id } }) }}
          onProjectChange={id => void navigate({ to: '/app/c/$companyId', params: { companyId: id } })}
          create={canCreate ? { label: 'Create company', href: '/app/companies/new' } : undefined}
          labels={{ project: 'Company', noProjects: 'No companies yet', choose: 'Choose a company', loading: 'Loading companies…', noWorkspaces: 'No workspaces yet.' }} />
        {company && <SidebarNav label='Company sections' linkComponent={ShellLink} groups={groups} />}
        <SidebarFooter version={version}>
          <SidebarNav label='Workspace and account' linkComponent={ShellLink} groups={[{ id: 'workspace', items: [
            ...manager ? [{ id: 'team', label: 'Team', icon: 'users' as const, href: '/app/team', current: pathname.startsWith('/app/team') }] : [],
            { id: 'account', label: 'Account', icon: 'user' as const, href: '/app/account', current: pathname.startsWith('/app/account') },
          ] }]} />
        </SidebarFooter>
      </>}
      topbar={<AppTopbar wrap menuToggle menuLabel='Menu' breadcrumb={{ icon: company ? 'building' : 'folder', scope: company?.name ?? workspace.name, current: pageTitle }}
        badge={{ label: 'Development preview', hideOnMobile: true }}
        actions={<AccountMenu name={me.user.name || 'Account'} email={me.user.email} linkComponent={ShellLink} items={[
          { id: 'account', kind: 'link', label: 'Account and security', href: '/app/account', icon: 'user' },
          { id: 'separator', kind: 'separator' },
          { id: 'sign-out', kind: 'button', label: 'Sign out', onSelect: () => void signOut(), busy: signOutBusy, busyLabel: 'Signing out…' },
        ]} />} />}
      banners={<>
        {workspace.twoFactorLocked && <Banner tone='warning' icon='shield' title='Two-factor authentication required' linkComponent={ShellLink} action={{ label: 'Open account security', href: '/app/account' }}>This workspace requires two-factor authentication. Turn it on to open its companies.</Banner>}
      </>}>
      {appError && <Alert tone='danger'>{appError}</Alert>}
      {companiesError && <Alert tone='danger'>{companiesError}</Alert>}
      <Outlet />
    </AppShell>
  </PresentationProvider></AppContext>
}

function PresentationProvider({ userId, onUnauthorized, children }: { userId: string; onUnauthorized: () => void; children: ReactNode }) {
  return <AccountPresentationContext value={useAccountPresentationState(userId, onUnauthorized)}>{children}</AccountPresentationContext>
}

// The onboarding screen shows its own most recent failure: starting a sign-out clears a create error and the reverse.
function WorkspaceSetup({ email, onCreate, onSignOut, signOutBusy }: { email: string; onCreate: (name: string) => Promise<void>; onSignOut: () => Promise<void>; signOutBusy: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(values: WorkspaceCreateValues) {
    const name = values.name.trim()
    if (!name) { setError('Enter a workspace name.'); return }
    setBusy(true); setError('')
    try { await onCreate(name) } catch (cause) { setError(`Could not create the workspace: ${errMsg(cause)}`) } finally { setBusy(false) }
  }
  return <WorkspaceOnboarding email={email} help='A workspace is your organisation; each company inside it keeps its own books.' busy={busy} error={error || undefined}
    onSubmit={submit} signOut={{ label: signOutBusy ? 'Signing out…' : 'Sign out', onClick: () => { setError(''); void onSignOut() } }} />
}
