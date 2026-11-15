import type { DataColumn } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Amount, Balance, Particulars } from '../../components/reports/cells'
import { CostCentresOff } from '../../components/reports/CostCentresOff'
import { query, reportSearch, useReport, type ReportSearch } from '../../components/reports/navigation'
import { PickerFind } from '../../components/reports/PickerFind'
import { ReportScreen } from '../../components/reports/ReportScreen'
import { ReportTable } from '../../components/reports/ReportTable'
import { useReportScreen } from '../../components/reports/useReportScreen'
import type { CostBreakupRow, CostCentreBreakup, CostCentreListItem } from '../../lib/cost-centres'
import type { Wire } from '../../lib/money'
import { costBreakupKey, costBreakupSummary, costBreakupTarget, matchingCentres } from '../../lib/reports'

/**
 * One cost centre's break-up for the period (`centre` in the address): its direct sub-centres, each with its own
 * sub-centres folded in, and the ledgers of its own rows. Enter on a sub-centre opens its break-up, on a ledger that
 * ledger's vouchers for the period (all of them: the vouchers report has no centre filter, and both screens say so).
 * Without a centre the screen lists the centres to choose from.
 */
export const Route = createFileRoute('/app/c/$companyId/reports_/cost-centre-breakup')({ validateSearch: reportSearch, component: CostCentreBreakupScreen })

type Row = Wire<CostBreakupRow>
const columns: DataColumn<Row>[] = [
  { key: 'particulars', header: 'Particulars', rowHeader: true, wrap: true, minWidth: 'md',
    render: row => <Particulars label={row.name} strong={row.kind === 'centre'} extra={row.kind === 'centre' ? 'Sub-centre' : 'Ledger'} /> },
  { key: 'opening', header: 'Opening balance', numeric: true, render: row => <Balance value={row.opening} /> },
  { key: 'debit', header: 'Debit', numeric: true, render: row => <Amount value={row.debit} blankZero /> },
  { key: 'credit', header: 'Credit', numeric: true, render: row => <Amount value={row.credit} blankZero /> },
  { key: 'closing', header: 'Closing balance', numeric: true, render: row => <Balance value={row.closing} /> },
]

function CostCentreBreakupScreen() {
  const search = Route.useSearch()
  return search.centre ? <Breakup search={search} centreId={search.centre} /> : <CentreChooser search={search} />
}

function Breakup({ search, centreId }: { search: ReportSearch; centreId: string }) {
  const screen = useReportScreen<Wire<CostCentreBreakup>>(search, 'statement',
    (period, companyId) => `/api/companies/${companyId}/reports/cost-centre-breakup/${centreId}?${query(period)}`)
  const data = screen.report.data
  const rows = data?.rows ?? []
  const centre = data?.centre
  return <ReportScreen title={centre ? `Cost centre break-up: ${centre.name}` : 'Cost centre break-up'} search={search} status={screen.status} error={screen.error}
    onRetry={screen.report.reload} failure={screen.failure} period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }}
    exportPath={screen.period ? `/api/companies/${screen.company.id}/reports/cost-centre-breakup/${centreId}/export?${query(screen.period)}` : null}
    back={() => screen.back({ report: 'cost-category-summary', search: { from: search.from, to: search.to } })}
    summary={data ? costBreakupSummary(data) : undefined}>
    <CostCentresOff companyId={screen.company.id} />
    {data && <ReportTable caption={`Sub-centres and ledgers of ${data.centre.name}`} columns={columns} rows={rows} rowKey={costBreakupKey}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={row => screen.open(costBreakupTarget(row, centreId))}
      footerCells={['Total', <Balance key='opening' value={data.totals.opening} strong />, <Amount key='debit' value={data.totals.debit} strong />,
        <Amount key='credit' value={data.totals.credit} strong />, <Balance key='closing' value={data.totals.closing} strong />]} />}
  </ReportScreen>
}

type Centre = Wire<CostCentreListItem>
const centreColumns: DataColumn<Centre>[] = [
  { key: 'name', header: 'Cost centre', rowHeader: true, wrap: true, minWidth: 'md', render: row => <Particulars label={row.name} /> },
  { key: 'category', header: 'Category', wrap: true, render: row => row.categoryName },
]

/** Choose a centre, as the ledger chooser does: the find field has focus on arrival, typing narrows the list, and Enter opens the highlighted centre's break-up (the first of the narrowed list, shown highlighted from the start). */
function CentreChooser({ search }: { search: ReportSearch }) {
  const screen = useReportScreen<never>(search, 'statement', () => null)
  const centres = useReport<Centre[]>(`/api/companies/${screen.company.id}/cost-centres`, 'costCentres')
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => matchingCentres(centres.data ?? [], filter), [centres.data, filter])
  return <ReportScreen title='Cost centre break-up' search={search} status={centres.status} error={centres.error} onRetry={centres.reload}
    period={{ kind: 'range', period: screen.period, onChange: screen.setPeriod }} back={() => screen.back(null)}
    summary={centres.data && !centres.data.length ? 'This company has no cost centres yet.' : undefined}>
    <CostCentresOff companyId={screen.company.id} />
    <PickerFind label='Find a cost centre' noun='cost centre' filter={filter} onFilter={text => { setFilter(text); screen.setHighlight(undefined) }} matches={rows.length} />
    <ReportTable caption='Cost centres' columns={centreColumns} rows={rows} rowKey={row => row.id} focusOnLoad={false}
      highlight={screen.highlight} onHighlight={screen.setHighlight}
      onOpen={row => screen.open({ report: 'cost-centre-breakup', search: { centre: row.id } })} />
  </ReportScreen>
}
