import { DescriptionList, Stack, type DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { Amount, Blank, Particulars, VoucherMarks } from '../../components/reports/cells'
import { reportSearch, useReport } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Voucher, VoucherLine } from '../../lib/ledger'
import type { Wire } from '../../lib/money'
import { longDate } from '../../lib/reports'

/**
 * A voucher, read-only: the last level of the drill-down, read through the voucher API (read mode, the same
 * authorization as the reports). Editing belongs to the voucher screens. The report period stays in the address so
 * going back and opening other reports carries it.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/voucher')({ validateSearch: reportSearch, component: VoucherScreen })

type Line = Wire<VoucherLine>
const columns: DataColumn<Line>[] = [
  { key: 'ledger', header: 'Ledger', rowHeader: true, wrap: true, minWidth: 'md', render: line => <Particulars label={line.ledgerName} /> },
  { key: 'debit', header: 'Debit', numeric: true, render: line => line.side === 'Dr' ? <Amount value={line.amount} /> : <Blank /> },
  { key: 'credit', header: 'Credit', numeric: true, render: line => line.side === 'Cr' ? <Amount value={line.amount} /> : <Blank /> },
]

function VoucherScreen() {
  const search = Route.useSearch()
  const screen = useReportScreen<never>(search, 'none', () => null)
  const voucher = useReport<Wire<Voucher>>(search.voucher ? `/api/companies/${screen.company.id}/vouchers/${search.voucher}` : null, 'voucher')
  const data = voucher.data
  const title = data ? `${data.voucherTypeName} ${data.number ?? '(optional)'}` : 'Voucher'
  const back = () => screen.back(!data ? null : search.ledger
    ? { report: 'ledger-vouchers', search: { from: search.from, to: search.to, ledger: search.ledger } }
    : { report: 'day-book', search: { from: data.date, to: data.date } })
  return <ReportScreen title={title} search={search} periodKind='none' back={back} onRetry={voucher.reload}
    status={search.voucher ? voucher.status : 'error'} error={search.voucher ? voucher.error : 'Choose a voucher first.'}>
    {data && <Stack gap={4}>
      <DescriptionList columns={2} items={[
        { term: 'Date', description: longDate(data.date) },
        { term: 'Voucher type and number', description: `${data.voucherTypeName} ${data.number ?? '(optional, not numbered)'}` },
        { term: 'Status', description: <>{data.deleted ? 'Deleted' : data.status === 'regular' ? 'Regular' : ''} <VoucherMarks status={data.status} postDated={data.postDated} /></> },
        { term: 'Narration', description: data.narration ?? '—' },
      ]} />
      <ReportTable caption={`Lines of ${title}`} columns={columns} rows={data.lines} rowKey={line => String(line.lineNo)}
        highlight={screen.highlight} onHighlight={screen.setHighlight} onOpen={() => undefined} canOpen={() => false}
        footerCells={['Total', <Amount key='debit' value={data.total} strong />, <Amount key='credit' value={data.total} strong />]} />
    </Stack>}
  </ReportScreen>
}
