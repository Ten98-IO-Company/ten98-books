import { Alert } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { TotalsSummary } from '../../components/reports/cells'
import { query } from '../../components/reports/navigation'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { StatementTable } from '../../components/reports/StatementTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import { useCompany } from '../../lib/app-context'
import type { Wire } from '../../lib/money'
import { asAtPeriod, readReportSearch, unreadableDateNotice, unreadableTo, type BalanceSheetReport } from '../../lib/reports'

/**
 * The balance sheet as at the period's end date. It shares the period with the other reports: changing its date moves
 * the end of the period (and its start too, if the new date is earlier). `to` alone is the as-at date. Both dates are
 * always written into the validated search (balanceSheetDates), so the raw address cannot show through. A `to` that is
 * no date arrives as `badTo` for one render (unreadableTo): the screen keeps it as its state for that visit and removes
 * it from the address, so a reload or a shared link never shows a stale notice.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/balance-sheet')({
  validateSearch: search => ({ ...readReportSearch(search), badTo: unreadableTo(search) }),
  component: BalanceSheetScreen,
})

function BalanceSheetScreen() {
  const addressed = Route.useSearch()
  const navigate = useNavigate()
  const company = useCompany()
  const [unreadable, setUnreadable] = useState(addressed.badTo)
  const asAt = asAtPeriod(addressed, company.financialYearStart)
  // A `to` alone is honoured: the screen reads the period from the address, so give it the one the date implies.
  const search = asAt ? { ...addressed, ...asAt } : addressed
  const screen = useReportScreen<Wire<BalanceSheetReport>>(search, 'statement', (period, companyId) => `/api/companies/${companyId}/reports/balance-sheet?${query({ date: period.to })}`)
  // Once the default date has been filled in, the unread text has done its work in the address.
  useEffect(() => {
    if (addressed.badTo && screen.period) void navigate({ to: '.', search: ((previous: Record<string, unknown>) => ({ ...previous, badTo: undefined })) as never, replace: true })
  }, [addressed.badTo, screen.period, navigate])
  const data = screen.report.data
  const date = screen.period?.to ?? null
  const change = (next: string) => {
    const from = screen.period && screen.period.from <= next ? screen.period.from : next
    setUnreadable(undefined)
    void navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, from, to: next, hl: undefined, pages: undefined }) as never, replace: true })
  }
  return <ReportScreen title='Balance sheet' search={search} status={screen.status} error={screen.error} onRetry={screen.report.reload} failure={screen.failure}
    period={{ kind: 'date', date, onChange: change }}
    detail={screen.detail} zeros={screen.zeros}
    exportPath={date ? `/api/companies/${screen.company.id}/reports/balance-sheet/export?${query({ date })}` : null}
    back={() => screen.back(null)}
    summary={data ? <TotalsSummary items={[['Capital and liabilities', data.totals.liabilities], ['Assets', data.totals.assets]]} /> : undefined}>
    {unreadable && <Alert tone='info' title='Date not read'>{unreadableDateNotice(unreadable, date)}</Alert>}
    {data && <StatementTable caption={`Balance sheet of ${screen.company.name}`} lines={data.lines} detail={screen.detail.on} zeros={screen.zeros.shown}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={link => screen.open(link.report === 'profit-and-loss' ? { report: 'profit-and-loss', search: { from: data.from, to: data.date } } : { ...link, search: { ...link.search, from: data.from, to: data.date } })} />}
  </ReportScreen>
}
