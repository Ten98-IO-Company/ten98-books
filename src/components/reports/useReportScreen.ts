import { useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { useCompany } from '../../lib/app-context'
import { popCursor, pushCursor, readCursorStack, reportSubject, syncHighlight, writeCursorStack, type HighlightState, type PeriodKind, type ReportPeriod } from '../../lib/reports'
import { periodSearch, useReport, useReportNavigation, useReportPeriod, type ReportLink, type ReportSearch } from './navigation'

/**
 * What every report screen needs from its route: the period (filled in when absent), the report itself, the highlighted
 * line (restored from `hl` when coming back), drill-down and back, and setters for the view switches and the period,
 * which replace the history entry because they change this level rather than open a new one. A route is not remounted
 * when only its search changes, so the highlight follows the address whenever the subject or its `hl` changes
 * (syncHighlight), and data read for another subject is not shown (useReport).
 */
export function useReportScreen<T>(search: ReportSearch, kind: PeriodKind, path: (period: ReportPeriod, companyId: string) => string | null) {
  const company = useCompany()
  const navigate = useNavigate()
  const { period, error: periodError } = useReportPeriod(company.id, search, kind)
  const subject = reportSubject(search)
  const report = useReport<T>(period ? path(period, company.id) : null, 'report', subject)
  const navigation = useReportNavigation(company.id)
  const [tracked, setTracked] = useState<HighlightState>(() => syncHighlight({ level: '', highlight: undefined }, subject, search.hl))
  const synced = syncHighlight(tracked, subject, search.hl)
  if (synced !== tracked) setTracked(synced)
  const highlight = synced.highlight
  const setHighlight = useCallback((key: string | undefined) => setTracked(previous => ({ ...previous, highlight: key })), [])
  const update = useCallback((change: (previous: ReportSearch) => ReportSearch) =>
    void navigate({ to: '.', search: change as never, replace: true }), [navigate])
  const open = useCallback((link: ReportLink) => navigation.open({ ...link, search: { ...periodSearch(search), ...link.search } }, highlight),
    [navigation, search, highlight])
  return {
    company, period, report, highlight, setHighlight, open, back: navigation.back, hrefOf: navigation.hrefOf,
    status: periodError ? 'error' as const : report.status, error: periodError || report.error,
    setPeriod: (next: ReportPeriod) => update(previous => ({ ...previous, ...next, hl: undefined, pages: undefined })),
    detail: { on: search.detail === true, toggle: () => update(previous => ({ ...previous, detail: previous.detail ? undefined : true })) },
    zeros: { shown: search.zeros === true, toggle: () => update(previous => ({ ...previous, zeros: previous.zeros ? undefined : true })) },
  }
}

/**
 * Keyset pages of a register (day book, ledger vouchers). The cursors of the pages before this one are kept in the
 * address (`pages`, joined by dots), so PageUp past the first line can go back, and going back from a drill-down (the
 * trail returns to the address left) restores the page and its highlighted line. A new period or subject drops them
 * (setPeriod clears `pages`; links carry only the period). The screen ignores paging keys and pager clicks while a page
 * loads (ReportTable `pageBusy`); pushCursor ignores a repeat of the cursor on top.
 */
export function useCursorPages(search: ReportSearch) {
  const navigate = useNavigate()
  const cursors = readCursorStack(search.pages)
  const change = (next: (cursors: readonly string[]) => readonly string[]) => {
    const pages = next(cursors)
    void navigate({ to: '.', search: ((previous: ReportSearch) => ({ ...previous, pages: writeCursorStack(pages), hl: undefined })) as never, replace: true })
  }
  return {
    after: cursors.at(-1),
    hasPrevious: cursors.length > 0,
    next: (cursor: string) => change(current => pushCursor(current, cursor)),
    previous: () => change(popCursor),
  }
}
