import { StatusLine } from '@ten98/ui'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useApp } from '../../lib/app-context'

/** Opens the last company used in this browser that the user still belongs to, else the first; with none, creation. */
export const Route = createFileRoute('/app/')({ component: CompaniesStart })

function CompaniesStart() {
  const { companies, current } = useApp()
  if (companies === null) return <StatusLine busy>Loading companies…</StatusLine>
  if (current) return <Navigate to='/app/c/$companyId' params={{ companyId: current.id }} replace />
  return <Navigate to='/app/companies/new' replace />
}
