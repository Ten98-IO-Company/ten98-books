import type { PoolClient } from 'pg';
import { FoundationError, getAuth } from '../auth.ts';
import { getDatabase } from '../db.ts';

/** D-07: the one JSON encoder for API responses. A `bigint` (money in minor units) goes on the wire as a decimal string. */
export function toJson(body: unknown): string {
  return JSON.stringify(body, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
}

export function json(body: unknown, status = 200, additional?: HeadersInit): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  const extra = new Headers(additional);
  for (const [key, value] of extra) if (key !== 'set-cookie') headers.set(key, value);
  for (const value of extra.getSetCookie()) headers.append('set-cookie', value);
  return new Response(toJson(body), { status, headers });
}

/** Counts one request against `key` in the current minute and refuses past `maximum`. */
export async function limit(key: string, maximum: number, client?: PoolClient): Promise<void> {
  const { rows } = await (client ?? getDatabase().pool).query<{ count: number }>(
    `WITH expired AS (DELETE FROM request_limit WHERE minute < floor(extract(epoch FROM now()) / 60) - 60)
     INSERT INTO request_limit(key,minute,count) VALUES ($1,floor(extract(epoch FROM now()) / 60),1)
     ON CONFLICT(key,minute) DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING count`, [key, maximum],
  );
  if (rows[0].count > maximum) throw new FoundationError(429, 'Too many requests. Wait a minute and try again.');
}

/** Counts like limit, then refuses once the key's total over the last `minutes` minutes (at most 60, the expiry) exceeds the maximum. */
export async function limitWindow(key: string, maximum: number, minutes: number, client?: PoolClient): Promise<void> {
  const { rows } = await (client ?? getDatabase().pool).query<{ total: bigint }>(
    `WITH expired AS (DELETE FROM request_limit WHERE minute < floor(extract(epoch FROM now()) / 60) - 60),
     current AS (INSERT INTO request_limit(key,minute,count) VALUES ($1,floor(extract(epoch FROM now()) / 60),1)
       ON CONFLICT(key,minute) DO UPDATE SET count=LEAST(request_limit.count+1,$2::integer+1) RETURNING minute,count)
     SELECT current.count + COALESCE((SELECT sum(earlier.count) FROM request_limit earlier
       WHERE earlier.key=$1 AND earlier.minute < current.minute AND earlier.minute > current.minute - $3::integer),0) AS total FROM current`,
    [key, maximum, minutes],
  );
  if (Number(rows[0].total) > maximum) throw new FoundationError(429, `Too many attempts. Wait ${minutes === 1 ? 'a minute' : `${minutes} minutes`} and try again.`);
}

export type User = { id: string; name: string; email: string };

export async function signedIn(request: Request): Promise<User> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) throw new FoundationError(401, 'Sign in to continue.');
  return session.user;
}

/** A request handled by one feature area: `null` when the path is not one of its routes. */
export type ApiContext = { request: Request; url: URL; path: string };
export type ApiArea = (context: ApiContext) => Promise<Response | null>;
export type SignedInArea = (context: ApiContext & { user: User }) => Promise<Response | null>;
