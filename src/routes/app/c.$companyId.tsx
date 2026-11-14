import { Button, EmptyState, StatusLine } from '@ten98/ui'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CompanySetupForm } from '../../components/CompanySetupForm'
import { api, ApiError, errMsg } from '../../lib/api'
import { CompanyContext, useApp } from '../../lib/app-context'
import type { Company } from '../../lib/company'

/**
 * Loads the company once (through the server's withCompany) and gives it to every section below. The id is the
 * workspace id (D-03). A company without books settings yet (first-user setup creates one) opens its setup form.
 */
export const Route = createFileRoute('/app/c/$companyId')({ component: CompanyLayout })

type LoadError = { kind: 'missing' | 'not-set-up' | 'failed'; message: string }

function CompanyLayout() {
  // The server answers with the lowercase id whatever the address used, so compare in that form.
  const companyId = Route.useParams().companyId.toLowerCase()
  const { companies, reloadCompanies, unauthorized } = useApp()
  const [company, setCompany] = useState<Company | null>(null)
  const [error, setError] = useState<LoadError | null>(null)
  const [attempt, setAttempt] = useState(0)
  // A rename changes the name in the company list; reading the company again keeps every section's copy in step.
  const listedName = companies?.find(item => item.id === companyId)?.name

  useEffect(() => {
    const controller = new AbortController()
    setCompany(null); setError(null)
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
    if (!summary) return <StatusLine busy>Loading the company…</StatusLine>
    if (summary.role !== 'owner' && summary.role !== 'admin') return <EmptyState icon='building' title={`${summary.name} is not set up yet`}
      description='An owner or admin of this company enters its books settings first. Try again once they have.'
      action={<Button variant='secondary' onClick={() => setAttempt(value => value + 1)}>Try again</Button>} />
    return <CompanySetupForm key={companyId} eyebrow='One more step' title='Set up the company' defaultName={summary.name} submitLabel='Save and open the company' busyLabel='Saving…'
      description='Enter the company details its books are kept in. The base currency and its minor units cannot be changed later.' onUnauthorized={unauthorized}
      onSubmit={async value => {
        const result = await api<{ company: Company }>(`/api/companies/${companyId}/setup`, { method: 'POST', body: value })
        await reloadCompanies()
        setError(null); setCompany(result.company)
      }} />
  }
  if (error) return <EmptyState icon='building' title={error.kind === 'missing' ? 'Company not found' : 'The company could not be loaded'} description={error.message}
    action={error.kind === 'missing' ? undefined : <Button variant='secondary' onClick={() => setAttempt(value => value + 1)}>Try again</Button>} />
  if (!company || company.id !== companyId) return <StatusLine busy>Loading the company…</StatusLine>
  return <CompanyContext value={company}><Outlet /></CompanyContext>
}
