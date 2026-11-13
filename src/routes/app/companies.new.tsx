import { Alert, Button, Field, Form, FormActions, FormGrid, Input, PageHeader, Select, Stack } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import { baseCurrencies, companyCreateInput, type Company } from '../../lib/company'

/** Discover's project-create flow, extended with the company's books settings (base currency, year start, books beginning, time zone). */
export const Route = createFileRoute('/app/companies/new')({ component: CreateCompany })

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function CreateCompany() {
  const { workspace, reloadCompanies, unauthorized } = useApp()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  async function submit(data: FormData) {
    const text = (name: string) => String(data.get(name) ?? '')
    const value = {
      name: text('name'), baseCurrency: text('baseCurrency'),
      financialYearStart: { month: Number(text('fyMonth')), day: Number(text('fyDay')) },
      booksBeginning: text('booksBeginning'), timeZone: text('timeZone').trim(), secondLanguageName: text('secondLanguageName'),
    }
    // Field messages come from the same schema the server enforces; the server's answer remains authoritative.
    const parsed = companyCreateInput.safeParse(value)
    if (!parsed.success) {
      const errors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === 'financialYearStart' ? 'fyDay' : String(issue.path[0])
        errors[key] ??= issue.message.startsWith('Invalid') || issue.message.startsWith('Too') ? 'Check this value.' : issue.message
      }
      setFieldErrors(errors); setError(''); return
    }
    setBusy(true); setError(''); setFieldErrors({})
    try {
      const { company } = await api<{ company: Company }>(`/api/workspaces/${workspace.id}/companies`, { method: 'POST', body: value })
      await reloadCompanies()
      void navigate({ to: '/app/c/$companyId', params: { companyId: company.id } })
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { unauthorized(); return }
      setError(errMsg(cause))
    } finally { setBusy(false) }
  }

  if (workspace.role === 'viewer') return <Alert tone='info'>Viewers cannot create companies. Ask a workspace owner, admin or editor.</Alert>
  return <Stack gap={6}>
    <PageHeader eyebrow={workspace.name} title='Create company' description='Each company keeps its own books. The base currency and its minor units cannot be changed later.' />
    <Form onSubmit={submit} busy={busy} fieldErrors={fieldErrors} gap={4}>
      <Field label='Company name' error={fieldErrors.name}><Input name='name' required maxLength={120} autoComplete='organization' /></Field>
      <Field label='Name in a second language' description='Optional, for example the Arabic trade name.' error={fieldErrors.secondLanguageName}>
        <Input name='secondLanguageName' maxLength={120} dir='auto' />
      </Field>
      <Field label='Base currency' error={fieldErrors.baseCurrency}>
        <Select name='baseCurrency' required defaultValue='AED' options={Object.entries(baseCurrencies).map(([code, currency]) => ({ value: code, label: `${code} · ${currency.name}` }))} />
      </Field>
      <FormGrid>
        <Field label='Financial year starts in' error={fieldErrors.fyMonth}>
          <Select name='fyMonth' required defaultValue='1' options={months.map((label, index) => ({ value: String(index + 1), label }))} />
        </Field>
        <Field label='On day' error={fieldErrors.fyDay}><Input name='fyDay' type='number' inputMode='numeric' required min={1} max={31} defaultValue='1' /></Field>
      </FormGrid>
      <Field label='Books begin on' description='The first date you record transactions for.' error={fieldErrors.booksBeginning}>
        <Input name='booksBeginning' type='date' required min='1900-01-01' max='2199-12-31' />
      </Field>
      <Field label='Time zone' description='A named time zone, for example Asia/Dubai. Voucher dates follow it.' error={fieldErrors.timeZone}>
        <Input name='timeZone' required maxLength={80} placeholder='Asia/Dubai' spellCheck={false} />
      </Field>
      {error && <Alert tone='danger'>{error}</Alert>}
      <FormActions><Button type='submit' disabled={busy}>{busy ? 'Creating…' : 'Create company'}</Button></FormActions>
    </Form>
  </Stack>
}
