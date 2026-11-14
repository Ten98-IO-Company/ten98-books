import { AppStateScreen, FirstUserSetupFlow, SignInFlow, TwoFactorChallengeFlow } from '@ten98/ui'
import type { FirstUserSetupValues, SignInValues, TwoFactorMode, TwoFactorValues } from '@ten98/ui'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { InvitePanel } from '../components/InvitePanel'
import { PasswordRecoveryPanel, type PasswordRecovery } from '../components/PasswordRecoveryPanel'
import { api, ApiError, errMsg } from '../lib/api'
import { authNoticeTone, readAuthFragment, type AuthFragment, type AuthNotice } from '../lib/auth-messages'

/** Signed-out entry: first-user setup, sign-in, two-factor, password recovery and invitations. A session opens /app. */
export const Route = createFileRoute('/')({ component: Entry })

type Session = { setupRequired: boolean; user: { id: string; email: string } | null }
type Phase = 'loading' | 'error' | 'setup' | 'signin' | 'factor' | 'recovery' | 'invite'

function Entry() {
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>('loading')
  const [pageError, setPageError] = useState('')
  const [email, setEmail] = useState('')
  const [notice, setNotice] = useState<AuthNotice | null>(null)
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null)
  const [recovery, setRecovery] = useState<{ value: PasswordRecovery; generation: number } | null>(null)
  // Fragment capabilities live only in memory; the URL is scrubbed before any API call.
  const fragment = useRef<AuthFragment | null>(null)
  const generation = useRef(0)

  async function boot() {
    const current = ++generation.current
    try {
      const session = await api<Session>('/api/session')
      if (current !== generation.current) return
      const capability = fragment.current
      if (capability?.kind === 'reset') { setRecovery({ value: { kind: 'reset', token: capability.token }, generation: current }); setPhase('recovery'); return }
      if (session.setupRequired) { setPhase('setup'); return }
      if (capability?.kind === 'invite') { setSignedInEmail(session.user?.email ?? null); setPhase('invite'); return }
      if (session.user) { void navigate({ to: '/app' }); return }
      setPhase('signin')
    } catch (error) {
      if (current !== generation.current) return
      setPageError(errMsg(error)); setPhase('error')
    }
  }

  useEffect(() => {
    fragment.current = readAuthFragment(window.location.hash)
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    void boot()
    return () => { generation.current++ }
  }, [])

  function beginRecovery(value: PasswordRecovery, initialEmail = email) {
    generation.current++
    setEmail(initialEmail); setNotice(null)
    setRecovery({ value, generation: generation.current }); setPhase('recovery')
  }

  async function signedIn() {
    setPhase('loading')
    await boot()
  }

  if (phase === 'loading') return <AppStateScreen state='loading' message='Loading…' />
  if (phase === 'error') return <AppStateScreen state='error' title='Unable to load account access' message={pageError} onRetry={() => { setPhase('loading'); void boot() }} />
  if (phase === 'setup') return <OwnerForm onSetup={async values => { await api('/api/auth/setup', { method: 'POST', body: values }); await signedIn() }}
    onSignInInstead={value => { setEmail(value); setPhase('signin') }} />
  if (phase === 'recovery' && recovery) return <PasswordRecoveryPanel key={recovery.generation} value={recovery.value} initialEmail={email}
    onRequest={() => beginRecovery({ kind: 'request' })}
    onSignIn={changed => { fragment.current = null; setRecovery(null); setPhase('signin'); setNotice(changed ? { kind: 'info', message: 'Password changed. Sign in with your new password. Two-factor authentication is still required if enabled.' } : null) }} />
  if (phase === 'invite' && fragment.current?.kind === 'invite') return <InvitePanel token={fragment.current.token} signedInEmail={signedInEmail}
    onAccepted={async (acceptedEmail, _created, workspaceId) => {
      fragment.current = null
      try { await api('/api/me'); void navigate({ to: '/app/c/$companyId', params: { companyId: workspaceId } }) }
      catch (error) { if (error instanceof ApiError && error.status === 401) { setEmail(acceptedEmail); setPhase('signin') } else { setPageError(errMsg(error)); setPhase('error') } }
    }}
    onSignIn={async invitedEmail => {
      // Sign in as the invited account; the invitation reopens after sign-in.
      if (signedInEmail) await api('/api/auth/sign-out', { method: 'POST', body: {} }).catch(() => undefined)
      setSignedInEmail(null); setEmail(invitedEmail); setPhase('signin')
    }}
    onCancel={() => { fragment.current = null; void boot() }}
    onUnauthorized={() => { setSignedInEmail(null); setPhase('signin') }} />
  if (phase === 'factor') return <FactorForm onSubmit={async (code, recoveryCode) => {
    await api(`/api/auth/two-factor/${recoveryCode ? 'verify-backup-code' : 'verify-totp'}`, { method: 'POST', body: { code } })
    await signedIn()
  }} onCancel={() => setPhase('signin')} />
  const inviting = fragment.current?.kind === 'invite'
  return <SignInForm initialEmail={email} notice={notice}
    {...(inviting ? { title: 'Sign in to join', description: `Sign in as ${email || 'the invited account'} to accept your company invitation.` } : {})}
    onForgot={value => beginRecovery({ kind: 'request' }, value)}
    onCancel={inviting ? () => setPhase('invite') : undefined}
    onSignIn={async (value, password) => {
      setNotice(null)
      const response = await api<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', { method: 'POST', body: { email: value, password } })
      setEmail(value)
      if (response.twoFactorRedirect) { setPhase('factor'); return }
      await signedIn()
    }} />
}

// A status-0 ApiError means the request may or may not have completed; every other failure is a definite error.
type AuthOutcome = { error: string; unconfirmed: string }
const noOutcome: AuthOutcome = { error: '', unconfirmed: '' }
function failureOutcome(e: unknown): AuthOutcome {
  const message = errMsg(e)
  return e instanceof ApiError && e.status === 0 ? { error: '', unconfirmed: message } : { error: message, unconfirmed: '' }
}

type SetupValues = { name: string; email: string; password: string; workspaceName: string }

function OwnerForm({ onSetup, onSignInInstead }: { onSetup: (v: SetupValues) => Promise<void>; onSignInInstead: (email: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(noOutcome)
  const [ownerExists, setOwnerExists] = useState(false)
  // Remounting after success clears the password; the other entries are kept.
  const [form, setForm] = useState({ generation: 0, name: '', email: '' })

  async function submit(v: FirstUserSetupValues) {
    // The company (workspace) gets a placeholder name here; the next step asks for its real name and books settings.
    const values = { name: v.name.trim(), email: v.email.trim(), password: v.password, workspaceName: 'My company' }
    setBusy(true); setOutcome(noOutcome); setOwnerExists(false)
    setForm(f => ({ ...f, name: values.name, email: values.email }))
    try {
      await onSetup(values)
      setForm(f => ({ ...f, generation: f.generation + 1 }))
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setOwnerExists(true)
      setOutcome(failureOutcome(err))
    } finally { setBusy(false) }
  }

  return <FirstUserSetupFlow key={form.generation} title='Create owner account'
    description='The first account becomes the owner of this installation and of its first company. You enter the company details next.'
    setupToken={false} workspaceName={false} passwordPolicy={{ minLength: 12, maxLength: 128 }}
    defaultValues={{ name: form.name, email: form.email }}
    busy={busy} error={outcome.error || undefined} unconfirmed={outcome.unconfirmed || undefined}
    signInInstead={ownerExists ? { onClick: email => onSignInInstead(email.trim()) } : undefined} onSubmit={submit} />
}

function SignInForm({ initialEmail, onSignIn, onForgot, onCancel, notice, title = 'Sign in', description }: { initialEmail: string; onSignIn: (email: string, password: string) => Promise<void>; onForgot: (email: string) => void; onCancel?: () => void; notice: AuthNotice | null; title?: string; description?: string }) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(noOutcome)

  async function submit(v: SignInValues) {
    setBusy(true); setOutcome(noOutcome)
    try { await onSignIn(v.email.trim(), v.password) }
    catch (err) { setOutcome(failureOutcome(err)) }
    finally { setBusy(false) }
  }

  return <SignInFlow title={title} description={description} defaultValues={{ email: initialEmail }}
    busy={busy} error={outcome.error || undefined} unconfirmed={outcome.unconfirmed || undefined}
    notice={notice ? { tone: authNoticeTone(notice.kind), text: notice.message } : undefined}
    forgotPassword={{ onClick: email => onForgot(email.trim()) }} cancel={onCancel ? { label: 'Back to invitation', onClick: onCancel } : undefined}
    onSubmit={submit} />
}

function FactorForm({ onSubmit, onCancel }: { onSubmit: (code: string, recovery: boolean) => Promise<void>; onCancel: () => void }) {
  const [mode, setMode] = useState<TwoFactorMode>('authenticator')
  const [outcome, setOutcome] = useState(noOutcome)
  const [busy, setBusy] = useState(false)
  async function submit(v: TwoFactorValues) {
    setBusy(true); setOutcome(noOutcome)
    try { await onSubmit(v.code.trim(), v.mode === 'recovery') }
    catch (e) { setOutcome(failureOutcome(e)) }
    finally { setBusy(false) }
  }
  return <TwoFactorChallengeFlow title='Verify your sign-in' mode={mode}
    onModeChange={next => { setMode(next); setOutcome(noOutcome) }} busy={busy} error={outcome.error || undefined} unconfirmed={outcome.unconfirmed || undefined}
    messages={{ authenticatorLabel: 'Authenticator code', authenticatorDescription: 'Enter the six-digit code from your authenticator app.', recoveryDescription: 'Enter one unused recovery code. Each code can only be used once.', useAuthenticator: 'Use authenticator' }}
    cancel={{ label: 'Back to sign in', onClick: onCancel }} onSubmit={submit} />
}
