import { Text, type DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Amount, Blank, Balance, Particulars } from '../../components/reports/cells'
import { query, reportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useCursorPages, useReportScreen } from '../../components/reports/useReportScreen'
import type { Wire } from '../../lib/money'
import { longDate, type LedgerVoucherRow, type LedgerVouchersReport } from '../../lib/reports'

/** One ledger's vouchers in the period with the running balance and the ledgers on the other side; paged. */
export const Route = createFileRoute('/app/c/$companyId/reports_/ledger-vouchers')({ validateSearch: reportSearch, component: LedgerVouchersScreen })

type Row = { key: string; entry: Wire<LedgerVoucherRow> | null; balance: string; label: string }
const columns: DataColumn<Row>[] = [
  { key: 'date', header: 'Date', render: row => row.entry ? <Text as='span' numeric>{row.entry.date}</Text> : <Blank /> },
  { key: 'particulars', header: 'Particulars', rowHeader: true, wrap: true, minWidth: 'md',
    render: row => <Particulars label={row.label} muted={!row.entry} extra={row.entry?.otherLedgers ? <Text as='span' size='sm' tone='muted'>and {row.entry.otherLedgers} more</Text> : undefined} /> },
  { key: 'type', header: 'Voucher type', render: row => row.entry?.voucherTypeName ?? <Blank /> },
  { key: 'number', header: 'Number', numeric: true, render: row => row.entry?.number ?? <Blank /> },
  { key: 'debit', header: 'Debit', numeric: true, render: row => <Amount value={row.entry?.debit} blankZero /> },
  { key: 'credit', header: 'Credit', numeric: true, render: row => <Amount value={row.entry?.credit} blankZero /> },
  { key: 'balance', header: 'Balance', numeric: true, render: row => <Balance value={row.balance} /> },
]

function LedgerVouchersScreen() {
  const search = Route.useSearch()
  const pages = useCursorPages(`${search.ledger}|${search.from}|${search.to}`)
  const screen = useReportScreen<Wire<LedgerVouchersReport>>(search, 'statement', (period, companyId) => search.ledger
    ? `/api/companies/${companyId}/reports/ledger-vouchers/${search.ledger}?${query({ ...period, after: pages.after })}` : null)
  const data = screen.report.data
  const rows = useMemo<Row[]>(() => data ? [
    ...pages.hasPrevious ? [] : [{ key: 'o:opening', entry: null, balance: data.opening, label: `Opening balance on ${longDate(data.from)}` }],
    ...data.rows.map(entry => ({ key: entry.voucherId, entry, balance: entry.balance, label: entry.particulars })),
  ] : [], [data, pages.hasPrevious])
  const ledger = data?.ledger
  return <ReportScreen title={ledger ? `Ledger vouchers: ${ledger.name}` : 'Ledger vouchers'} search={search} status={search.ledger ? screen.status : 'error'}
    error={search.ledger ? screen.error : 'Choose a ledger first.'} onRetry={screen.report.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }}
    exportPath={screen.period && search.ledger ? `/api/companies/${screen.company.id}/reports/ledger-vouchers/${search.ledger}/export?${query(screen.period)}` : null}
    back={() => screen.back(search.ledger ? { report: 'ledger-monthly', search: { from: search.from, to: search.to, ledger: search.ledger } } : null)}>
    {data && <ReportTable caption={`Vouchers of ${data.ledger.name}`} columns={columns} rows={rows} rowKey={row => row.key}
      highlight={screen.highlight} onHighlight={screen.setHighlight} canOpen={row => row.entry !== null}
      onOpen={row => { if (row.entry) screen.open({ report: 'voucher', search: { voucher: row.entry.voucherId, ledger: data.ledger.id } }) }}
      page={{ cursor: { hasPrevious: pages.hasPrevious, hasNext: data.next !== null } }}
      pageBusy={screen.report.status === 'loading'} onPage={direction => { if (direction === 'next' && data.next) pages.next(data.next); else if (direction === 'previous') pages.previous() }}
      footerCells={['', 'Total for the period', '', '', <Amount key='debit' value={data.totals.debit} strong />, <Amount key='credit' value={data.totals.credit} strong />,
        <Balance key='closing' value={data.totals.closing} strong />]} />}
  </ReportScreen>
}
