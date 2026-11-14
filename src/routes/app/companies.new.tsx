import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useRef } from 'react'
import { CompanySetupForm } from '../../components/CompanySetupForm'
import { api } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { Company } from '../../lib/company'

/** Creates a company: a new workspace with its books settings and default chart, owned by the signed-in user (D-03). */
export const Route = createFileRoute('/app/companies/new')({ component: CreateCompany })

function CreateCompany() {
  const { reloadCompanies, unauthorized } = useApp()
  const navigate = useNavigate()
  // One key per visit to this form: a retry after a lost answer, or a second submit that slips past the in-flight guard,
  // returns the company the first request created instead of making another one.
  const requestKey = useRef(crypto.randomUUID())
  return <CompanySetupForm title='Create company' submitLabel='Create company' busyLabel='Creating…' onUnauthorized={unauthorized}
    description='Each company keeps its own books and its own team, and you become its owner. The base currency and its minor units cannot be changed later.'
    onSubmit={async value => {
      const { company } = await api<{ company: Company }>('/api/companies', { method: 'POST', body: { ...value, idempotencyKey: requestKey.current } })
      await reloadCompanies()
      void navigate({ to: '/app/c/$companyId', params: { companyId: company.id } })
    }} />
}
