import { Button, DateRangeField, Dialog, Field, Inline, Input, KeyHint, ReportPanel, ReportToolbar, saveFile, ShortcutScope, Stack, Switch, Text } from '@ten98/ui'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useCompany } from '../../lib/app-context'
import { contextTitles, type CommandId } from '../../lib/commands'
import { defaultScopeNote, longDate, periodText, reportFailureAction, type DefaultsText, type PeriodKind, type ReportPeriod } from '../../lib/reports'
import { KeyboardMenu, type KeyboardMenuGroup } from '../KeyboardMenu'
import { DialogKeys, ReservedKeys, screenModeText, useAppCommand, useBackOverride, useOpenScreen, type ScreenMode } from '../KeyboardShell'
import { loadDefaults, periodSearch, reportRoutes, type ReportRoute, type ReportSearch } from './navigation'

/** Reports the "open another report" menu offers, by the menu letter command each one answers to. */
const destinations: readonly { group: string; command: CommandId; label: string; report: ReportRoute }[] = [
  { group: 'Statements', command: 'home.balance-sheet', label: 'Balance sheet', report: 'balance-sheet' },
  { group: 'Statements', command: 'home.profit-and-loss', label: 'Profit and loss', report: 'profit-and-loss' },
  { group: 'Statements', command: 'home.trial-balance', label: 'Trial balance', report: 'trial-balance' },
  { group: 'Statements', command: 'report.open.group-summary', label: 'Group summary', report: 'group-summary' },
  { group: 'Registers', command: 'home.day-book', label: 'Day book', report: 'day-book' },
  { group: 'Registers', command: 'home.ledger', label: 'Ledger', report: 'ledger' },
  { group: 'Cost centres', command: 'report.open.cost-category-summary', label: 'Cost category summary', report: 'cost-category-summary' },
  { group: 'Cost centres', command: 'report.open.cost-centre-breakup', label: 'Cost centre break-up', report: 'cost-centre-breakup' },
]

export type PeriodControl =
  | { kind: 'range'; period: ReportPeriod | null; onChange: (period: ReportPeriod) => void }
  | { kind: 'date'; date: string | null; onChange: (date: string) => void }

/**
 * The frame of every report screen: the report commands in the reports context (D-05), the panel with the company,
 * period and status, the view switches, the period dialog, the "open another report" menu, CSV export and print.
 * Escape goes back one level through `back` (nav.back). The table inside registers the movement and drill commands.
 *
 * `period` is what the address asks for (the period dialog starts from it); `shown` is the period the report actually
 * covers when the server cut it short, and the scope line and the as-of date state that one. A failure the user can fix by
 * changing the period (`failure`, see reportFailureAction) offers "Change period" first instead of "Try again".
 */
export function ReportScreen({ title, search, periodKind = 'statement', period, shown, failure, detail, zeros, exportPath, back, summary, status, error, onRetry, children }: {
  title: string
  search: ReportSearch
  /** Only a statement's period carries into another report; the day book's day and the voucher view do not. */
  periodKind?: PeriodKind
  /** Omitted where the report has no period (the voucher view). */
  period?: PeriodControl
  /** The period the report covers when it differs from the one asked for (a clipped monthly summary). */
  shown?: ReportPeriod | null
  /** The failed request's status, when `status` is 'error'. */
  failure?: { status?: number } | null
  detail?: { on: boolean; toggle: () => void }
  zeros?: { shown: boolean; toggle: () => void }
  /** The API path of the CSV export, when the report has one. */
  exportPath?: string | null
  back: () => void
  summary?: ReactNode
  status: 'loading' | 'ready' | 'error'
  error?: string
  onRetry?: () => void
  children: ReactNode
}) {
  const company = useCompany()
  const [periodOpen, setPeriodOpen] = useState(false)
  const [goToMode, setGoToMode] = useState<ScreenMode | null>(null)
  const goToOpen = goToMode !== null
  const shownMode = useRef<ScreenMode>('go-to')
  if (goToMode) shownMode.current = goToMode
  const openScreen = useOpenScreen()
  const goToMenu = useRef<HTMLElement>(null)
  const [goToActive, setGoToActive] = useState<CommandId>(destinations[0].command)
  const [exportState, setExportState] = useState<{ busy: boolean; message: string; failed: boolean }>({ busy: false, message: '', failed: false })

  async function exportCsv() {
    if (!exportPath || exportState.busy) return
    setExportState({ busy: true, message: 'Preparing the export…', failed: false })
    try {
      const response = await fetch(exportPath, { credentials: 'same-origin' })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `The export failed with status ${response.status}.`)
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'report.csv'
      saveFile(name, await response.blob(), 'text/csv')
      setExportState({ busy: false, message: `Saved ${name}.`, failed: false })
    } catch (cause) {
      setExportState({ busy: false, message: cause instanceof Error ? cause.message : 'The export failed. Try again.', failed: true })
    }
  }

  useBackOverride(back)
  const defaults = useReportDefaults(company.id, period !== undefined)
  const covered = shown ?? (period?.kind === 'range' ? period.period : null)
  const note = defaults && period?.kind === 'range' && covered ? defaultScopeNote(covered, periodKind, false, defaults)
    : defaults && period?.kind === 'date' && period.date ? defaultScopeNote({ from: period.date, to: period.date }, periodKind, true, defaults) : null
  const scopeText = period?.kind === 'range' ? (covered ? periodText(covered) : 'Choosing the period…')
    : period?.kind === 'date' ? (period.date ? `As at ${longDate(period.date)}` : 'Choosing the date…') : 'Read-only'
  const changeButton = period && <Button variant='secondary' size='sm' onClick={() => setPeriodOpen(true)}>Change {period.kind === 'date' ? 'date' : 'period'} <KeyHint command='report.period' /></Button>

  return <ShortcutScope name={contextTitles.report}>
    <ReservedKeys context='report' />
    <ReportCommands periodOpen={() => setPeriodOpen(true)} hasPeriod={period !== undefined} detail={detail} zeros={zeros}
      exportCsv={exportPath ? () => void exportCsv() : undefined} openList={setGoToMode} />
    <Stack gap={4}>
      <ReportToolbar label={`${title} view`}
        controls={<Inline gap={4} wrap align='center'>
          {detail && <Switch label='Detailed' checked={detail.on} onCheckedChange={detail.toggle} />}
          {zeros && <Switch label='Lines without amounts' checked={zeros.shown} onCheckedChange={zeros.toggle} />}
          {changeButton}
        </Inline>}
        summary={summary}
        actions={exportState.message ? <Text size='sm' tone={exportState.failed ? 'danger' : 'muted'} role='status'>{exportState.message}</Text> : undefined} />
      <ReportPanel title={title} scope={<Text as='span' dir='auto'>{scopeText}{note ? ` (${note})` : ''}</Text>} source={<Text as='span' dir='auto'>{company.name} · amounts in {company.baseCurrency}</Text>}
        asOf={<Text as='span' dir='auto'>{covered ? longDate(covered.to) : period?.kind === 'date' && period.date ? longDate(period.date) : '—'}</Text>}
        status={status} reason={status === 'error' ? error : status === 'loading' ? 'Loading…' : undefined} retainedContent
        retry={status === 'error' ? (period && reportFailureAction(failure) === 'change-period' ? changeButton : onRetry ? <Button variant='secondary' size='sm' onClick={onRetry}>Try again</Button> : undefined) : undefined}>
        {children}
      </ReportPanel>
    </Stack>
    {period && <PeriodDialog open={periodOpen} onOpenChange={setPeriodOpen} control={period} />}
    <DialogKeys name={screenModeText[shownMode.current].title} open={goToOpen}><Dialog open={goToOpen} onOpenChange={next => { if (!next) setGoToMode(null) }} title={`${screenModeText[shownMode.current].title} another report`} description={`${screenModeText[shownMode.current].description} ${periodKind === 'statement' ? 'The period carries over. ' : ''}Use the arrow keys and Enter, or press a report’s letter.`} initialFocus={goToMenu}>
      {goToOpen && <KeyboardMenu label='Reports' menuRef={goToMenu} active={goToActive} onActiveChange={setGoToActive}
        groups={reportMenuGroups(report => { const how = shownMode.current; setGoToMode(null); void openScreen(how, reportRoutes[report], { companyId: company.id }, periodKind === 'statement' ? periodSearch(search) : {}) })} />}
    </Dialog></DialogKeys>
  </ShortcutScope>
}

/** The server's defaults for the company (fetched once per company and tab), for the scope line's note; null until known or when they cannot be read. */
function useReportDefaults(companyId: string, wanted: boolean): DefaultsText | null {
  const [found, setFound] = useState<{ companyId: string; defaults: DefaultsText } | null>(null)
  useEffect(() => {
    if (!wanted) return
    let live = true
    loadDefaults(companyId).then(defaults => { if (live) setFound({ companyId, defaults }) }, () => undefined)
    return () => { live = false }
  }, [companyId, wanted])
  return found?.companyId === companyId ? found.defaults : null
}

/** The reports menu (the "open another report" dialog and the Reports section), grouped. */
export function reportMenuGroups(open: (report: ReportRoute) => void): KeyboardMenuGroup[] {
  return [...new Set(destinations.map(entry => entry.group))].map(group => ({
    id: group.toLowerCase(), label: group,
    items: destinations.filter(entry => entry.group === group).map(entry => ({ command: entry.command, label: entry.label, open: () => open(entry.report) })),
  }))
}

function ReportCommands({ periodOpen, hasPeriod, detail, zeros, exportCsv, openList }: {
  periodOpen: () => void; hasPeriod: boolean; detail?: { toggle: () => void }; zeros?: { toggle: () => void }; exportCsv?: () => void; openList: (mode: ScreenMode) => void
}) {
  useAppCommand('report.period', periodOpen, { enabled: hasPeriod })
  useAppCommand('report.detail', () => detail?.toggle(), { enabled: detail !== undefined })
  useAppCommand('report.zero-lines', () => zeros?.toggle(), { enabled: zeros !== undefined })
  useAppCommand('report.export', () => exportCsv?.(), { enabled: exportCsv !== undefined })
  useAppCommand('report.print', () => window.print())
  useAppCommand('nav.go-to', () => openList('go-to'))
  useAppCommand('nav.switch-to', () => openList('switch-to'))
  return null
}

/** The period (or the as-at date) of a report: a small form that opens on its first date field; Enter applies it. */
function PeriodDialog({ open, onOpenChange, control }: { open: boolean; onOpenChange: (open: boolean) => void; control: PeriodControl }) {
  const id = useId()
  const initial = control.kind === 'range' ? control.period : null
  const [range, setRange] = useState({ start: initial?.from ?? '', end: initial?.to ?? '' })
  const [date, setDate] = useState(control.kind === 'date' ? control.date ?? '' : '')
  const [problem, setProblem] = useState<string | null>(null)
  const [shownFor, setShownFor] = useState(false)
  const body = useRef<HTMLElement>(null)
  if (open !== shownFor) {
    // Each time the dialog opens it starts from the report's current period.
    setShownFor(open)
    if (open) { setRange({ start: initial?.from ?? '', end: initial?.to ?? '' }); setDate(control.kind === 'date' ? control.date ?? '' : ''); setProblem(null) }
  }
  return <DialogKeys name='Period' open={open} onAccept={() => body.current?.closest('form')?.requestSubmit()}><Dialog open={open} onOpenChange={onOpenChange} title={control.kind === 'date' ? 'Change the date' : 'Change the period'} initialFocus='first-field'
    description={control.kind === 'date' ? 'The balance sheet shows balances at the end of this day.' : 'Every report you open next uses this period until you change it.'}
    onSubmit={() => {
      if (control.kind === 'date') { if (date) { control.onChange(date); onOpenChange(false) } return }
      if (problem || !range.start || !range.end) return
      control.onChange({ from: range.start, to: range.end })
      onOpenChange(false)
    }}
    footer={<Inline gap={2}><Button type='submit'>Show the report</Button><Button type='button' variant='ghost' onClick={() => onOpenChange(false)}>Cancel</Button></Inline>}>
    <Stack ref={body}>{control.kind === 'range'
      ? <DateRangeField label='Period' start={range.start} end={range.end} maxDays={3660} onChange={(next, issue) => { setRange(next); setProblem(issue) }} />
      : <Field label='As at' htmlFor={`${id}date`}><Input id={`${id}date`} type='date' value={date} required onChange={event => setDate(event.target.value)} /></Field>}</Stack>
  </Dialog></DialogKeys>
}
