import type { DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useRef } from 'react'
import { Particulars } from '../../components/reports/cells'
import { reportSearch, useReport } from '../../components/reports/navigation'
import { PickerFind, usePickerFind } from '../../components/reports/PickerFind'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Ledger } from '../../lib/ledger'
import type { Wire } from '../../lib/money'

/**
 * Choose a ledger to open its monthly summary. The find field has focus on arrival: typing narrows the list, Enter opens
 * the highlighted ledger (the first match while typing) once the list was narrowed or the highlight moved, and Down
 * reaches the list for the arrow keys.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/ledger')({ validateSearch: reportSearch, component: LedgerChooser })

type Row = Wire<Ledger>
const columns: DataColumn<Row>[] = [
  { key: 'name', header: 'Ledger', rowHeader: true, wrap: true, minWidth: 'md', render: row => <Particulars label={row.name} /> },
  { key: 'group', header: 'Group', wrap: true, render: row => row.groupName ?? 'Outside every group' },
]

function LedgerChooser() {
  const search = Route.useSearch()
  const screen = useReportScreen<never>(search, 'statement', () => null)
  const ledgers = useReport<Row[]>(`/api/companies/${screen.company.id}/ledgers`, 'ledgers')
  const find = usePickerFind(screen.highlight, screen.setHighlight)
  const focusRows = useRef<(() => void) | null>(null)
  const rows = useMemo(() => {
    const words = find.filter.trim().toLowerCase()
    return (ledgers.data ?? []).filter(row => !words || row.name.toLowerCase().includes(words) || row.secondLanguageName?.toLowerCase().includes(words))
  }, [ledgers.data, find.filter])
  return <ReportScreen title='Ledger' search={search} status={ledgers.status} error={ledgers.error} onRetry={ledgers.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }} back={() => screen.back(null)}>
    <PickerFind label='Find a ledger' description='Type to narrow the list, then Enter opens the highlighted ledger.' filter={find.filter} onFilter={find.onFilter} prompt={find.prompt} focusRows={focusRows} />
    <ReportTable caption='Ledgers' columns={columns} rows={rows} rowKey={row => row.id} focusOnLoad={false} focusRows={focusRows}
      highlight={screen.highlight} onHighlight={find.onMove}
      onOpen={row => find.choose(() => screen.open({ report: 'ledger-monthly', search: { ledger: row.id } }))} />
  </ReportScreen>
}
