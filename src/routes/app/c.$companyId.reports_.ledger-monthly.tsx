import type { DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Amount, Balance, Particulars } from '../../components/reports/cells'
import { query, reportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Wire } from '../../lib/money'
import { longDate, monthText, type LedgerMonthlyReport } from '../../lib/reports'

/** A ledger's opening, then debit, credit and closing per month of the period (one financial year at a time). */
export const Route = createFileRoute('/app/c/$companyId/reports_/ledger-monthly')({ validateSearch: reportSearch, component: LedgerMonthlyScreen })

type Row = { key: string; label: string; debit: string | null; credit: string | null; closing: string; from: string; to: string; month: boolean }
const columns: DataColumn<Row>[] = [
  { key: 'month', header: 'Month', rowHeader: true, render: row => <Particulars label={row.label} muted={!row.month} /> },
  { key: 'debit', header: 'Debit', numeric: true, render: row => <Amount value={row.debit} blankZero /> },
  { key: 'credit', header: 'Credit', numeric: true, render: row => <Amount value={row.credit} blankZero /> },
  { key: 'closing', header: 'Closing balance', numeric: true, render: row => <Balance value={row.closing} /> },
]

function LedgerMonthlyScreen() {
  const search = Route.useSearch()
  const screen = useReportScreen<Wire<LedgerMonthlyReport>>(search, 'statement',
    (period, companyId) => search.ledger ? `/api/companies/${companyId}/reports/ledger-monthly/${search.ledger}?${query(period)}` : null)
  const data = screen.report.data
  const rows = useMemo<Row[]>(() => data ? [
    { key: 'o:opening', label: 'Opening balance', debit: null, credit: null, closing: data.opening, from: data.from, to: data.from, month: false },
    ...data.months.map(month => ({ key: month.month, label: monthText(month.month), debit: month.debit, credit: month.credit, closing: month.closing, from: month.from, to: month.to, month: true })),
  ] : [], [data])
  const ledger = data?.ledger
  return <ReportScreen title={ledger ? `Monthly summary: ${ledger.name}` : 'Monthly summary'} search={search} status={search.ledger ? screen.status : 'error'}
    error={search.ledger ? screen.error : 'Choose a ledger first.'} onRetry={screen.report.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }}
    exportPath={screen.period && search.ledger ? `/api/companies/${screen.company.id}/reports/ledger-monthly/${search.ledger}/export?${query(screen.period)}` : null}
    back={() => screen.back(ledger?.groupId ? { report: 'group-summary', search: { from: search.from, to: search.to, group: ledger.groupId } } : { report: 'ledger', search: { from: search.from, to: search.to } })}
    summary={data && data.to !== search.to ? `Shown through ${longDate(data.to)}, the end of the financial year.` : undefined}>
    {data && <ReportTable caption={`Monthly summary of ${data.ledger.name}`} columns={columns} rows={rows} rowKey={row => row.key}
      highlight={screen.highlight ?? rows[1]?.key} onHighlight={screen.setHighlight} canOpen={row => row.month}
      onOpen={row => { if (row.month) screen.open({ report: 'ledger-vouchers', search: { ledger: data.ledger.id, from: row.from, to: row.to } }) }}
      footerCells={['Total', <Amount key='debit' value={data.totals.debit} strong />, <Amount key='credit' value={data.totals.credit} strong />, <Balance key='closing' value={data.totals.closing} strong />]} />}
  </ReportScreen>
}
