import { readFileSync } from 'node:fs';
import { appOrigin, parseTrustedProxies, type TrustedProxies } from '@ten98/runtime';

export function environmentValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Set only ${name} or ${name}_FILE`);
  return env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, 'utf8').trim() : env[name];
}

export function secret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = environmentValue(name, env);
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

// TRUSTED_PROXIES changes only at restart (or in tests that set process.env), so one parsed copy is kept per value.
let parsedProxies: { raw: unknown; list: TrustedProxies } | null = null;

/** Reverse proxies whose X-Forwarded-For is honoured for per-client rate limits. Empty: the transport peer is the client. */
export function trustedProxies(env: NodeJS.ProcessEnv = process.env): TrustedProxies {
  const raw = env.TRUSTED_PROXIES;
  if (!parsedProxies || parsedProxies.raw !== raw) parsedProxies = { raw, list: parseTrustedProxies(raw) };
  return parsedProxies.list;
}

function appUrlOrigin(raw: string): string {
  try {
    return appOrigin(raw);
  } catch (error) {
    if ((error as { code?: string })?.code !== 'APP_URL_INVALID') throw error;
    const plainHttp = /outside localhost/.test((error as Error).message);
    throw new Error(plainHttp ? 'Non-local APP_URL requires HTTPS' : 'APP_URL must be an HTTP(S) origin', { cause: error });
  }
}

function postgresUrl(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = environmentValue(name, env);
  if (value !== undefined && !['postgres:', 'postgresql:'].includes(new URL(value).protocol)) throw new Error(`${name} must be a PostgreSQL URL`);
  return value;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env) {
  // Self-hosted installs send no telemetry. Better Auth turns telemetry on when this variable is truthy, whatever its own
  // option says, so refuse it here instead of trusting the library default.
  if (env.BETTER_AUTH_TELEMETRY && !['0', 'false'].includes(env.BETTER_AUTH_TELEMETRY.trim().toLowerCase())) throw new Error('BETTER_AUTH_TELEMETRY is not supported; Books never sends telemetry');
  trustedProxies(env);
  const appUrl = appUrlOrigin(env.APP_URL ?? 'http://localhost:3000');
  // Two roles (D-03): DATABASE_URL is the non-owner application role used by web and worker; MIGRATION_DATABASE_URL is
  // the owner role, used only to apply migrations. Without it the processes wait for an operator-run migration.
  const databaseUrl = postgresUrl('DATABASE_URL', env);
  if (!databaseUrl) throw new Error('A PostgreSQL DATABASE_URL is required');
  return { appUrl, databaseUrl, migrationDatabaseUrl: postgresUrl('MIGRATION_DATABASE_URL', env), authSecret: secret('AUTH_SECRET', env) };
}
