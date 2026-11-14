import type { DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Amount, Particulars, TotalsSummary } from '../../components/reports/cells'
import { query, reportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Wire } from '../../lib/money'
import { isZeroNode, type NodeAmounts, type StatementNode, type TrialBalanceReport } from '../../lib/reports'

/** Trial balance by group: opening, debit, credit and closing columns, with the opening difference line (D-10). */
export const Route = createFileRoute('/app/c/$companyId/reports_/trial-balance')({ validateSearch: reportSearch, component: TrialBalanceScreen })

type Line = { key: string; label: string; depth: number; node: Wire<StatementNode> | null; amounts: Wire<NodeAmounts> }

const amountColumn = (key: keyof NodeAmounts, header: string): DataColumn<Line> =>
  ({ key, header, numeric: true, render: line => <Amount value={line.amounts[key]} blankZero strong={line.node === null} /> })
const columns: DataColumn<Line>[] = [
  { key: 'particulars', header: 'Particulars', rowHeader: true, wrap: true, minWidth: 'md',
    render: line => <Particulars label={line.label} depth={line.depth} strong={line.depth === 0} muted={line.node === null} /> },
  amountColumn('openingDebit', 'Opening debit'), amountColumn('openingCredit', 'Opening credit'),
  amountColumn('debit', 'Debit'), amountColumn('credit', 'Credit'),
  amountColumn('closingDebit', 'Closing debit'), amountColumn('closingCredit', 'Closing credit'),
]

function TrialBalanceScreen() {
  const search = Route.useSearch()
  const screen = useReportScreen<Wire<TrialBalanceReport>>(search, 'statement', (period, companyId) => `/api/companies/${companyId}/reports/trial-balance?${query(period)}`)
  const data = screen.report.data
  const lines = useMemo<Line[]>(() => {
    if (!data) return []
    const shown = data.nodes.filter(node => (search.detail || node.depth === 0) && (search.zeros || !isZeroNode(node)))
      .map((node): Line => ({ key: node.key, label: node.name, depth: node.depth, node, amounts: node }))
    if (data.difference) shown.push({ key: 'd:opening', label: 'Difference in opening balances', depth: 0, node: null, amounts: data.difference })
    return shown
  }, [data, search.detail, search.zeros])
  const totals = data?.grandTotals
  return <ReportScreen title='Trial balance' search={search} status={screen.status} error={screen.error} onRetry={screen.report.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }} detail={screen.detail} zeros={screen.zeros}
    exportPath={screen.period ? `/api/companies/${screen.company.id}/reports/trial-balance/export?${query(screen.period)}` : null}
    back={() => screen.back(null)}
    summary={totals ? <TotalsSummary items={[['Closing debit', totals.closingDebit], ['Closing credit', totals.closingCredit]]} /> : undefined}>
    {data && <ReportTable caption={`Trial balance for ${screen.company.name}`} columns={columns} rows={lines} rowKey={line => line.key}
      highlight={screen.highlight} onHighlight={screen.setHighlight} canOpen={line => line.node !== null}
      onOpen={line => {
        if (!line.node) return
        screen.open(line.node.kind === 'group' ? { report: 'group-summary', search: { group: line.node.id } } : { report: 'ledger-monthly', search: { ledger: line.node.id } })
      }}
      footerCells={totals ? ['Total', ...(['openingDebit', 'openingCredit', 'debit', 'credit', 'closingDebit', 'closingCredit'] as const).map(key => <Amount key={key} value={totals[key]} strong />)] : undefined} />}
  </ReportScreen>
}
