import { Button, EmptyState, StatusLine } from '@ten98/ui'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, ApiError, errMsg } from '../../lib/api'
import { CompanyContext, useApp } from '../../lib/app-context'
import type { Company } from '../../lib/company'

/** Loads the company once (through the server's withCompany) and gives it to every section below. */
export const Route = createFileRoute('/app/c/$companyId')({ component: CompanyLayout })

function CompanyLayout() {
  const { companyId } = Route.useParams()
  const { showWorkspace, unauthorized } = useApp()
  const [company, setCompany] = useState<Company | null>(null)
  const [error, setError] = useState<{ missing: boolean; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setCompany(null); setError(null)
    api<{ company: Company }>(`/api/companies/${companyId}`, { signal: controller.signal })
      .then(result => { setCompany(result.company); showWorkspace(result.company.workspaceId) })
      .catch(cause => {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) { unauthorized(); return }
        setError({ missing: cause instanceof ApiError && cause.status === 404, message: errMsg(cause) })
      })
    return () => controller.abort()
  }, [companyId, attempt])

  if (error) return <EmptyState icon='building' title={error.missing ? 'Company not found' : 'The company could not be loaded'} description={error.message}
    action={error.missing ? undefined : <Button variant='secondary' onClick={() => setAttempt(value => value + 1)}>Try again</Button>} />
  if (!company || company.id !== companyId) return <StatusLine busy>Loading the company…</StatusLine>
  return <CompanyContext value={company}><Outlet /></CompanyContext>
}
