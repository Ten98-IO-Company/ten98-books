import type { DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Amount, Balance, Particulars } from '../../components/reports/cells'
import { query, reportSearch, type ReportLink } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Wire } from '../../lib/money'
import { isZeroNode, type GroupSummaryReport, type StatementNode } from '../../lib/reports'

/** One group's sub-groups and ledgers for the period (`group` in the address), or the primary level without one. */
export const Route = createFileRoute('/app/c/$companyId/reports_/group-summary')({ validateSearch: reportSearch, component: GroupSummaryScreen })

type Row = Wire<StatementNode>
const columns: DataColumn<Row>[] = [
  { key: 'particulars', header: 'Particulars', rowHeader: true, wrap: true, minWidth: 'md',
    render: row => <Particulars label={row.name} strong={row.kind === 'group'} /> },
  { key: 'opening', header: 'Opening balance', numeric: true, render: row => <Balance value={row.opening} /> },
  { key: 'debit', header: 'Debit', numeric: true, render: row => <Amount value={row.debit} blankZero /> },
  { key: 'credit', header: 'Credit', numeric: true, render: row => <Amount value={row.credit} blankZero /> },
  { key: 'closing', header: 'Closing balance', numeric: true, render: row => <Balance value={row.closing} /> },
]

function GroupSummaryScreen() {
  const search = Route.useSearch()
  const screen = useReportScreen<Wire<GroupSummaryReport>>(search, 'statement',
    (period, companyId) => `/api/companies/${companyId}/reports/group-summary${search.group ? `/${search.group}` : ''}?${query(period)}`)
  const data = screen.report.data
  const rows = useMemo(() => data?.rows.filter(row => search.zeros || !isZeroNode(row)) ?? [], [data, search.zeros])
  const group = data?.group ?? null
  // Without a drill-down trail, back goes to the parent group, or to the statement the group belongs to.
  const parent: ReportLink | null = !group ? null
    : group.parentId ? { report: 'group-summary', search: { from: search.from, to: search.to, group: group.parentId } }
    : { report: group.nature === 'asset' || group.nature === 'liability' ? 'balance-sheet' : 'profit-and-loss', search: { from: search.from, to: search.to } }
  return <ReportScreen title={group ? `Group summary: ${group.name}` : 'Group summary: primary groups'} search={search} status={screen.status} error={screen.error}
    onRetry={screen.report.reload} period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }} zeros={screen.zeros}
    exportPath={screen.period ? `/api/companies/${screen.company.id}/reports/group-summary${search.group ? `/${search.group}` : ''}/export?${query(screen.period)}` : null}
    back={() => screen.back(parent)}>
    {data && <ReportTable caption={group ? `Sub-groups and ledgers of ${group.name}` : 'Primary groups'} columns={columns} rows={rows} rowKey={row => row.key}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={row => screen.open(row.kind === 'group' ? { report: 'group-summary', search: { group: row.id } } : { report: 'ledger-monthly', search: { ledger: row.id } })}
      footerCells={['Total', <Balance key='opening' value={data.totals.opening} strong />, <Amount key='debit' value={data.totals.debit} strong />,
        <Amount key='credit' value={data.totals.credit} strong />, <Balance key='closing' value={data.totals.closing} strong />]} />}
  </ReportScreen>
}
