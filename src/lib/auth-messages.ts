export type AuthNoticeKind = 'info' | 'warning' | 'error'
export interface AuthNotice { kind: AuthNoticeKind; message: string }
export const authNoticeTone = (kind: AuthNoticeKind): 'info' | 'warning' | 'danger' => kind === 'error' ? 'danger' : kind

/** A capability carried in the URL fragment: an invitation or a password reset. Read once, then scrubbed from the URL. */
export type AuthFragment = { kind: 'invite'; token: string } | { kind: 'reset'; token: string | null }

/** Invitation tokens are 43 base64url characters and reset tokens 24 letters or digits; anything else is no capability. */
export function readAuthFragment(hash: string): AuthFragment | null {
  if (!hash || hash.length > 4096) return null
  const reset = /^#password-reset=(.*)$/.exec(hash)
  if (reset) return { kind: 'reset', token: /^[A-Za-z0-9]{24}$/.test(reset[1]) ? reset[1] : null }
  const invite = /^#invite=([A-Za-z0-9_-]{43})$/.exec(hash)
  return invite ? { kind: 'invite', token: invite[1] } : null
}
