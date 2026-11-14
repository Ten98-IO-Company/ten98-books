import { AccountMenu, Alert, AppShell, AppStateScreen, AppTopbar, Banner, Button, Field, Option, Select, SidebarFooter, SidebarNav, Stack } from '@ten98/ui'
import type { NavLinkComponent, SidebarNavGroup } from '@ten98/ui'
import { AppBrand } from '@ten98/ui/app'
import { createFileRoute, Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { version } from '../../package.json'
import { CompanyPicker, roleLabels } from '../components/CompanyPicker'
import { ContextActionBar } from '../components/ContextActionBar'
import { KeyboardShell } from '../components/KeyboardShell'
import { AccountPresentationContext, useAccountPresentationState } from '../lib/account-presentation'
import { api, ApiError, errMsg } from '../lib/api'
import { AppContext, readLastCompany, rememberLastCompany, type AppState, type CompanySummary, type Me } from '../lib/app-context'

/** The signed-in shell (application-shell-auth-presentation): company switcher, company sections, account menu. */
export const Route = createFileRoute('/app')({ component: AppLayout })

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
  // Company ids are lowercase UUIDs; a pasted uppercase address names the same company.
  const companyId = (useParams({ strict: false }) as { companyId?: string }).companyId?.toLowerCase()
  const pathname = useRouterState({ select: state => state.location.pathname })
  const [me, setMe] = useState<Me | null>(null)
  const [loadError, setLoadError] = useState('')
  const [companies, setCompanies] = useState<CompanySummary[] | null>(null)
  const [companiesError, setCompaniesError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [appError, setAppError] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [lastUsed, setLastUsed] = useState<string | null>(null)
  const companiesRequest = useRef(0)

  const unauthorized = useCallback(() => { void navigate({ to: '/' }) }, [navigate])

  const loadMe = useCallback(async () => {
    try { setMe(await api<Me>('/api/me')); setLoadError('') }
    catch (error) { if (error instanceof ApiError && error.status === 401) unauthorized(); else setLoadError(errMsg(error)) }
  }, [unauthorized])
  useEffect(() => { void loadMe() }, [loadMe])

  const reloadCompanies = useCallback(async () => {
    const request = ++companiesRequest.current
    setCompaniesError('')
    try {
      const result = await api<{ companies: CompanySummary[] }>('/api/companies')
      if (request === companiesRequest.current) setCompanies(result.companies)
    } catch (error) {
      if (request !== companiesRequest.current) return
      if (error instanceof ApiError && error.status === 401) unauthorized(); else setCompaniesError(errMsg(error))
    }
  }, [unauthorized])
  useEffect(() => { void reloadCompanies() }, [reloadCompanies])
  useEffect(() => setMenuOpen(false), [pathname])
  useEffect(() => { if (me) setLastUsed(readLastCompany(me.user.id)) }, [me?.user.id])

  const company = companies?.find(item => item.id === companyId)
  // Remember the company in the address once the list shows the user belongs to it.
  useEffect(() => { if (me && company) { rememberLastCompany(me.user.id, company.id); setLastUsed(company.id) } }, [me?.user.id, company?.id])
  const current = company ?? companies?.find(item => item.id === lastUsed) ?? companies?.[0]

  const state = useMemo<AppState | null>(() => me ? { me, companies, current, reloadCompanies, unauthorized } : null,
    [me, companies, current, reloadCompanies, unauthorized])

  async function signOut() {
    setSignOutBusy(true); setAppError('')
    try { await api('/api/auth/sign-out', { method: 'POST', body: {} }); void navigate({ to: '/' }) }
    catch (error) { if (error instanceof ApiError && error.status === 401) unauthorized(); else setAppError(`Could not sign out: ${errMsg(error)}`) }
    finally { setSignOutBusy(false) }
  }

  if (loadError) return <AppStateScreen state='error' title='Unable to load your account' message={loadError} onRetry={() => { setLoadError(''); void loadMe() }} />
  if (!me || !state) return <AppStateScreen state='loading' message='Loading…' />

  const base = company ? `/app/c/${company.id}` : ''
  const ready = company?.company != null
  const currentSection = company ? sections.find(section => section.path && pathname.startsWith(base + section.path)) ?? sections[0] : undefined
  const groups: SidebarNavGroup[] = ready ? [{ id: 'company', items: sections.map(section => ({ id: section.id, label: section.label, icon: section.icon, href: base + section.path, current: currentSection?.id === section.id })) }] : []
  // The Team page and the switcher follow the company in the address, else the current one.
  const shown = company ?? (pathname.startsWith('/app/team') ? current : undefined)
  const manager = current?.role === 'owner' || current?.role === 'admin'
  const pageTitle = (ready ? currentSection?.label : undefined) ?? (pathname.startsWith('/app/account') ? 'Your account' : pathname.startsWith('/app/team') ? 'Team'
    : pathname.startsWith('/app/companies/new') ? 'Create company' : company ? 'Set up the company' : 'Companies')
  // Escape goes back one level, from a company page to the company menu. The menu is the top level: /app only reopens a company.
  const back = ready && pathname.toLowerCase().replace(/\/$/, '') !== base ? () => void navigate({ to: '/app/c/$companyId', params: { companyId: company.id } }) : undefined
  const openCompany = (id: string) => void navigate({ to: '/app/c/$companyId', params: { companyId: id } })

  return <AppContext value={state}><PresentationProvider userId={me.user.id} onUnauthorized={unauthorized}>
    <KeyboardShell userId={me.user.id} onUnauthorized={unauthorized} back={back} onSwitchCompany={companies ? () => setPickerOpen(true) : undefined}>
    <AppShell sidebarLabel='Application navigation' skipLinkLabel='Skip to main content' mainLabel='Main content' navigation={{ open: menuOpen, onOpenChange: setMenuOpen }}
      sidebar={<>
        <AppBrand product='Books' href='/app' />
        <CompanySwitcher companies={companies} currentId={shown?.id} onChange={openCompany} />
        {groups.length > 0 && <SidebarNav label='Company sections' linkComponent={ShellLink} groups={groups} />}
        <SidebarFooter version={version}>
          <SidebarNav label='Company team and account' linkComponent={ShellLink} groups={[{ id: 'account', items: [
            ...manager ? [{ id: 'team', label: 'Team', icon: 'users' as const, href: '/app/team', current: pathname.startsWith('/app/team') }] : [],
            { id: 'account', label: 'Account', icon: 'user' as const, href: '/app/account', current: pathname.startsWith('/app/account') },
          ] }]} />
        </SidebarFooter>
      </>}
      topbar={<AppTopbar wrap menuToggle menuLabel='Menu' breadcrumb={{ icon: 'building', scope: shown?.name, current: pageTitle }}
        badge={{ label: 'Development preview', hideOnMobile: true }}
        actions={<AccountMenu name={me.user.name || 'Account'} email={me.user.email} linkComponent={ShellLink} items={[
          { id: 'account', kind: 'link', label: 'Account and security', href: '/app/account', icon: 'user' },
          { id: 'separator', kind: 'separator' },
          { id: 'sign-out', kind: 'button', label: 'Sign out', onSelect: () => void signOut(), busy: signOutBusy, busyLabel: 'Signing out…' },
        ]} />} />}
      banners={<>
        {shown?.twoFactorLocked && <Banner tone='warning' icon='shield' title='Two-factor authentication required' linkComponent={ShellLink} action={{ label: 'Open account security', href: '/app/account' }}>This company requires two-factor authentication. Turn it on to open its books.</Banner>}
      </>}>
      {appError && <Alert tone='danger'>{appError}</Alert>}
      {companiesError && <Alert tone='danger'>{companiesError}</Alert>}
      <ContextActionBar />
      <Outlet />
    </AppShell>
    <CompanyPicker open={pickerOpen} onOpenChange={setPickerOpen} companies={companies ?? []} currentId={shown?.id} onChoose={openCompany}
      onCreate={() => void navigate({ to: '/app/companies/new' })} />
    </KeyboardShell>
  </PresentationProvider></AppContext>
}

/**
 * One control for the company: a company is a workspace (D-03), so changing company is changing workspace. Composed
 * from `@ten98/ui` primitives because the shared switcher pairs a workspace with a project inside it.
 */
function CompanySwitcher({ companies, currentId, onChange }: { companies: CompanySummary[] | null; currentId?: string; onChange: (id: string) => void }) {
  const current = companies?.find(item => item.id === currentId)
  return <Stack gap={2}>
    <Field label='Company' description={current ? `${roleLabels[current.role]}${current.company || current.twoFactorLocked ? '' : ' · not set up yet'}` : undefined}>
      <Select value={current?.id ?? ''} disabled={!companies?.length} aria-busy={companies === null || undefined} onChange={event => { if (event.target.value) onChange(event.target.value) }}>
        {!current && <Option value='' disabled>{companies === null ? 'Loading companies…' : companies.length ? 'Change company' : 'No companies yet'}</Option>}
        {companies?.map(item => <Option key={item.id} value={item.id}>{item.name}</Option>)}
      </Select>
    </Field>
    <Button variant='secondary' size='sm' href='/app/companies/new' component={ShellLink}>Create company</Button>
  </Stack>
}

function PresentationProvider({ userId, onUnauthorized, children }: { userId: string; onUnauthorized: () => void; children: ReactNode }) {
  return <AccountPresentationContext value={useAccountPresentationState(userId, onUnauthorized)}>{children}</AccountPresentationContext>
}
