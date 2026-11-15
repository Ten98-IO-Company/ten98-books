import { Alert, Button, StatusLine } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errMsg } from '../../lib/api'
import { useCompany } from '../../lib/app-context'
import type { VoucherType } from '../../lib/ledger'
import { isEntryKind, type EntryKind } from '../../lib/voucher-entry'
import { readStored, readWorkingDate, sessionStore, startingWorkingDate, writeWorkingDate } from '../../lib/working-date'
import { loadDefaults } from '../../components/reports/navigation'
import { useCanWrite } from '../../components/masters/useCanWrite'
import { useMasterData } from '../../components/masters/useMasterData'
import { lastTypeKey, VoucherEntryScreen } from '../../components/vouchers/VoucherEntryScreen'

/** Voucher entry, create (docs/VOUCHERS.md). `type` opens a voucher type; without it, the type last used in this tab, payment the first time. */
export const Route = createFileRoute('/app/c/$companyId/vouchers')({
  validateSearch: (search: Record<string, unknown>): { type?: EntryKind } => isEntryKind(search.type) ? { type: search.type } : {},
  component: VouchersRoute,
})

function VouchersRoute() {
  const company = useCompany()
  const search = Route.useSearch()
  const canWrite = useCanWrite()
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  const [types, setTypes] = useState<VoucherType[] | null>(null)
  const [workingDate, setWorkingDate] = useState<string | null>(() => readWorkingDate(sessionStore, company.id))
  const [readError, setReadError] = useState('')
  useEffect(() => {
    let live = true
    api<{ voucherTypes: VoucherType[] }>(`/api/companies/${company.id}/voucher-types`).then(found => { if (live) setTypes(found.voucherTypes) }).catch(cause => { if (live) setReadError(errMsg(cause)) })
    if (readWorkingDate(sessionStore, company.id) === null) loadDefaults(company.id).then(found => { if (live) setWorkingDate(startingWorkingDate(found)) }).catch(cause => { if (live) setReadError(errMsg(cause)) })
    return () => { live = false }
  }, [company.id])
  if (canWrite === false) return <Alert tone='info'>Viewers cannot enter vouchers. The day book and the reports show what is saved.</Alert>
  if (error || readError) return <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>The voucher screen could not be loaded: {error || readError}</Alert>
  if (!groups || !ledgers || !types || !workingDate || canWrite === undefined) return <StatusLine busy>Loading the voucher screen…</StatusLine>
  const stored = readStored(sessionStore, lastTypeKey(company.id))
  const kind = search.type ?? (isEntryKind(stored) ? stored : 'payment')
  const changeWorkingDate = (date: string) => { writeWorkingDate(sessionStore, company.id, date); setWorkingDate(date) }
  return <VoucherEntryScreen company={company} ledgers={ledgers} groups={groups} types={types} start={{ kind, date: workingDate }} workingDate={workingDate} onWorkingDate={changeWorkingDate} />
}
