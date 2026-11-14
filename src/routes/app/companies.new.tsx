import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CompanySetupForm } from '../../components/CompanySetupForm'
import { api } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { Company } from '../../lib/company'

/** Creates a company: a new workspace with its books settings and default chart, owned by the signed-in user (D-03). */
export const Route = createFileRoute('/app/companies/new')({ component: CreateCompany })

function CreateCompany() {
  const { reloadCompanies, unauthorized } = useApp()
  const navigate = useNavigate()
  return <CompanySetupForm title='Create company' submitLabel='Create company' busyLabel='Creating…' onUnauthorized={unauthorized}
    description='Each company keeps its own books and its own team, and you become its owner. The base currency and its minor units cannot be changed later.'
    onSubmit={async value => {
      const { company } = await api<{ company: Company }>('/api/companies', { method: 'POST', body: value })
      await reloadCompanies()
      void navigate({ to: '/app/c/$companyId', params: { companyId: company.id } })
    }} />
}
