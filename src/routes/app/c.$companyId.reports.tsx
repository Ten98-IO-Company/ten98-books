import { Card, PageHeader, Stack } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { KeyboardMenu } from '../../components/KeyboardMenu'
import { reportRoutes } from '../../components/reports/navigation'
import { reportMenuGroups } from '../../components/reports/ReportScreen'
import { useCompany } from '../../lib/app-context'
import type { CommandId } from '../../lib/commands'

/** The Reports section: every M1 report in one menu, by arrow keys and Enter or by its letter. */
export const Route = createFileRoute('/app/c/$companyId/reports')({ component: ReportsHome })

function ReportsHome() {
  const company = useCompany()
  const navigate = useNavigate()
  const [active, setActive] = useState<CommandId>('home.balance-sheet')
  const groups = reportMenuGroups(report => void navigate({ to: reportRoutes[report], params: { companyId: company.id } } as never))
  return <Stack gap={6}>
    <PageHeader eyebrow={company.name} title='Reports' description='Statements open on the financial year to the last voucher date; the day book on that date.' />
    <Card title='Reports menu' description='Use the arrow keys and Enter, or press a report’s letter.'>
      <KeyboardMenu label='Reports' groups={groups} active={active} onActiveChange={setActive} focusRequest={0} />
    </Card>
  </Stack>
}
