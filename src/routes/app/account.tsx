import { Stack } from '@ten98/ui'
import { createFileRoute } from '@tanstack/react-router'
import { AccountPreferencesPanel } from '../../components/AccountPreferencesPanel'
import { AccountSecurityPanel } from '../../components/AccountSecurityPanel'
import { KeymapSettings } from '../../components/KeymapChoice'
import { useApp } from '../../lib/app-context'

export const Route = createFileRoute('/app/account')({ component: Account })

function Account() {
  const { me, unauthorized } = useApp()
  return <Stack gap={8}>
    <AccountPreferencesPanel key={me.user.id} expectedUserId={me.user.id} onUnauthorized={unauthorized} />
    <KeymapSettings />
    <AccountSecurityPanel key={`security:${me.user.id}`} expectedUserId={me.user.id} onUnauthorized={unauthorized} />
  </Stack>
}
