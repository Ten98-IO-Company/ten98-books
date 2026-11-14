import { Alert, Button, Field, Form, FormActions, FormGrid, Input, PageHeader, Select, Stack } from '@ten98/ui'
import { useRef, useState } from 'react'
import { ApiError, errMsg } from '../lib/api'
import { baseCurrencies, companyCreateInput, type CompanyCreateInput } from '../lib/company'

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * The company's details and books settings: the create-company screen, and the step that finishes a company created
 * without them (first-user setup). Field messages come from the schema the server enforces; its answer stays authoritative.
 */
export function CompanySetupForm({ title, eyebrow, description, defaultName = '', submitLabel, busyLabel, onSubmit, onUnauthorized }: {
  title: string
  eyebrow?: string
  description: string
  defaultName?: string
  submitLabel: string
  busyLabel: string
  onSubmit: (value: CompanyCreateInput) => Promise<void>
  onUnauthorized: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  // One request at a time: a second Enter or click while the first is out is ignored, not sent again.
  const inFlight = useRef(false)

  async function submit(data: FormData) {
    if (inFlight.current) return
    const text = (name: string) => String(data.get(name) ?? '')
    const value = {
      name: text('name'), baseCurrency: text('baseCurrency') as CompanyCreateInput['baseCurrency'],
      financialYearStart: { month: Number(text('fyMonth')), day: Number(text('fyDay')) },
      booksBeginning: text('booksBeginning'), timeZone: text('timeZone').trim(), secondLanguageName: text('secondLanguageName'),
    }
    const parsed = companyCreateInput.safeParse(value)
    if (!parsed.success) {
      const errors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === 'financialYearStart' ? 'fyDay' : String(issue.path[0])
        errors[key] ??= issue.message.startsWith('Invalid') || issue.message.startsWith('Too') ? 'Check this value.' : issue.message
      }
      setFieldErrors(errors); setError(''); return
    }
    inFlight.current = true
    setBusy(true); setError(''); setFieldErrors({})
    try { await onSubmit(value) }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { onUnauthorized(); return }
      setError(errMsg(cause))
    } finally { inFlight.current = false; setBusy(false) }
  }

  return <Stack gap={6}>
    <PageHeader eyebrow={eyebrow} title={title} description={description} />
    <Form onSubmit={submit} busy={busy} fieldErrors={fieldErrors} gap={4}>
      <Field label='Company name' error={fieldErrors.name}><Input name='name' required maxLength={120} autoComplete='organization' defaultValue={defaultName} /></Field>
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
      <FormActions><Button type='submit' disabled={busy}>{busy ? busyLabel : submitLabel}</Button></FormActions>
    </Form>
  </Stack>
}
