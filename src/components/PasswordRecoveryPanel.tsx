import { PasswordRecoveryFlow } from '@ten98/ui'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'

const incompleteLink = 'This reset link is invalid or incomplete. Reopen the original email or request a new link. Reloading this page clears the link from memory.'
export type PasswordRecovery = { kind: 'request' } | { kind: 'reset'; token: string | null }
type Props = { value: PasswordRecovery; initialEmail: string; onRequest: () => void; onSignIn: (changed?: boolean) => void }

export function PasswordRecoveryPanel({ value, initialEmail, onRequest, onSignIn }: Props) {
  const [availability, setAvailability] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading')
  const [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState(''), [unconfirmed, setUnconfirmed] = useState('')
  // Non-null while a reset link is unusable; holds the explanation shown in place of the form.
  const [invalidText, setInvalidText] = useState<string | null>(value.kind === 'reset' && !value.token ? incompleteLink : null)
  const alive = useRef(false), operation = useRef<AbortController | null>(null), locked = useRef(false)
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    if (value.kind === 'request') void api<unknown>('/api/auth/password-reset-status', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) }).then(result => {
      if (!alive.current || controller.signal.aborted) return
      if (result === null || typeof result !== 'object' || Object.keys(result).length !== 1 || !('configured' in result) || typeof result.configured !== 'boolean') throw new Error('Invalid recovery status')
      setAvailability(result.configured ? 'enabled' : 'disabled')
    }).catch(() => { if (alive.current && !controller.signal.aborted) setAvailability('error') })
    return () => { alive.current = false; controller.abort(); operation.current?.abort() }
  }, [])

  async function submit(values: { email?: string; password?: string; confirmation?: string }) {
    const email = values.email ?? '', password = values.password ?? '', confirmation = values.confirmation ?? ''
    const invalid = invalidText !== null
    if (locked.current || value.kind === 'reset' && (invalid || !value.token) || value.kind === 'request' && availability !== 'enabled') return
    if (value.kind === 'reset' && (password.length < 12 || password.length > 128 || password !== confirmation)) { setError('Use 12–128 characters and enter the same password twice.'); return }
    const controller = new AbortController(); operation.current = controller; locked.current = true; setBusy(true); setError(''); setUnconfirmed('')
    try {
      const result = await api<unknown>(value.kind === 'request' ? '/api/auth/request-password-reset' : '/api/auth/reset-password', { method: 'POST', body: value.kind === 'request' ? { email: email.trim() } : { token: value.token, newPassword: password }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
      if (!alive.current || controller.signal.aborted || operation.current !== controller) return
      if (result === null || typeof result !== 'object' || Object.keys(result).length !== 1 || !('ok' in result) || result.ok !== true) throw new Error('Unverified acknowledgement')
      if (value.kind === 'request') setSent(true)
      else onSignIn(true)
    } catch (cause) {
      if (!alive.current || controller.signal.aborted || operation.current !== controller) return
      if (value.kind === 'reset' && cause instanceof ApiError && cause.status === 400) setInvalidText('This link is invalid, expired or already used. Request a new link, or reopen the original email if the address was changed.')
      else if (cause instanceof ApiError && cause.status === 429) setError('Too many attempts. Wait a minute, then try again.')
      else if (value.kind === 'request') setUnconfirmed('The request could not be confirmed. Try again later, or contact the installation operator.')
      else setUnconfirmed('The password change could not be confirmed. Try signing in with the new password, or request a new reset link. Do not assume the old password still works.')
    } finally {
      if (alive.current && operation.current === controller) { operation.current = null; locked.current = false; setBusy(false) }
    }
  }

  const request = value.kind === 'request'
  const common = {
    eyebrow: 'Your Books account', title: request ? 'Reset your password' : 'Choose a new password',
    busy, busyLabel: request ? 'Requesting link…' : 'Changing password…', error, unconfirmed,
    backToSignIn: { onClick: () => onSignIn() },
    passwordPolicy: { minLength: 12, maxLength: 128 },
    messages: {
      loading: 'Checking email recovery…',
      disabled: 'Email recovery is not configured for this installation. Contact the installation operator.',
      error: 'Email recovery availability could not be checked. Return to sign-in and try again.',
      sent: 'If a local password account matches this email, a reset link has been requested. Check your inbox and spam folder. Delivery is not confirmed here. The link expires after one hour.',
      invalid: invalidText ?? incompleteLink,
      resetIntro: 'The link works once. After a successful reset, existing sessions are signed out. Existing two-factor authentication and recovery codes are unchanged. The reset link is kept only in this open page. If you reload or close it, reopen the email.',
    },
  }
  return request
    ? <PasswordRecoveryFlow {...common} stage='request' availability={availability} sent={sent} defaultValues={{ email: initialEmail }} submitLabel='Send reset link' onSubmit={submit} />
    : <PasswordRecoveryFlow {...common} stage='reset' invalid={invalidText !== null} onRequestNewLink={onRequest} submitLabel='Change password' onSubmit={submit} />
}
