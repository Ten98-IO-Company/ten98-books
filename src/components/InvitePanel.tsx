import { InvitationAcceptFlow } from '@ten98/ui';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errMsg } from '../lib/api';

type InspectInfo = { workspaceName: string; email: string; role: string; expiresAt: string; accountExists: boolean };
type AcceptResult = { workspaceId: string; created: boolean; email: string };

function is401(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function formatDate(value: string | Date): string {
  const iso = String(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

type InvitePanelProps = {
  token: string;
  signedInEmail: string | null;
  onAccepted: (email: string, created: boolean, workspaceId: string) => Promise<void>;
  /** Receives the invited email so sign-in can start with it. */
  onSignIn: (email: string) => void;
  onCancel: () => void;
  onUnauthorized: () => void;
};

export function InvitePanel(props: InvitePanelProps) {
  return <InvitePanelContent key={`${props.token}:${props.signedInEmail ?? ''}`} {...props} />;
}

function InvitePanelContent(props: InvitePanelProps) {
  const { token, signedInEmail, onSignIn, onCancel } = props;
  const [info, setInfo] = useState<InspectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);

  const reqRef = useRef(0);
  const acRef = useRef<AbortController | null>(null);
  const unauthRef = useRef(props.onUnauthorized);
  useEffect(() => {
    unauthRef.current = props.onUnauthorized;
  });
  // Abort an in-flight accept submission on unmount.
  useEffect(() => () => acRef.current?.abort(), []);

  // Inspect the invitation; aborted and superseded on token change. The token is
  // only ever sent in a POST body — never stored, logged, or put in a URL.
  useEffect(() => {
    const id = ++reqRef.current;
    const ac = new AbortController();
    setInfo(null);
    setError(null);
    setNeedsSignIn(false);
    setLoading(true);
    api<InspectInfo>('/api/invitations/inspect', { method: 'POST', body: { token }, signal: ac.signal })
      .then(d => {
        if (id !== reqRef.current || ac.signal.aborted) return;
        setInfo(d);
        setLoading(false);
      })
      .catch(e => {
        if (id !== reqRef.current || ac.signal.aborted) return;
        setLoading(false);
        if (is401(e)) {
          unauthRef.current();
          return;
        }
        setError(errMsg(e));
      });
    return () => ac.abort();
  }, [token, reload]);

  const matched = !!info && !!signedInEmail && signedInEmail.toLowerCase() === info.email.toLowerCase();
  const mismatch = !!info && !!signedInEmail && !matched;

  function submitAccept(values: { name?: string; password?: string }) {
    const password = values.password ?? '';
    if (busy || acRef.current || !info || mismatch || needsSignIn) return;
    const trimmedName = (values.name ?? '').trim();
    if (!signedInEmail) {
      if (trimmedName.length < 1 || trimmedName.length > 120) {
        setError('Enter your name (1–120 characters).');
        return;
      }
      if (password.length < 12 || password.length > 128) {
        setError('Choose a password between 12 and 128 characters.');
        return;
      }
    }
    const ac = new AbortController();
    acRef.current = ac;
    setBusy(true);
    setError(null);
    const body = signedInEmail ? { token } : { token, name: trimmedName, password };
    api<AcceptResult>('/api/invitations/accept', { method: 'POST', body, signal: ac.signal })
      .then(res => {
        if (ac.signal.aborted) return;
        return props.onAccepted(res.email, res.created, res.workspaceId);
      })
      .catch(err => {
        if (ac.signal.aborted) return;
        if (is401(err)) {
          unauthRef.current();
          return;
        }
        if (err instanceof ApiError && err.status === 409) setNeedsSignIn(true);
        setError(`Could not accept the invitation: ${errMsg(err)}`);
      })
      .finally(() => {
        if (acRef.current === ac) {
          acRef.current = null;
          if (!ac.signal.aborted) setBusy(false);
        }
      });
  }

  const frame = {
    busy,
    cancel: { label: 'Cancel', onClick: () => onCancel() },
    passwordPolicy: { minLength: 12, maxLength: 128 },
    formatDate,
  };

  if (loading) {
    return <InvitationAcceptFlow {...frame} state='loading' title='Checking your invitation' messages={{ loading: 'Checking your invitation…' }} />;
  }

  if (!info) {
    return (
      <InvitationAcceptFlow
        {...frame}
        state='unavailable'
        eyebrow='COMPANY INVITATION'
        title='This invitation link does not work'
        description='The link may have expired or already been used. Ask the person who invited you for a new one.'
        error={error ?? undefined}
        onRetry={() => setReload(k => k + 1)}
      />
    );
  }

  return (
    <InvitationAcceptFlow
      {...frame}
      state={mismatch ? 'mismatch' : needsSignIn ? 'signin-required' : 'details'}
      eyebrow='COMPANY INVITATION'
      title={`You’re invited to join ${info.workspaceName}`}
      messages={{ workspaceTerm: 'Company' }}
      invitation={info}
      signedInEmail={signedInEmail ?? undefined}
      accountExists={info.accountExists === true}
      error={error ?? undefined}
      onSignIn={() => onSignIn(info.email)}
      onSwitchAccount={() => onSignIn(info.email)}
      onSubmit={submitAccept}
    />
  );
}
