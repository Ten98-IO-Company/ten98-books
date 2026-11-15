import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errMsg } from '../../lib/api'
import { useApp } from '../../lib/app-context'
import type { Wire } from '../../lib/money'
import { dataForSubject, readReportSearch, reportLevel, recordPeriod, rememberedPeriod, type PeriodKind, type ReportDefaults, type ReportPeriod } from '../../lib/reports'

/**
 * Report navigation (D-09: drill-down is by route). Everything a report shows is in its search parameters, so a report
 * survives a reload and can be linked: the period (`from`, `to`), the view (`detail`, `zeros`), the subject (`group`,
 * `ledger`, `voucher`, `centre`) and the highlighted line (`hl`, written into the level being left when drilling down, so going
 * back restores it).
 */
export type ReportSearch = {
  from?: string; to?: string; detail?: boolean; zeros?: boolean; hl?: string; group?: string; ledger?: string; voucher?: string; centre?: string
  /** On a ledger's vouchers: the cost centre whose break-up opened them (they are not filtered by it; the screen says so). */
  fromCentre?: string
  /** A register's earlier page cursors, oldest first, joined by dots (base64url cursors contain none). */
  pages?: string
}

/**
 * The route search schema of every report screen: unknown or malformed values are dropped, never trusted. It writes every
 * key (readReportSearch), because the router lays the raw address under a validated search and a key left out would let
 * a number, a list or a text that is no date through to the screen.
 */
export function reportSearch(search: Record<string, unknown>): ReportSearch {
  return readReportSearch(search)
}

/** The statement period last shown per company in this tab: a statement opened without one carries it on (it is sticky). */
const lastPeriod = new Map<string, ReportPeriod>()
const defaults = new Map<string, Promise<Wire<ReportDefaults>>>()

/** Where reports of the company open; fetched once per company and tab, again after a failure. */
export function loadDefaults(companyId: string): Promise<Wire<ReportDefaults>> {
  let pending = defaults.get(companyId)
  if (!pending) {
    pending = api<{ defaults: Wire<ReportDefaults> }>(`/api/companies/${companyId}/reports/defaults`).then(result => result.defaults)
    pending.catch(() => defaults.delete(companyId))
    defaults.set(companyId, pending)
  }
  return pending
}

/**
 * The period of the report on screen. With none in the address it fills one in (replacing the history entry): the day
 * book its last voucher date, statements the statement period shown last in this tab or the financial-year start
 * through the last voucher date. Only statement periods are remembered (recordPeriod); `none` (the voucher view) keeps
 * whatever the address carries and fills nothing in. Returns null until a period is in the address.
 */
export function useReportPeriod(companyId: string, search: ReportSearch, kind: PeriodKind): { period: ReportPeriod | null; error: string } {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const period = search.from && search.to && search.from <= search.to ? { from: search.from, to: search.to } : null
  useEffect(() => {
    if (period) { recordPeriod(lastPeriod, companyId, kind, period); return }
    if (kind === 'none') return
    let live = true
    const remembered = rememberedPeriod(lastPeriod, companyId, kind)
    const fill = (chosen: ReportPeriod) => { if (live) void navigate({ to: '.', search: (previous: ReportSearch) => ({ ...previous, ...chosen }), replace: true }) }
    if (remembered) fill(remembered)
    else loadDefaults(companyId).then(found => fill(kind === 'day' ? { from: found.dayBookDate, to: found.dayBookDate } : found.period))
      .catch(cause => { if (live) setError(errMsg(cause)) })
    return () => { live = false }
  }, [companyId, period?.from, period?.to, kind])
  return { period, error }
}

export type Loaded<T> = { status: 'loading' | 'ready' | 'error'; data: T | null; error: string; /** The failed request's status and code (status 0: no answer from the server); null unless `status` is 'error'. */ failure: { status: number; code?: string } | null; reload: () => void }

/**
 * GETs a report (null `path` waits) and reads `field` of the response. Keeps the last result while the next one loads,
 * so the screen does not jump, but only for the same `subject` (reportSubject): a drill to another group, ledger or centre
 * on the same route shows nothing of the level it left while it loads or fails.
 */
export function useReport<T>(path: string | null, field = 'report', subject?: string): Loaded<T> {
  const { unauthorized } = useApp()
  const [state, setState] = useState<{ path: string | null; subject: string | undefined; data: T | null; error: string; failure?: { status: number; code?: string } }>({ path: null, subject: undefined, data: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    api<Record<string, T>>(path, { signal: controller.signal })
      .then(result => setState({ path, subject, data: result[field] ?? null, error: '' }))
      .catch(cause => {
        if (controller.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 401) unauthorized()
        else setState(previous => ({ path, subject: previous.subject, data: previous.data, error: errMsg(cause), failure: { status: cause instanceof ApiError ? cause.status : 0, code: cause instanceof ApiError ? cause.code : undefined } }))
      })
    return () => controller.abort()
  }, [path, subject, attempt])
  const reload = useCallback(() => setAttempt(value => value + 1), [])
  const settled = state.path === path
  return { status: !settled ? 'loading' : state.error ? 'error' : 'ready', data: dataForSubject(state, subject), error: settled ? state.error : '', failure: settled && state.error ? state.failure ?? null : null, reload }
}

/** A query string from defined values only. */
export function query(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(values)) if (value !== undefined && value !== null) params.set(name, String(value))
  return params.toString()
}

/** Report screens by name, as route paths under the company. */
export const reportRoutes = {
  index: '/app/c/$companyId/reports',
  'day-book': '/app/c/$companyId/reports/day-book',
  'trial-balance': '/app/c/$companyId/reports/trial-balance',
  'profit-and-loss': '/app/c/$companyId/reports/profit-and-loss',
  'balance-sheet': '/app/c/$companyId/reports/balance-sheet',
  'group-summary': '/app/c/$companyId/reports/group-summary',
  ledger: '/app/c/$companyId/reports/ledger',
  'ledger-monthly': '/app/c/$companyId/reports/ledger-monthly',
  'ledger-vouchers': '/app/c/$companyId/reports/ledger-vouchers',
  voucher: '/app/c/$companyId/reports/voucher',
  'cost-category-summary': '/app/c/$companyId/reports/cost-category-summary',
  'cost-centre-breakup': '/app/c/$companyId/reports/cost-centre-breakup',
} as const
export type ReportRoute = keyof typeof reportRoutes
export type ReportLink = { report: ReportRoute; search: ReportSearch }

/** One drill-down step: the level left (with its highlight) and the level opened, as addresses without the highlight. */
type Step = { child: string; parent: string; n: number }
const trail: Step[] = []
/** Drill-downs counted in this tab, so a step can be told newer than a mark (`trailMark`). */
let drills = 0

/** A level of the trail: see reportLevel (the period, page, view and highlight do not make another level). */
const levelOf = reportLevel

/** The drill-downs so far; a step numbered above a mark was taken after it. */
export const trailMark = (): number => drills
/** The number of the trail step going back from this address follows (a level reached by drilling down), or null. */
export const trailStepOf = (href: string): number | null => trail.findLast(step => step.child === levelOf(href))?.n ?? null

/**
 * Drill-down and back for report screens. `open` goes down one level, recording where it came from and the line that
 * was highlighted; `back` returns to that level with the highlight restored, or, when this level was reached some
 * other way (an address, a reload), to its logical parent.
 */
export function useReportNavigation(companyId: string) {
  const router = useRouter()
  const href = useRouterState({ select: state => state.location.href })
  const hrefOf = useCallback((link: ReportLink) => router.buildLocation({ to: reportRoutes[link.report], params: { companyId }, search: link.search } as never).href,
    [router, companyId])

  const open = useCallback((link: ReportLink, highlight?: string) => {
    const here = new URL(href, 'http://report.invalid')
    if (highlight) here.searchParams.set('hl', highlight)
    const target = hrefOf(link)
    const child = levelOf(target)
    const existing = trail.findIndex(step => step.child === child)
    if (existing >= 0) trail.splice(existing)
    trail.push({ child, parent: `${here.pathname}${here.search}`, n: ++drills })
    void router.navigate({ href: target })
  }, [href, hrefOf, router])

  const back = useCallback((fallback: ReportLink | null) => {
    const index = trail.findLastIndex(step => step.child === levelOf(href))
    if (index >= 0) {
      const [step] = trail.splice(index)
      void router.navigate({ href: step.parent })
    } else if (fallback) void router.navigate({ href: hrefOf(fallback) })
    else void router.navigate({ to: '/app/c/$companyId', params: { companyId } })
  }, [href, hrefOf, router, companyId])

  return { open, back, hrefOf }
}

/** The period part of a search, to carry from one report to the next. */
export const periodSearch = (search: ReportSearch): ReportSearch => ({ from: search.from, to: search.to, detail: search.detail, zeros: search.zeros })
