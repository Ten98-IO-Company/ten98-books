import { Button, Card, DescriptionList, Dialog, Field, Grid, Input, PageHeader, Stack } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { KeyboardMenu, type KeyboardMenuGroup } from '../../components/KeyboardMenu'
import { KeymapPrompt } from '../../components/KeymapChoice'
import { DialogKeys, useAppCommand } from '../../components/KeyboardShell'
import { loadDefaults } from '../../components/reports/navigation'
import { useApp, useCompany } from '../../lib/app-context'
import { commands, type CommandId } from '../../lib/commands'
import { baseCurrencies, financialYearOf } from '../../lib/company'
import { longDate } from '../../lib/reports'
import { entryDateLabel, entryDateText, parseEntryDate } from '../../lib/voucher-entry'
import { readWorkingDate, sessionStore, startingWorkingDate, writeWorkingDate } from '../../lib/working-date'

export const Route = createFileRoute('/app/c/$companyId/')({ component: CompanyHome })

/** Today's calendar date in the company's time zone (D-09). */
const companyToday = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/** The M1 destinations. Screens that are not built yet open their NotBuilt page. `write` entries need a role that writes. */
const destinations = [
  { group: 'Masters', command: 'home.new-master', to: '/app/c/$companyId/masters/new', write: true },
  { group: 'Masters', command: 'home.edit-master', to: '/app/c/$companyId/masters/edit', write: true },
  { group: 'Masters', command: 'home.chart-of-accounts', to: '/app/c/$companyId/masters/chart-of-accounts' },
  { group: 'Masters', command: 'home.cost-centres', to: '/app/c/$companyId/masters/cost-centres' },
  { group: 'Transactions', command: 'home.vouchers', to: '/app/c/$companyId/vouchers', write: true },
  { group: 'Transactions', command: 'home.day-book', to: '/app/c/$companyId/reports/day-book' },
  { group: 'Reports', command: 'home.balance-sheet', to: '/app/c/$companyId/reports/balance-sheet' },
  { group: 'Reports', command: 'home.profit-and-loss', to: '/app/c/$companyId/reports/profit-and-loss' },
  { group: 'Reports', command: 'home.trial-balance', to: '/app/c/$companyId/reports/trial-balance' },
  { group: 'Reports', command: 'home.ledger', to: '/app/c/$companyId/reports/ledger' },
  { group: 'Reports', command: 'report.open.cost-category-summary', to: '/app/c/$companyId/reports/cost-category-summary' },
  { group: 'Reports', command: 'report.open.cost-centre-breakup', to: '/app/c/$companyId/reports/cost-centre-breakup' },
] as const satisfies readonly { group: string; command: CommandId; to: string; write?: true }[]

/** The item last opened per company in this tab, so going back highlights it again. */
const lastOpened = new Map<string, CommandId>()

function CompanyHome() {
  const company = useCompany()
  const { companies } = useApp()
  const navigate = useNavigate()
  // A viewer sees only what a viewer can do; a hidden entry registers no key, so its letter does nothing.
  const role = companies?.find(item => item.id === company.id)?.role
  const writer = role === 'owner' || role === 'admin' || role === 'editor'
  const offered = destinations.filter(entry => writer || !('write' in entry))
  const [active, setActive] = useState<CommandId>(() => lastOpened.get(company.id) ?? offered[0].command)
  const [focusRequest, setFocusRequest] = useState(0)
  const year = financialYearOf(company.financialYearStart, companyToday(company.timeZone))
  const working = useWorkingDate(company.id)
  const [dateOpen, setDateOpen] = useState(false)
  useAppCommand('app.working-date', () => setDateOpen(true), { enabled: working !== null })

  const groups: KeyboardMenuGroup[] = [...new Set(offered.map(entry => entry.group))].map(group => ({
    id: group.toLowerCase(), label: group,
    items: offered.filter(entry => entry.group === group).map(entry => ({
      command: entry.command, label: commands[entry.command].title,
      open: () => { lastOpened.set(company.id, entry.command); void navigate({ to: entry.to, params: { companyId: company.id } }) },
    })),
  }))

  return <Stack gap={6}>
    <PageHeader eyebrow='Home' title={company.name} description={company.secondLanguageName ?? undefined} />
    <KeymapPrompt onChosen={() => setFocusRequest(value => value + 1)} />
    <Grid columns={2} gap={6} align='start'>
      <Card title='Company menu' description='Use the arrow keys and Enter, or press an item’s letter.'>
        <KeyboardMenu label='Company menu' groups={groups} active={active} onActiveChange={setActive} focusRequest={focusRequest} />
      </Card>
      <Card title='Books'>
        <DescriptionList items={[
          { term: 'Base currency', description: `${company.baseCurrency} · ${baseCurrencies[company.baseCurrency]?.name ?? ''} (${company.currencyMinorUnits} decimal places)` },
          { term: 'Current financial year', description: `${longDate(year.from)} to ${longDate(year.to)}` },
          { term: 'Books begin on', description: longDate(company.booksBeginning) },
          { term: 'Working date', description: working ? `${entryDateLabel(working)}: new vouchers in this tab open on it` : 'Loading…' },
          { term: 'Time zone', description: company.timeZone },
        ]} />
      </Card>
    </Grid>
    {working && <WorkingDateDialog open={dateOpen} current={working} booksBeginning={company.booksBeginning} onClose={() => { setDateOpen(false); setFocusRequest(value => value + 1) }}
      onChange={date => setWorking(company.id, date)} />}
  </Stack>
}

const workingListeners = new Set<() => void>()
const setWorking = (companyId: string, date: string) => { writeWorkingDate(sessionStore, companyId, date); for (const listener of workingListeners) listener() }

/** The tab's working date (src/lib/working-date.ts): the kept one, else the last voucher date from the report defaults. */
function useWorkingDate(companyId: string): string | null {
  const [date, setDate] = useState(() => readWorkingDate(sessionStore, companyId))
  useEffect(() => {
    let live = true
    const listener = () => setDate(readWorkingDate(sessionStore, companyId))
    workingListeners.add(listener)
    if (readWorkingDate(sessionStore, companyId) === null) loadDefaults(companyId).then(found => { if (live) setDate(startingWorkingDate(found)) }).catch(() => undefined)
    return () => { live = false; workingListeners.delete(listener) }
  }, [companyId])
  return date
}

/**
 * The working date key (F2 on the company menu): any date from the books beginning, typed in the voucher date's forms.
 * It moves this tab's new vouchers, and the end of their financial year, which is how a tab enters the next year.
 */
function WorkingDateDialog({ open, current, booksBeginning, onChange, onClose }: { open: boolean; current: string; booksBeginning: string; onChange: (date: string) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  useEffect(() => { if (open) { setText(entryDateText(current)); setError(undefined) } }, [open, current])
  const apply = () => {
    const parsed = parseEntryDate(text, current)
    if ('error' in parsed) { setError(parsed.error); return }
    if (parsed.value < booksBeginning) { setError(`Date cannot be before the books begin, ${entryDateText(booksBeginning)}.`); return }
    onChange(parsed.value)
    onClose()
  }
  return <DialogKeys name='Working date' open={open} onAccept={apply}>
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title='Set the working date' description='New vouchers in this tab open on this date. Day first: 9, 10-8, 12 sep or 15-10-2026.'
      initialFocus='first-field' onSubmit={() => apply()} footer={<Button type='submit'>Set the date</Button>}>
      <Field label='Working date' error={error}><Input value={text} onChange={event => { setText(event.target.value); setError(undefined) }} dir='ltr' autoComplete='off' /></Field>
    </Dialog>
  </DialogKeys>
}
