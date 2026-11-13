import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { clientLimitKey as runtimeClientLimitKey, normalizeClientAddress, resolveClientAddress } from '@ten98/runtime';
import { secret, trustedProxies } from './config.ts';

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** The transport peer of the original srvx Node request; a cloned or plain Request has none. */
function requestPeer(request: Request): string | undefined {
  const runtime = ownValue(request, 'runtime');
  if (ownValue(runtime, 'name') !== 'node') return undefined;
  const socket = ownValue(ownValue(ownValue(runtime, 'node'), 'req'), 'socket');
  if (!(socket instanceof Socket)) return undefined;
  try { return normalizeClientAddress(socket.remoteAddress) ?? undefined; } catch { return undefined; }
}

/** The connecting client for per-client rate limits, or null when unknown. Ephemeral input: never stored, logged or returned. */
export function requestClientAddress(request: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveClientAddress(requestPeer(request), request.headers.get('x-forwarded-for'), trustedProxies(env));
}

/**
 * Per-client limit key `<scope>:client:<hmac>`, from the runtime's clientLimitKey: the address is stored only as a keyed
 * hash, IPv6 clients share one key per /56 and every unresolved client shares `<scope>:client:unresolved`.
 */
export function clientLimitKey(scope: string, address: string | null, key: string): string {
  return `${scope}:${runtimeClientLimitKey('client', address, key)}`;
}

/** The request's per-client limit key and whether its client address resolved. */
export function clientRateIdentity(request: Request, scope: string, env: NodeJS.ProcessEnv = process.env): { key: string; resolved: boolean } {
  const address = requestClientAddress(request, env);
  return { key: clientLimitKey(scope, address, secret('AUTH_SECRET', env)), resolved: address !== null };
}

export function clientRateKey(request: Request, scope: string, env: NodeJS.ProcessEnv = process.env): string {
  return clientRateIdentity(request, scope, env).key;
}

/**
 * Per-client ceilings for identity routes: per minute, except setup's 15-minute window. Every unresolved client of a scope shares
 * one key, so it gets a quarter of the resolved ceiling (at least 1). Setup still admits unresolved clients, so a misconfigured
 * proxy cannot lock the owner out of the first-boot claim.
 */
export const clientRateLimits = {
  signin: { resolved: 60, unresolved: 15 },
  'two-factor': { resolved: 60, unresolved: 15 },
  setup: { resolved: 10, unresolved: 2 },
} as const;

export function clientRateLimit(request: Request, scope: keyof typeof clientRateLimits, env: NodeJS.ProcessEnv = process.env): { key: string; maximum: number } {
  const { key, resolved } = clientRateIdentity(request, scope, env);
  return { key, maximum: clientRateLimits[scope][resolved ? 'resolved' : 'unresolved'] };
}

/** Per-address limit keys; unkeyed digests anyone holding the address can derive. */
export function emailLimitKey(scope: 'signin' | 'password-recovery:email' | 'invitation-email', email: string): string {
  return `${scope}:${createHash('sha256').update(email).digest('hex')}`;
}
