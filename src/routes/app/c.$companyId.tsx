import { Button, EmptyState } from '@ten98/ui'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CompanySetupForm } from '../../components/CompanySetupForm'
import { LoadingState, StateScreen } from '../../components/KeyboardShell'
import { api, ApiError, errMsg } from '../../lib/api'
import { CompanyContext, useApp } from '../../lib/app-context'
import type { Company } from '../../lib/company'

/**
 * Loads the company once (through the server's withCompany) and gives it to every section below. The id is the
 * workspace id (D-03). A company without books settings yet (first-user setup creates one) opens its setup form.
 */
export const Route = createFileRoute('/app/c/$companyId')({ component: CompanyLayout })

/**
 * What the layout shows while it reads a company: the same company stays (a rename, a role change) so the page below is
 * not unmounted and keeps its own state; another company in the address starts from the loading state.
 */
export const keptWhileReading = <T extends { id: string }>(shown: T | null, companyId: string): T | null => shown?.id === companyId ? shown : null

type LoadError = { kind: 'missing' | 'not-set-up' | 'failed'; message: string }

function CompanyLayout() {
  // The server answers with the lowercase id whatever the address used, so compare in that form.
  const companyId = Route.useParams().companyId.toLowerCase()
  const { companies, reloadCompanies, unauthorized } = useApp()
  const [company, setCompany] = useState<Company | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [attempt, setAttempt] = useState(0)
  // A rename changes the name in the company list; reading the company again keeps every section's copy in step. The
  // company shown so far stays while the same company is read again, so the page below is not unmounted (a rename keeps
  // its notice and focus); only another company in the address starts from the loading state.
  const listedName = companies?.find(item => item.id === companyId)?.name

  useEffect(() => {
    const controller = new AbortController()
    setCompany(shown => keptWhileReading(shown, companyId)); setError(null)
    api<{ company: Company }>(`/api/companies/${companyId}`, { signal: controller.signal })
      .then(result => setCompany(result.company))
      .catch(cause => {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) { unauthorized(); return }
        const kind = cause instanceof ApiError && cause.status === 404 ? 'missing' : cause instanceof ApiError && cause.status === 409 ? 'not-set-up' : 'failed'
        setError({ kind, message: errMsg(cause) })
      })
    return () => controller.abort()
  }, [companyId, attempt, listedName])

  if (error?.kind === 'not-set-up') {
    const summary = companies?.find(item => item.id === companyId)
    if (!summary) return <LoadingState message='Loading the company…' />
    if (summary.role !== 'owner' && summary.role !== 'admin') return <CompanyNotSetUp name={summary.name} onRetry={() => setAttempt(value => value + 1)} />
    return <CompanySetupForm key={companyId} eyebrow='One more step' title='Set up the company' defaultName={summary.name} submitLabel='Save and open the company' busyLabel='Saving…'
      description='Enter the company details its books are kept in. The base currency and its minor units cannot be changed later.' onUnauthorized={unauthorized}
      onSubmit={async value => {
        const result = await api<{ company: Company }>(`/api/companies/${companyId}/setup`, { method: 'POST', body: value })
        await reloadCompanies()
        setError(null); setCompany(result.company)
      }} />
  }
  if (error) return <CompanyUnavailable kind={error.kind} message={error.message} onRetry={() => setAttempt(value => value + 1)}
    locked={companies?.find(item => item.id === companyId)?.twoFactorLocked === true} />
  if (!company || company.id !== companyId) return <LoadingState message='Loading the company…' />
  return <CompanyContext value={company}><Outlet /></CompanyContext>
}

/** A company whose books settings are not entered yet, for a member who is not an owner or admin. */
export function CompanyNotSetUp({ name, onRetry }: { name: string; onRetry: () => void }) {
  return <EmptyState icon='building' title={`${name} is not set up yet`}
    description='An owner or admin of this company enters its books settings first. Try again once they have.'
    action={<Button variant='secondary' onClick={onRetry}>Try again</Button>} />
}

/**
 * A company that cannot be opened (not found) or could not be loaded, on the shared state screen. Its text is a fixed
 * title and the server's message only: the server answers one identical 404 for a company the person is not a member of
 * and for an id that does not exist, so the two pages cannot be told apart. A company locked by its two-factor rule
 * (`locked`) sends Escape and "Go back one level" to the account's security section, where two-factor is turned on:
 * the start page would open the same locked company again.
 */
export const lockedBack = { to: '/app/account', hash: 'security' } as const

export function CompanyUnavailable({ kind, message, onRetry, locked = false }: { kind: 'missing' | 'failed'; message: string; onRetry: () => void; locked?: boolean }) {
  return kind === 'missing' ? <StateScreen state='not-found' title='Company not found' message={message} />
    : <StateScreen state='error' title='The company could not be loaded' message={message} onRetry={onRetry} backTo={locked ? lockedBack : undefined} />
}
