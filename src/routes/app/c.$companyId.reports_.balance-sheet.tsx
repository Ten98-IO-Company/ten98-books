import { Alert } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { TotalsSummary } from '../../components/reports/cells'
import { query, reportSearch, type ReportSearch } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { StatementTable } from '../../components/reports/StatementTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import { useCompany } from '../../lib/app-context'
import type { Wire } from '../../lib/money'
import { asAtPeriod, unreadableDate, unreadableDateNotice, type BalanceSheetReport } from '../../lib/reports'

/**
 * The balance sheet as at the period's end date. It shares the period with the other reports: changing its date moves
 * the end of the period (and its start too, if the new date is earlier). `to` alone is the as-at date; a `to` that is no
 * date is kept as `badTo` so the screen can say what it could not read (the shared search schema drops it silently).
 */
type BalanceSheetSearch = ReportSearch & { badTo?: string }
const balanceSheetSearch = (search: Record<string, unknown>): BalanceSheetSearch => {
  const badTo = unreadableDate(search.to)
  // `to: undefined` is explicit because the router lays the raw address under a route's validated search, which would bring the bad text back.
  return { ...reportSearch(search), ...(badTo ? { to: undefined, badTo } : {}) }
}
export const Route = createFileRoute('/app/c/$companyId/reports_/balance-sheet')({ validateSearch: balanceSheetSearch, component: BalanceSheetScreen })

function BalanceSheetScreen() {
  const addressed = Route.useSearch()
  const navigate = useNavigate()
  const company = useCompany()
  const asAt = asAtPeriod(addressed, company.financialYearStart)
  // A `to` alone is honoured: the screen reads the period from the address, so give it the one the date implies.
  const search = asAt ? { ...addressed, ...asAt } : addressed
  const screen = useReportScreen<Wire<BalanceSheetReport>>(search, 'statement', (period, companyId) => `/api/companies/${companyId}/reports/balance-sheet?${query({ date: period.to })}`)
  const data = screen.report.data
  const date = screen.period?.to ?? null
  const change = (next: string) => {
    const from = screen.period && screen.period.from <= next ? screen.period.from : next
    void navigate({ to: '.', search: (previous: BalanceSheetSearch) => ({ ...previous, from, to: next, badTo: undefined, hl: undefined, pages: undefined }) as never, replace: true })
  }
  return <ReportScreen title='Balance sheet' search={search} status={screen.status} error={screen.error} onRetry={screen.report.reload}
    period={{ kind: 'date', date, onChange: change }}
    detail={screen.detail} zeros={screen.zeros}
    exportPath={date ? `/api/companies/${screen.company.id}/reports/balance-sheet/export?${query({ date })}` : null}
    back={() => screen.back(null)}
    summary={data ? <TotalsSummary items={[['Capital and liabilities', data.totals.liabilities], ['Assets', data.totals.assets]]} /> : undefined}>
    {addressed.badTo && <Alert tone='info' title='Date not read'>{unreadableDateNotice(addressed.badTo, date)}</Alert>}
    {data && <StatementTable caption={`Balance sheet of ${screen.company.name}`} lines={data.lines} detail={screen.detail.on} zeros={screen.zeros.shown}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={link => screen.open(link.report === 'profit-and-loss' ? { report: 'profit-and-loss', search: { from: data.from, to: data.date } } : { ...link, search: { ...link.search, from: data.from, to: data.date } })} />}
  </ReportScreen>
}
