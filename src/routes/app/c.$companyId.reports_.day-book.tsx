import { Text, type DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { Amount, Blank, Particulars, VoucherMarks } from '../../components/reports/cells'
import { query, reportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useCursorPages, useReportScreen } from '../../components/reports/useReportScreen'
import type { Wire } from '../../lib/money'
import type { DayBookReport, DayBookRow } from '../../lib/reports'

/**
 * The day book: the vouchers of one day (by default the last voucher date) or of a period, in entry order. The amount
 * stands in the column of the voucher's first line; cancelled and optional vouchers are marked and not counted.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/day-book')({ validateSearch: reportSearch, component: DayBookScreen })

type Row = Wire<DayBookRow>
const counts = (row: Row) => row.status === 'regular'
const columns: DataColumn<Row>[] = [
  { key: 'date', header: 'Date', render: row => <Text as='span' numeric>{row.date}</Text> },
  { key: 'particulars', header: 'Particulars', rowHeader: true, wrap: true, minWidth: 'md',
    render: row => <Particulars label={row.particulars} muted={!counts(row)} extra={<VoucherMarks status={row.status} postDated={row.postDated} />} /> },
  { key: 'type', header: 'Voucher type', render: row => row.voucherTypeName },
  { key: 'number', header: 'Number', numeric: true, render: row => row.number ?? <Blank /> },
  { key: 'debit', header: 'Debit', numeric: true, render: row => row.side === 'Dr' ? <Amount value={row.amount} /> : <Blank /> },
  { key: 'credit', header: 'Credit', numeric: true, render: row => row.side === 'Cr' ? <Amount value={row.amount} /> : <Blank /> },
]

function DayBookScreen() {
  const search = Route.useSearch()
  const pages = useCursorPages(`${search.from}|${search.to}`)
  const screen = useReportScreen<Wire<DayBookReport>>(search, 'day', (period, companyId) => `/api/companies/${companyId}/reports/day-book?${query({ ...period, after: pages.after })}`)
  const data = screen.report.data
  return <ReportScreen title='Day book' search={search} status={screen.status} error={screen.error} onRetry={screen.report.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }}
    exportPath={screen.period ? `/api/companies/${screen.company.id}/reports/day-book/export?${query(screen.period)}` : null}
    back={() => screen.back(null)}
    summary={data ? `${data.totals.vouchers} ${data.totals.vouchers === 1 ? 'voucher counts' : 'vouchers count'} in the totals; cancelled and optional vouchers do not.` : undefined}>
    {data && <ReportTable caption='Vouchers in the day book' columns={columns} rows={data.rows} rowKey={row => row.voucherId}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={row => screen.open({ report: 'voucher', search: { voucher: row.voucherId } })}
      page={{ cursor: { hasPrevious: pages.hasPrevious, hasNext: data.next !== null } }}
      onPage={direction => { if (direction === 'next' && data.next) pages.next(data.next); else if (direction === 'previous') pages.previous() }}
      footerCells={['', 'Total of regular vouchers', '', '', <Amount key='debit' value={data.totals.debit} strong />, <Amount key='credit' value={data.totals.credit} strong />]} />}
  </ReportScreen>
}
