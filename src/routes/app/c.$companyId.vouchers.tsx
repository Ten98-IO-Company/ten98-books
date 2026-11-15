import { Alert, Button, StatusLine } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errMsg } from '../../lib/api'
import type { VoucherType } from '../../lib/ledger'
import { isEntryKind, type EntryKind } from '../../lib/voucher-entry'
import { readStored, sessionStore } from '../../lib/working-date'
import { useApp, useCompany } from '../../lib/app-context'
import { useWorkingDate } from '../../components/vouchers/useWorkingDate'
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
  const userId = useApp().me.user.id
  const search = Route.useSearch()
  const canWrite = useCanWrite()
  const { groups, ledgers, error, reload } = useMasterData(company.id)
  const [types, setTypes] = useState<VoucherType[] | null>(null)
  const [workingDate, setWorkingDate] = useWorkingDate(company)
  const [readError, setReadError] = useState('')
  useEffect(() => {
    let live = true
    api<{ voucherTypes: VoucherType[] }>(`/api/companies/${company.id}/voucher-types`).then(found => { if (live) setTypes(found.voucherTypes) }).catch(cause => { if (live) setReadError(errMsg(cause)) })
    return () => { live = false }
  }, [company.id])
  if (canWrite === false) return <ViewerNotice companyId={company.id} />
  if (error || readError) return <Alert tone='danger' actions={<Button size='sm' variant='secondary' onClick={reload}>Try again</Button>}>The voucher screen could not be loaded: {error || readError}</Alert>
  if (!groups || !ledgers || !types || !workingDate || canWrite === undefined) return <StatusLine busy>Loading the voucher screen…</StatusLine>
  const stored = readStored(sessionStore, lastTypeKey(userId, company.id))
  const kind = search.type ?? (isEntryKind(stored) ? stored : 'payment')
  return <VoucherEntryScreen company={company} ledgers={ledgers} groups={groups} types={types} start={{ kind, date: workingDate }} workingDate={workingDate} onWorkingDate={setWorkingDate} />
}

/** A viewer who opens the address: the notice, with the way back focused so the keyboard has somewhere to start. */
function ViewerNotice({ companyId }: { companyId: string }) {
  const navigate = useNavigate()
  return <Alert tone='info' title='Viewers cannot enter vouchers' actions={<Button size='sm' autoFocus onClick={() => void navigate({ to: '/app/c/$companyId/reports/day-book', params: { companyId } })}>Open the day book</Button>}>
    The day book and the reports show what is saved.
  </Alert>
}
