import { DescriptionList, PageHeader, SettingsSection, Stack, WorkspaceCreateFlow } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp, useCompany } from '../../lib/app-context'
import { baseCurrencies } from '../../lib/company'

/**
 * The company's settings. The name is the workspace name (D-03), so renaming the company is the workspace rename, for
 * owners and admins, through the shared workspace rename flow: a name of only spaces is refused on the field itself,
 * and the success notice and a lost session are handled here. The books settings are shown read-only until editing
 * them is built.
 */
export const Route = createFileRoute('/app/c/$companyId/settings')({ component: CompanySettings })

/**
 * A rename reloads the company list, and the company layout then reloads the company and mounts this page again, so
 * the success notice is handed across that remount here (per company, read once), with focus back on the name.
 */
const renamed = new Set<string>()
const renamedNotice = 'The company name was changed.'

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function CompanySettings() {
  const company = useCompany()
  const { current, reloadCompanies, unauthorized } = useApp()
  const manager = current?.id === company.id && (current.role === 'owner' || current.role === 'admin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(() => renamed.delete(company.id) ? renamedNotice : '')
  const nameField = useRef<HTMLElement>(null)
  useEffect(() => { if (notice) nameField.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus() }, [])

  async function rename({ name }: { name: string }) {
    setBusy(true); setError(''); setNotice('')
    try {
      await api(`/api/workspaces/${company.id}/rename`, { method: 'POST', body: { name } })
      // Only a changed name reloads the company and remounts this page; otherwise the notice is set below directly.
      if (name !== company.name) renamed.add(company.id)
      await reloadCompanies()
      setNotice(renamedNotice)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { unauthorized(); return }
      setError(errMsg(cause))
    } finally { setBusy(false) }
  }

  const currency = baseCurrencies[company.baseCurrency]
  return <Stack gap={6}>
    <PageHeader title='Company settings' description='The settings the books of this company are kept in.' />
    {manager && <Stack ref={nameField}><WorkspaceCreateFlow key={company.name} mode='rename' title='Name' description='Shown in the company list, on every page and on reports.'
      defaultValues={{ name: company.name }} onSubmit={rename} busy={busy} error={error || undefined} notice={notice ? { tone: 'success', text: notice } : undefined}
      messages={{ nameLabel: 'Company name', rename: 'Rename company', nameBlank: 'Enter the company name.' }} /></Stack>}
    <SettingsSection title='Books' description='The base currency and its minor units cannot be changed.'>
      <DescriptionList items={[
        ...manager ? [] : [{ term: 'Company name', description: company.name }],
        ...company.secondLanguageName ? [{ term: 'Name in a second language', description: company.secondLanguageName }] : [],
        { term: 'Base currency', description: `${company.baseCurrency} · ${currency?.name ?? ''} (${company.currencyMinorUnits} decimal places)` },
        { term: 'Financial year starts', description: `${company.financialYearStart.day} ${months[company.financialYearStart.month - 1]}` },
        { term: 'Books begin on', description: company.booksBeginning },
        { term: 'Time zone', description: company.timeZone },
        { term: 'Locked through', description: company.lockedThrough ?? 'Not locked' },
      ]} />
    </SettingsSection>
  </Stack>
}
