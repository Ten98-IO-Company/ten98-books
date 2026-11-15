import { Alert, DescriptionList, PageHeader, SettingsSection, Stack, WorkspaceCreateFlow } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
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

const renamedNotice = 'The company name was changed.'

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function CompanySettings() {
  const company = useCompany()
  const { current, reloadCompanies, unauthorized } = useApp()
  const manager = current?.id === company.id && (current.role === 'owner' || current.role === 'admin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The notice lives in this page's state only: the company layout keeps this page mounted while it reads the renamed
  // company again, so nothing is stored outside React or in the history entry, and a reload never shows it again.
  const [notice, setNotice] = useState('')
  const nameField = useRef<HTMLElement>(null)
  // The refusal shown once the form has gone (the user may no longer rename): it takes focus from the removed form.
  const refusal = useCallback((alert: HTMLElement | null) => { alert?.focus() }, [])
  // The rename flow is remounted for the new name (its key); focus goes back to the name field once it is.
  useEffect(() => { if (notice) nameField.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus() }, [company.name, notice])

  async function rename({ name }: { name: string }) {
    setBusy(true); setError(''); setNotice('')
    try {
      await api(`/api/workspaces/${company.id}/rename`, { method: 'POST', body: { name } })
      await reloadCompanies()
      setNotice(renamedNotice)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { unauthorized(); return }
      setError(errMsg(cause))
      // Refused because the role changed elsewhere (a demotion, a removal): the list is read again, the form gives way to the
      // read-only name, and the refusal stays on the page above it.
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) void reloadCompanies()
    } finally { setBusy(false) }
  }

  const currency = baseCurrencies[company.baseCurrency]
  return <Stack gap={6}>
    <PageHeader title='Company settings' description='The settings the books of this company are kept in.' />
    {manager && <Stack ref={nameField}><WorkspaceCreateFlow key={company.name} mode='rename' title='Name' description='Shown in the company list, on every page and on reports.'
      defaultValues={{ name: company.name }} onSubmit={rename} busy={busy} error={error || undefined} notice={notice ? { tone: 'success', text: notice } : undefined}
      messages={{ nameLabel: 'Company name', rename: 'Rename company', nameBlank: 'Enter the company name.' }} /></Stack>}
    {!manager && error && <Stack ref={refusal} tabIndex={-1}><Alert tone='danger' role='alert' title={error} /></Stack>}
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
