import { Card, DescriptionList, Grid, PageHeader, Stack } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { KeyboardMenu, type KeyboardMenuGroup } from '../../components/KeyboardMenu'
import { KeymapPrompt } from '../../components/KeymapChoice'
import { useApp, useCompany } from '../../lib/app-context'
import { commands, type CommandId } from '../../lib/commands'
import { baseCurrencies, financialYearOf } from '../../lib/company'

export const Route = createFileRoute('/app/c/$companyId/')({ component: CompanyHome })

const longDate = (date: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
/** Today's calendar date in the company's time zone (D-09). */
const companyToday = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/** The M1 destinations. Screens that are not built yet open their NotBuilt page. `write` entries need a role that writes. */
const destinations = [
  { group: 'Masters', command: 'home.new-master', to: '/app/c/$companyId/masters/new', write: true },
  { group: 'Masters', command: 'home.edit-master', to: '/app/c/$companyId/masters/edit', write: true },
  { group: 'Masters', command: 'home.chart-of-accounts', to: '/app/c/$companyId/masters/chart-of-accounts' },
  { group: 'Transactions', command: 'home.vouchers', to: '/app/c/$companyId/vouchers' },
  { group: 'Transactions', command: 'home.day-book', to: '/app/c/$companyId/reports/day-book' },
  { group: 'Reports', command: 'home.balance-sheet', to: '/app/c/$companyId/reports/balance-sheet' },
  { group: 'Reports', command: 'home.profit-and-loss', to: '/app/c/$companyId/reports/profit-and-loss' },
  { group: 'Reports', command: 'home.trial-balance', to: '/app/c/$companyId/reports/trial-balance' },
  { group: 'Reports', command: 'home.ledger', to: '/app/c/$companyId/reports/ledger' },
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
          { term: 'Time zone', description: company.timeZone },
        ]} />
      </Card>
    </Grid>
  </Stack>
}
