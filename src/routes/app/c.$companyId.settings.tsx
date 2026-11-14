import { Alert, Button, DescriptionList, Field, Form, FormActions, Input, PageHeader, SettingsSection, Stack } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp, useCompany } from '../../lib/app-context'
import { baseCurrencies } from '../../lib/company'

/**
 * The company's settings. The name is the workspace name (D-03), so renaming the company is the workspace rename, for
 * owners and admins. The books settings are shown read-only until editing them is built.
 */
export const Route = createFileRoute('/app/c/$companyId/settings')({ component: CompanySettings })

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function CompanySettings() {
  const company = useCompany()
  const { current, reloadCompanies, unauthorized } = useApp()
  const manager = current?.id === company.id && (current.role === 'owner' || current.role === 'admin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function rename(data: FormData) {
    const name = String(data.get('name') ?? '').trim()
    if (!name) { setError('Enter the company name.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      await api(`/api/workspaces/${company.id}/rename`, { method: 'POST', body: { name } })
      await reloadCompanies()
      setNotice('The company name was changed.')
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { unauthorized(); return }
      setError(errMsg(cause))
    } finally { setBusy(false) }
  }

  const currency = baseCurrencies[company.baseCurrency]
  return <Stack gap={6}>
    <PageHeader title='Company settings' description='The settings the books of this company are kept in.' />
    {manager && <SettingsSection title='Name' description='Shown in the company list, on every page and on reports.'>
      <Form onSubmit={rename} busy={busy} gap={4}>
        <Field label='Company name'><Input key={company.name} name='name' required maxLength={120} defaultValue={company.name} autoComplete='organization' /></Field>
        {error && <Alert tone='danger'>{error}</Alert>}
        {notice && <Alert tone='info'>{notice}</Alert>}
        <FormActions><Button type='submit' disabled={busy}>{busy ? 'Saving…' : 'Rename company'}</Button></FormActions>
      </Form>
    </SettingsSection>}
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
