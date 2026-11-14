import { createFileRoute } from '@tanstack/react-router'
import { TotalsSummary } from '../../components/reports/cells'
import { query, reportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { StatementTable } from '../../components/reports/StatementTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { Wire } from '../../lib/money'
import type { BalanceSheetReport } from '../../lib/reports'

/**
 * The balance sheet as at the period's end date. It shares the period with the other reports: changing its date moves
 * the end of the period (and its start too, if the new date is earlier).
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/balance-sheet')({ validateSearch: reportSearch, component: BalanceSheetScreen })

function BalanceSheetScreen() {
  const search = Route.useSearch()
  const screen = useReportScreen<Wire<BalanceSheetReport>>(search, 'statement', (period, companyId) => `/api/companies/${companyId}/reports/balance-sheet?${query({ date: period.to })}`)
  const data = screen.report.data
  const date = screen.period?.to ?? null
  return <ReportScreen title='Balance sheet' search={search} status={screen.status} error={screen.error} onRetry={screen.report.reload}
    period={{ kind: 'date', date, onChange: next => screen.setPeriod({ from: screen.period && screen.period.from <= next ? screen.period.from : next, to: next }) }}
    detail={screen.detail} zeros={screen.zeros}
    exportPath={date ? `/api/companies/${screen.company.id}/reports/balance-sheet/export?${query({ date })}` : null}
    back={() => screen.back(null)}
    summary={data ? <TotalsSummary items={[['Capital and liabilities', data.totals.liabilities], ['Assets', data.totals.assets]]} /> : undefined}>
    {data && <StatementTable caption={`Balance sheet of ${screen.company.name}`} lines={data.lines} detail={screen.detail.on} zeros={screen.zeros.shown}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={link => screen.open(link.report === 'profit-and-loss' ? { report: 'profit-and-loss', search: { from: data.from, to: data.date } } : { ...link, search: { ...link.search, from: data.from, to: data.date } })} />}
  </ReportScreen>
}
