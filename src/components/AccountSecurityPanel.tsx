import { Alert, Button, PasswordChangeFlow, SessionListFlow, Stack, StatusLine, TwoFactorSetupFlow } from '@ten98/ui'
import type { PasswordChangeValues, TwoFactorSetupStage } from '@ten98/ui'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError, errMsg } from '../lib/api'
import { useAccountPresentation } from '../lib/account-presentation'
import { accountLocaleMapping, accountPreferencesDefaults } from '../lib/account-preferences'

type SessionInfo = { id: string; createdAt: string; expiresAt: string; userAgent: string | null; current: boolean }
type SecurityData = { user: { id: string; name: string; email: string; twoFactorEnabled: boolean }; sessions: SessionInfo[]; hasPassword: boolean }
type Op = 'password' | 'factor' | 'sessions'

const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError'
/** The base32 secret inside an otpauth URI, shown as the manual setup key. */
const setupKey = (uri: string): string => { try { return new URL(uri).searchParams.get('secret') ?? '' } catch { return '' } }

/**
 * Request adapter around the shared password, two-factor and session flows. Secrets (setup URI, recovery codes) stay
 * in memory only and are dropped on any failure, reload or sign-out; the server contract is account-security.ts.
 */
export function AccountSecurityPanel({ expectedUserId, onUnauthorized }: { expectedUserId: string; onUnauthorized: () => void }) {
  const presentation = useAccountPresentation(), preferences = presentation?.data?.user.id === expectedUserId ? presentation.data.preferences : accountPreferencesDefaults
  const formatDate = (value: string | Date) => { const date = new Date(value); if (Number.isNaN(date.getTime())) return String(value); try { return new Intl.DateTimeFormat(accountLocaleMapping(preferences.locale).formatLocale, { timeZone: preferences.timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(date) } catch { return String(value) } }
  const [data, setData] = useState<SecurityData | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState<Op | null>(null)
  const [errs, setErrs] = useState<Partial<Record<Op, string>>>({})
  const [passwordNotice, setPasswordNotice] = useState('')
  const [passwordForm, setPasswordForm] = useState(0)
  const [enrolment, setEnrolment] = useState<{ uri: string; codes: string[] } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const mounted = useRef(true), lock = useRef(false), unauthorized = useRef(onUnauthorized)
  useEffect(() => { unauthorized.current = onUnauthorized }, [onUnauthorized])

  const clearSecrets = () => { setEnrolment(null); setCodes(null) }
  const lost = (e: unknown): boolean => {
    if (e instanceof ApiError && e.status === 401) { clearSecrets(); setData(null); unauthorized.current(); return true }
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) { clearSecrets(); setData(null); setLoadErr('Your access to this page changed. Reload your security settings to continue.'); return true }
    return false
  }

  async function load() {
    setLoadErr('')
    try {
      const d = await api<SecurityData>('/api/account/security')
      if (!mounted.current) return
      if (d.user.id !== expectedUserId) { clearSecrets(); setData(null); unauthorized.current(); return }
      setData(d)
    } catch (e) { if (mounted.current && !isAbort(e) && !lost(e)) setLoadErr(errMsg(e)) }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false } }, [])

  /** One mutation at a time; a definite failure is shown on its flow, and every success re-reads the account. */
  async function mutate<T>(op: Op, path: string, body: unknown, commit?: (value: T) => void): Promise<void> {
    if (lock.current || !data) return
    lock.current = true; setBusy(op); setErrs(previous => ({ ...previous, [op]: '' }))
    try {
      const value = await api<T>(path, { method: 'POST', body })
      if (!mounted.current) return
      commit?.(value)
      await load()
    } catch (e) { if (mounted.current && !lost(e)) setErrs(previous => ({ ...previous, [op]: errMsg(e) })) }
    finally { lock.current = false; if (mounted.current) setBusy(null) }
  }

  if (data === null) return loadErr
    ? <Alert tone='danger' actions={<Button variant='secondary' onClick={() => void load()}>Reload security settings</Button>}>{loadErr}</Alert>
    : <StatusLine busy>Loading your security settings…</StatusLine>

  const stage: TwoFactorSetupStage = codes ? 'codes' : enrolment ? 'enrolling' : data.user.twoFactorEnabled ? 'on' : 'off'
  return <Stack gap={6}>
    {loadErr && <Alert tone='danger'>{loadErr}</Alert>}
    <PasswordChangeFlow key={passwordForm} title='Password' hasPassword={data.hasPassword} policy={{ minLength: 12, maxLength: 128 }}
      busy={busy === 'password'} error={errs.password || undefined} notice={passwordNotice ? { tone: 'success', text: passwordNotice } : undefined}
      onSubmit={({ currentPassword, newPassword }: PasswordChangeValues) => mutate('password', '/api/account/password', { currentPassword, newPassword },
        () => { setPasswordForm(value => value + 1); setPasswordNotice('Password changed. Your other sessions were signed out.') })} />
    <TwoFactorSetupFlow title='Two-factor authentication' stage={stage} codeLength={6} disableRequiresCode downloadName='books-recovery-codes.txt'
      enrolment={enrolment ? { manualKey: setupKey(enrolment.uri), uri: enrolment.uri } : undefined} recoveryCodes={codes ?? undefined}
      busy={busy === 'factor'} error={errs.factor || undefined}
      onStart={({ password }) => mutate<{ totpURI: string; backupCodes: string[] }>('factor', '/api/account/two-factor/enable', { password }, value => setEnrolment({ uri: value.totpURI, codes: value.backupCodes }))}
      // Recovery codes issued at enrolment are shown once, after the first code proves the authenticator works.
      onVerify={({ code }) => mutate('factor', '/api/account/two-factor/verify', { code }, () => { setCodes(enrolment?.codes ?? null); setEnrolment(null) })}
      onAcknowledgeCodes={() => setCodes(null)}
      onRegenerate={({ password }) => mutate<{ backupCodes: string[] }>('factor', '/api/account/two-factor/recovery-codes', { password }, value => setCodes(value.backupCodes))}
      onDisable={({ password, code = '' }) => mutate('factor', '/api/account/two-factor/disable', { password, ...(/^\d{6}$/.test(code.trim()) ? { code: code.trim() } : { backupCode: code.trim() }) }, clearSecrets)} />
    <SessionListFlow title='Signed-in sessions' formatDate={formatDate} busy={busy === 'sessions'} error={errs.sessions || undefined}
      sessions={data.sessions.map(session => ({ id: session.id, device: session.userAgent ?? 'Unknown device', lastActiveAt: session.createdAt, current: session.current }))}
      onRevoke={({ id }) => mutate('sessions', '/api/account/sessions/revoke', { sessionId: id })}
      onRevokeOthers={() => mutate('sessions', '/api/account/sessions/revoke-others', {})} />
  </Stack>
}
