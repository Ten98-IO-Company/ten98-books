import { DescriptionList, PageHeader, SettingsSection, Stack, WorkspaceCreateFlow } from '@ten98/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
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
 * A rename reloads the company list, and the company layout then reloads the company and mounts this page again. The
 * success notice crosses that remount in the state of this page's own history entry, naming the company renamed: the
 * new page shows it once, with focus back on the name, and takes it off the entry, so a reload, another entry or
 * another company never shows it.
 */
declare module '@tanstack/react-router' {
  interface HistoryState { companyRenamed?: string }
}
const renamedNotice = 'The company name was changed.'

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function CompanySettings() {
  const company = useCompany()
  const { current, reloadCompanies, unauthorized } = useApp()
  const manager = current?.id === company.id && (current.role === 'owner' || current.role === 'admin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const handedOver = () => router.history.location.state.companyRenamed === company.id
  const [notice, setNotice] = useState(() => handedOver() ? renamedNotice : '')
  const nameField = useRef<HTMLElement>(null)
  /** Writes the hand-over onto the current history entry, or takes it off. */
  const markEntry = (companyRenamed: string | undefined) => router.history.replace(router.history.location.href, { ...router.history.location.state, companyRenamed })
  useEffect(() => {
    if (!handedOver()) return
    markEntry(undefined)
    nameField.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus()
  }, [])

  async function rename({ name }: { name: string }) {
    setBusy(true); setError(''); setNotice('')
    try {
      await api(`/api/workspaces/${company.id}/rename`, { method: 'POST', body: { name } })
      // Only a changed name reloads the company and remounts this page; otherwise the notice is set below directly.
      if (name !== company.name) markEntry(company.id)
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
