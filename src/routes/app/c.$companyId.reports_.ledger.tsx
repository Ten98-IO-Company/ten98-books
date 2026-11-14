import { Field, Input, type DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useId, useMemo, useState } from 'react'
import { Particulars } from '../../components/reports/cells'
import { reportSearch, useReport } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Ledger } from '../../lib/ledger'
import type { Wire } from '../../lib/money'

/**
 * Choose a ledger to open its monthly summary. Typing narrows the list and Enter opens the highlighted ledger, which is
 * the first match while typing; Tab reaches the list for the arrow keys.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/ledger')({ validateSearch: reportSearch, component: LedgerChooser })

type Row = Wire<Ledger>
const columns: DataColumn<Row>[] = [
  { key: 'name', header: 'Ledger', rowHeader: true, wrap: true, minWidth: 'md', render: row => <Particulars label={row.name} /> },
  { key: 'group', header: 'Group', wrap: true, render: row => row.groupName ?? 'Outside every group' },
]

function LedgerChooser() {
  const search = Route.useSearch()
  const id = useId()
  const screen = useReportScreen<never>(search, 'statement', () => null)
  const ledgers = useReport<Row[]>(`/api/companies/${screen.company.id}/ledgers`, 'ledgers')
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const words = filter.trim().toLowerCase()
    return (ledgers.data ?? []).filter(row => !words || row.name.toLowerCase().includes(words) || row.secondLanguageName?.toLowerCase().includes(words))
  }, [ledgers.data, filter])
  return <ReportScreen title='Ledger' search={search} status={ledgers.status} error={ledgers.error} onRetry={ledgers.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }} back={() => screen.back(null)}>
    <Field label='Find a ledger' htmlFor={`${id}find`} description='Enter opens the highlighted ledger.'>
      <Input id={`${id}find`} type='search' value={filter} autoComplete='off' onChange={event => { setFilter(event.target.value); screen.setHighlight(undefined) }} />
    </Field>
    <ReportTable caption='Ledgers' columns={columns} rows={rows} rowKey={row => row.id} focusOnLoad={false}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={row => screen.open({ report: 'ledger-monthly', search: { ledger: row.id } })} />
  </ReportScreen>
}
