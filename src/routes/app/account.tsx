import { Stack } from '@ten98/ui'
import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { useCallback } from 'react'
import { AccountPreferencesPanel } from '../../components/AccountPreferencesPanel'
import { AccountSecurityPanel } from '../../components/AccountSecurityPanel'
import { KeymapSettings } from '../../components/KeymapChoice'
import { useApp } from '../../lib/app-context'

export const Route = createFileRoute('/app/account')({ component: Account })

function Account() {
  const { me, unauthorized } = useApp()
  // Reached with #security (Escape from a company locked by the two-factor rule): that section takes focus.
  const security = useRouterState({ select: state => state.location.hash === 'security' })
  const focusSecurity = useCallback((section: HTMLElement | null) => { if (security) section?.focus() }, [security])
  return <Stack gap={8}>
    <AccountPreferencesPanel key={me.user.id} expectedUserId={me.user.id} onUnauthorized={unauthorized} />
    <KeymapSettings />
    <Stack id='security' ref={focusSecurity} tabIndex={-1} aria-label='Account security'>
      <AccountSecurityPanel key={`security:${me.user.id}`} expectedUserId={me.user.id} onUnauthorized={unauthorized} />
    </Stack>
  </Stack>
}
