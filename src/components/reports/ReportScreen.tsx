import { Button, DateRangeField, Dialog, Field, Inline, Input, KeyHint, ReportPanel, ReportToolbar, saveFile, ShortcutScope, Stack, Switch, Text } from '@ten98/ui'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState, type ReactNode } from 'react'
import { useCompany } from '../../lib/app-context'
import { contextTitles, type CommandId } from '../../lib/commands'
import { longDate, periodText, type ReportPeriod } from '../../lib/reports'
import { KeyboardMenu, type KeyboardMenuGroup } from '../KeyboardMenu'
import { useAppCommand, useBackOverride } from '../KeyboardShell'
import { periodSearch, reportRoutes, type ReportRoute, type ReportSearch } from './navigation'

/** Reports the "open another report" menu offers, by the menu letter command each one answers to. */
const destinations: readonly { group: string; command: CommandId; label: string; report: ReportRoute }[] = [
  { group: 'Statements', command: 'home.balance-sheet', label: 'Balance sheet', report: 'balance-sheet' },
  { group: 'Statements', command: 'home.profit-and-loss', label: 'Profit and loss', report: 'profit-and-loss' },
  { group: 'Statements', command: 'home.trial-balance', label: 'Trial balance', report: 'trial-balance' },
  { group: 'Statements', command: 'report.open.group-summary', label: 'Group summary', report: 'group-summary' },
  { group: 'Registers', command: 'home.day-book', label: 'Day book', report: 'day-book' },
  { group: 'Registers', command: 'home.ledger', label: 'Ledger', report: 'ledger' },
]

export type PeriodControl =
  | { kind: 'range'; period: ReportPeriod | null; onChange: (period: ReportPeriod) => void }
  | { kind: 'date'; date: string | null; onChange: (date: string) => void }

/**
 * The frame of every report screen: the report commands in the reports context (D-05), the panel with the company,
 * period and status, the view switches, the period dialog, the "open another report" menu, CSV export and print.
 * Escape goes back one level through `back` (nav.back). The table inside registers the movement and drill commands.
 */
export function ReportScreen({ title, search, period, detail, zeros, exportPath, back, summary, status, error, onRetry, children }: {
  title: string
  search: ReportSearch
  /** Omitted where the report has no period (the voucher view). */
  period?: PeriodControl
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
  const navigate = useNavigate()
  const [periodOpen, setPeriodOpen] = useState(false)
  const [goToOpen, setGoToOpen] = useState(false)
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
  const scopeText = period?.kind === 'range' ? (period.period ? periodText(period.period) : 'Choosing the period…')
    : period?.kind === 'date' ? (period.date ? `As at ${longDate(period.date)}` : 'Choosing the date…') : 'Read-only'

  return <ShortcutScope name={contextTitles.report}>
    <ReportCommands periodOpen={() => setPeriodOpen(true)} hasPeriod={period !== undefined} detail={detail} zeros={zeros}
      exportCsv={exportPath ? () => void exportCsv() : undefined} goTo={() => setGoToOpen(true)} />
    <Stack gap={4}>
      <ReportToolbar label={`${title} view`}
        controls={<Inline gap={4} wrap align='center'>
          {detail && <Switch label='Detailed' checked={detail.on} onCheckedChange={detail.toggle} />}
          {zeros && <Switch label='Lines without amounts' checked={zeros.shown} onCheckedChange={zeros.toggle} />}
          {period && <Button variant='secondary' size='sm' onClick={() => setPeriodOpen(true)}>Change {period.kind === 'date' ? 'date' : 'period'} <KeyHint command='report.period' /></Button>}
        </Inline>}
        summary={summary}
        actions={exportState.message ? <Text size='sm' tone={exportState.failed ? 'danger' : 'muted'} role='status'>{exportState.message}</Text> : undefined} />
      <ReportPanel title={title} scope={<Text as='span' dir='auto'>{scopeText}</Text>} source={<Text as='span' dir='auto'>{company.name} · amounts in {company.baseCurrency}</Text>}
        asOf={<Text as='span' dir='auto'>{period?.kind === 'range' && period.period ? longDate(period.period.to) : period?.kind === 'date' && period.date ? longDate(period.date) : '—'}</Text>}
        status={status} reason={status === 'error' ? error : status === 'loading' ? 'Loading…' : undefined} retainedContent
        retry={status === 'error' && onRetry ? <Button variant='secondary' size='sm' onClick={onRetry}>Try again</Button> : undefined}>
        {children}
      </ReportPanel>
    </Stack>
    {period && <PeriodDialog open={periodOpen} onOpenChange={setPeriodOpen} control={period} />}
    <Dialog open={goToOpen} onOpenChange={setGoToOpen} title='Open another report' description='The period carries over. Use the arrow keys and Enter, or press a report’s letter.'>
      {goToOpen && <KeyboardMenu label='Reports' focusRequest={0} active={destinations[0].command} onActiveChange={() => undefined}
        groups={reportMenuGroups(report => { setGoToOpen(false); void navigate({ to: reportRoutes[report], params: { companyId: company.id }, search: periodSearch(search) } as never) })} />}
    </Dialog>
  </ShortcutScope>
}

/** The reports menu (the "open another report" dialog and the Reports section), grouped. */
export function reportMenuGroups(open: (report: ReportRoute) => void): KeyboardMenuGroup[] {
  return [...new Set(destinations.map(entry => entry.group))].map(group => ({
    id: group.toLowerCase(), label: group,
    items: destinations.filter(entry => entry.group === group).map(entry => ({ command: entry.command, label: entry.label, open: () => open(entry.report) })),
  }))
}

function ReportCommands({ periodOpen, hasPeriod, detail, zeros, exportCsv, goTo }: {
  periodOpen: () => void; hasPeriod: boolean; detail?: { toggle: () => void }; zeros?: { toggle: () => void }; exportCsv?: () => void; goTo: () => void
}) {
  useAppCommand('report.period', periodOpen, { enabled: hasPeriod })
  useAppCommand('report.detail', () => detail?.toggle(), { enabled: detail !== undefined })
  useAppCommand('report.zero-lines', () => zeros?.toggle(), { enabled: zeros !== undefined })
  useAppCommand('report.export', () => exportCsv?.(), { enabled: exportCsv !== undefined })
  useAppCommand('report.print', () => window.print())
  useAppCommand('report.go-to', goTo)
  return null
}

/** The period (or the as-at date) of a report: a small form; Enter in a date field applies it. */
function PeriodDialog({ open, onOpenChange, control }: { open: boolean; onOpenChange: (open: boolean) => void; control: PeriodControl }) {
  const id = useId()
  const initial = control.kind === 'range' ? control.period : null
  const [range, setRange] = useState({ start: initial?.from ?? '', end: initial?.to ?? '' })
  const [date, setDate] = useState(control.kind === 'date' ? control.date ?? '' : '')
  const [problem, setProblem] = useState<string | null>(null)
  const [shownFor, setShownFor] = useState(false)
  if (open !== shownFor) {
    // Each time the dialog opens it starts from the report's current period.
    setShownFor(open)
    if (open) { setRange({ start: initial?.from ?? '', end: initial?.to ?? '' }); setDate(control.kind === 'date' ? control.date ?? '' : ''); setProblem(null) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange} title={control.kind === 'date' ? 'Change the date' : 'Change the period'}
    description={control.kind === 'date' ? 'The balance sheet shows balances at the end of this day.' : 'Every report you open next uses this period until you change it.'}
    onSubmit={() => {
      if (control.kind === 'date') { if (date) { control.onChange(date); onOpenChange(false) } return }
      if (problem || !range.start || !range.end) return
      control.onChange({ from: range.start, to: range.end })
      onOpenChange(false)
    }}
    footer={<Inline gap={2}><Button type='submit'>Show the report</Button><Button type='button' variant='ghost' onClick={() => onOpenChange(false)}>Cancel</Button></Inline>}>
    {control.kind === 'range'
      ? <DateRangeField label='Period' start={range.start} end={range.end} maxDays={3660} onChange={(next, issue) => { setRange(next); setProblem(issue) }} />
      : <Field label='As at' htmlFor={`${id}date`}><Input id={`${id}date`} type='date' value={date} required onChange={event => setDate(event.target.value)} /></Field>}
  </Dialog>
}
