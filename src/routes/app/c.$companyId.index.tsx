import { Card, DescriptionList, PageHeader, Stack } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useCompany } from '../../lib/app-context'
import { baseCurrencies, financialYearOf } from '../../lib/company'

export const Route = createFileRoute('/app/c/$companyId/')({ component: CompanyHome })

const longDate = (date: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
/** Today's calendar date in the company's time zone (D-09). */
const companyToday = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

function CompanyHome() {
  const company = useCompany()
  const year = financialYearOf(company.financialYearStart, companyToday(company.timeZone))
  return <Stack gap={6}>
    <PageHeader eyebrow='Home' title={company.name} description={company.secondLanguageName ?? undefined} />
    <Card title='Books'>
      <DescriptionList columns={2} items={[
        { term: 'Base currency', description: `${company.baseCurrency} · ${baseCurrencies[company.baseCurrency]?.name ?? ''} (${company.currencyMinorUnits} decimal places)` },
        { term: 'Current financial year', description: `${longDate(year.from)} to ${longDate(year.to)}` },
        { term: 'Books begin on', description: longDate(company.booksBeginning) },
        { term: 'Time zone', description: company.timeZone },
      ]} />
    </Card>
  </Stack>
}
