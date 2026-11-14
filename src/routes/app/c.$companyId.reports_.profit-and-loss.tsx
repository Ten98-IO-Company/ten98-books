import { createFileRoute } from '@tanstack/react-router'
import { Amount } from '../../components/reports/cells'
import { query, reportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { StatementTable } from '../../components/reports/StatementTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Wire } from '../../lib/money'
import type { ProfitAndLossReport } from '../../lib/reports'

/** Profit and loss for a period inside one financial year: trading section to gross profit, then the net result. */
export const Route = createFileRoute('/app/c/$companyId/reports_/profit-and-loss')({ validateSearch: reportSearch, component: ProfitAndLossScreen })

function ProfitAndLossScreen() {
  const search = Route.useSearch()
  const screen = useReportScreen<Wire<ProfitAndLossReport>>(search, 'statement', (period, companyId) => `/api/companies/${companyId}/reports/profit-and-loss?${query(period)}`)
  const data = screen.report.data
  const net = data?.netProfit
  return <ReportScreen title='Profit and loss' search={search} status={screen.status} error={screen.error} onRetry={screen.report.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }} detail={screen.detail} zeros={screen.zeros}
    exportPath={screen.period ? `/api/companies/${screen.company.id}/reports/profit-and-loss/export?${query(screen.period)}` : null}
    back={() => screen.back(null)}
    summary={net !== undefined ? <>{net.startsWith('-') ? 'Net loss' : 'Net profit'} <Amount value={net.replace(/^-/, '')} strong /></> : undefined}>
    {data && <StatementTable caption={`Profit and loss for ${screen.company.name}`} lines={data.lines} detail={screen.detail.on} zeros={screen.zeros.shown}
      highlight={screen.highlight} onHighlight={screen.setHighlight} onOpen={screen.open} />}
  </ReportScreen>
}
