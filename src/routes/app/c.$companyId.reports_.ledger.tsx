import type { DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Particulars } from '../../components/reports/cells'
import { useReport } from '../../components/reports/navigation'
import { PickerFind, useChooser } from '../../components/reports/PickerFind'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Ledger } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import { narrowByName, readReportSearch } from '../../lib/reports'

/**
 * Choose a ledger to open its monthly summary. The find field has focus on arrival: typing narrows the list, Enter opens
 * the highlighted ledger (the first one of the narrowed list, shown highlighted from the start), and Down reaches the
 * list for the arrow keys.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/ledger')({ validateSearch: readReportSearch, component: LedgerChooser })

type Row = Wire<Ledger>
const columns: DataColumn<Row>[] = [
  { key: 'name', header: 'Ledger', rowHeader: true, wrap: true, minWidth: 'md', render: row => <Particulars label={row.name} /> },
  { key: 'group', header: 'Group', wrap: true, render: row => row.groupName ?? 'Outside every group' },
]

function LedgerChooser() {
  const search = Route.useSearch()
  const screen = useReportScreen<never>(search, 'statement', () => null)
  const ledgers = useReport<Row[]>(`/api/companies/${screen.company.id}/ledgers`, 'ledgers')
  const chooser = useChooser(screen.company.id, 'ledger', search.hl, screen.setHighlight)
  const rows = useMemo(() => narrowByName(ledgers.data ?? [], chooser.filter), [ledgers.data, chooser.filter])
  return <ReportScreen title='Ledger' search={search} status={ledgers.status} error={ledgers.error} onRetry={ledgers.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }} back={() => screen.back(null)}>
    <PickerFind label='Find a ledger' noun='ledger' filter={chooser.filter} onFilter={chooser.onFilter} matches={rows.length} controlRef={chooser.controlRef} />
    <ReportTable caption='Ledgers' columns={columns} rows={rows} rowKey={row => row.id} focusOnLoad={false} controlRef={chooser.controlRef}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={row => { chooser.remember(); screen.open({ report: 'ledger-monthly', search: { ledger: row.id } }, row.id) }} />
  </ReportScreen>
}
