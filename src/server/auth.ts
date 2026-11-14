import { randomUUID } from 'node:crypto'
import { createTen98Auth, type ResetPasswordMessage } from '@ten98/runtime/auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { hashPassword } from 'better-auth/crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { getConfig } from './config.ts'
import { getDatabase } from './db.ts'
import * as schema from './schema.ts'
import { team } from './workspace-team.ts'

export type { ResetPasswordMessage }

// The shared Ten98 identity preset (passwords, sessions, two-factor, reset cleanup, error redaction, telemetry off).
// The app keeps its routes, transactions, replay ledger and rate limiters. Cookie names use the origin-derived default.
function createAuth(client?: PoolClient, captureReset?: (message: ResetPasswordMessage) => void) {
  const config = getConfig()
  return createTen98Auth({
    database: drizzleAdapter(client ? drizzle(client, { schema }) : getDatabase().db, { provider: 'pg', schema }),
    appUrl: config.appUrl,
    secret: config.authSecret,
    appName: 'Books',
    // Capture only; the security boundary sends after the outer transaction commits.
    ...(captureReset ? { sendResetPassword: captureReset } : {}),
  })
}

let auth: ReturnType<typeof createAuth> | undefined

export function getAuth(client?: PoolClient, captureReset?: (message: ResetPasswordMessage) => void) {
  // Security routes bind every library query to one PostgreSQL transaction.
  if (client) return createAuth(client, captureReset)
  if (captureReset) throw new Error('Password recovery requires a transaction.')
  return (auth ??= createAuth())
}

export class FoundationError extends Error {
  readonly status: number
  /** Optional stable machine-readable reason, sent as `code` beside `error`; feature areas define their own values. */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'FoundationError'
    this.status = status
    if (code !== undefined) this.code = code
  }
}

// The first sign-up claims an unclaimed installation; there is no setup token (owner decision, 2026-10-23).
// A page cached across the upgrade may still send `token`: accept it and discard it unread.
const claimInput = z.object({
  token: z.string().max(512).optional(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().max(254).email(),
  password: z.string().min(12).max(128),
  workspaceName: z.string().trim().max(120)
    .transform((value) => value || 'My workspace')
    .default('My workspace'),
}).strict()

export async function claimInstallation(input: z.input<typeof claimInput>): Promise<void> {
  const result = claimInput.safeParse(input)
  if (!result.success) {
    throw new FoundationError(400, 'Check your setup details. Use a valid email and a password between 12 and 128 characters.')
  }

  const { token: _ignoredToken, ...details } = result.data
  const client = await getDatabase().pool.connect()
  try {
    await client.query('BEGIN')
    const installation = await client.query<{ claimed: boolean }>(
      'SELECT claimed FROM installation WHERE id = $1 FOR UPDATE', ['instance'],
    )
    if (!installation.rows[0]) {
      throw new FoundationError(503, 'Setup is unavailable. Apply database migrations and try again.')
    }
    if (installation.rows[0].claimed) {
      throw new FoundationError(409, 'Setup is complete. Sign in with the owner account.')
    }

    // Use Better Auth's own hash format and credential identity conventions.
    const password = await hashPassword(details.password)
    const userId = randomUUID()
    const workspaceId = randomUUID()
    // Every account-creation path takes the same per-email lock as invitation acceptance.
    await team.lockEmail(client, details.email)
    await client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, now(), now())`,
      [userId, details.name, details.email],
    )
    await client.query(
      `INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, now(), now())`,
      [randomUUID(), userId, password],
    )
    await client.query(
      'INSERT INTO workspace (id, name, created_at) VALUES ($1, $2, now())',
      [workspaceId, details.workspaceName],
    )
    await client.query(
      "INSERT INTO membership (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    )
    await client.query("INSERT INTO instance_operator(user_id,source) VALUES($1,'bootstrap')", [userId])
    await client.query("INSERT INTO instance_operator_audit(user_id,action) VALUES($1,'bootstrap')", [userId])
    await client.query('UPDATE installation SET claimed = true WHERE id = $1', ['instance'])
    await client.query('COMMIT')
  } catch (error) {
    // The caller returns a generic failure for unexpected database errors.
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
