import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { useCompany } from '../../lib/app-context'
import { popCursor, pushCursor, type PeriodKind, type ReportPeriod } from '../../lib/reports'
import { periodSearch, useReport, useReportNavigation, useReportPeriod, type ReportLink, type ReportSearch } from './navigation'

/**
 * What every report screen needs from its route: the period (filled in when absent), the report itself, the highlighted
 * line (restored from `hl` when coming back), drill-down and back, and setters for the view switches and the period,
 * which replace the history entry because they change this level rather than open a new one.
 */
export function useReportScreen<T>(search: ReportSearch, kind: PeriodKind, path: (period: ReportPeriod, companyId: string) => string | null) {
  const company = useCompany()
  const navigate = useNavigate()
  const { period, error: periodError } = useReportPeriod(company.id, search, kind)
  const report = useReport<T>(period ? path(period, company.id) : null)
  const navigation = useReportNavigation(company.id)
  const [highlight, setHighlight] = useState(search.hl)
  const update = useCallback((change: (previous: ReportSearch) => ReportSearch) =>
    void navigate({ to: '.', search: change as never, replace: true }), [navigate])
  const open = useCallback((link: ReportLink) => navigation.open({ ...link, search: { ...periodSearch(search), ...link.search } }, highlight),
    [navigation, search, highlight])
  return {
    company, period, report, highlight, setHighlight, open, back: navigation.back, hrefOf: navigation.hrefOf,
    status: periodError ? 'error' as const : report.status, error: periodError || report.error,
    setPeriod: (next: ReportPeriod) => update(previous => ({ ...previous, ...next, hl: undefined })),
    detail: { on: search.detail === true, toggle: () => update(previous => ({ ...previous, detail: previous.detail ? undefined : true })) },
    zeros: { shown: search.zeros === true, toggle: () => update(previous => ({ ...previous, zeros: previous.zeros ? undefined : true })) },
  }
}

/**
 * Keyset pages of a register (day book, ledger vouchers): the cursors of the pages before this one are kept so PageUp
 * past the first line can go back. `reset` (the period and subject) starts again from the first page. The screen also
 * ignores paging keys while a page loads (ReportTable `pageBusy`); pushCursor ignores a repeat of the cursor on top.
 */
export function useCursorPages(reset: string) {
  const [state, setState] = useState<{ reset: string; cursors: readonly string[] }>({ reset, cursors: [] })
  const cursors = state.reset === reset ? state.cursors : []
  const change = (next: (cursors: readonly string[]) => readonly string[]) =>
    setState(previous => ({ reset, cursors: next(previous.reset === reset ? previous.cursors : []) }))
  return {
    after: cursors.at(-1),
    hasPrevious: cursors.length > 0,
    next: (cursor: string) => change(current => pushCursor(current, cursor)),
    previous: () => change(popCursor),
  }
}
