import type { DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { Amount, Balance, Particulars } from '../../components/reports/cells'
import { CostCentresOff } from '../../components/reports/CostCentresOff'
import { query, reportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { CostCategorySummary } from '../../lib/cost-centres'
import type { Wire } from '../../lib/money'
import { costSummaryLines, costSummaryTarget, type CostSummaryLine } from '../../lib/reports'

/**
 * The cost category summary (docs/REPORTS.md, "Cost centres"): each category with its top-level centres for the
 * period, every sub-centre folded into its top-level centre. Enter on a centre opens its break-up.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/cost-category-summary')({ validateSearch: reportSearch, component: CostCategorySummaryScreen })

const columns: DataColumn<CostSummaryLine>[] = [
  { key: 'particulars', header: 'Particulars', rowHeader: true, wrap: true, minWidth: 'md',
    render: row => <Particulars label={row.name} depth={row.depth} strong={row.kind === 'category'} extra={row.kind === 'category' ? 'Category' : 'Cost centre'} /> },
  { key: 'opening', header: 'Opening balance', numeric: true, render: row => <Balance value={row.opening} strong={row.kind === 'category'} /> },
  { key: 'debit', header: 'Debit', numeric: true, render: row => <Amount value={row.debit} blankZero strong={row.kind === 'category'} /> },
  { key: 'credit', header: 'Credit', numeric: true, render: row => <Amount value={row.credit} blankZero strong={row.kind === 'category'} /> },
  { key: 'closing', header: 'Closing balance', numeric: true, render: row => <Balance value={row.closing} strong={row.kind === 'category'} /> },
]

function CostCategorySummaryScreen() {
  const search = Route.useSearch()
  const screen = useReportScreen<Wire<CostCategorySummary>>(search, 'statement',
    (period, companyId) => `/api/companies/${companyId}/reports/cost-category-summary?${query(period)}`)
  const data = screen.report.data
  const lines = useMemo(() => data ? costSummaryLines(data) : [], [data])
  return <ReportScreen title='Cost category summary' search={search} status={screen.status} error={screen.error} onRetry={screen.report.reload} failure={screen.failure}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }}
    exportPath={screen.period ? `/api/companies/${screen.company.id}/reports/cost-category-summary/export?${query(screen.period)}` : null}
    back={() => screen.back(null)}
    summary={data && !lines.length ? 'No cost centre has amounts in this period.' : undefined}>
    <CostCentresOff companyId={screen.company.id} />
    {data && <ReportTable caption='Cost categories and their centres' columns={columns} rows={lines} rowKey={row => row.key}
      highlight={screen.highlight ?? lines.find(row => row.kind === 'centre')?.key} onHighlight={screen.setHighlight}
      canOpen={row => costSummaryTarget(row) !== null}
      onOpen={row => { const target = costSummaryTarget(row); if (target) screen.open(target) }} />}
  </ReportScreen>
}

