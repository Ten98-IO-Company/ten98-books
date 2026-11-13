import { createWorkspaceTeam, isTeamError } from '@ten98/runtime';
import { hashPassword } from 'better-auth/crypto';
import type { PoolClient } from 'pg';
import { FoundationError } from './auth.ts';
import { emailLockKey, getDatabase } from './db.ts';

/** The app's one shared team controller, with its own per-email lock key. */
export const team = createWorkspaceTeam({ hashPassword, emailLockKey });

/** Maps a shared-controller refusal to the app's error; anything else is rethrown unchanged. */
export function teamFailure(error: unknown): never {
  if (isTeamError(error)) throw new FoundationError(error.status, error.message);
  throw error;
}

/** Runs `run` in one READ COMMITTED transaction (the controller's locks need no 40001 retry there), rolling back on any error. */
export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDatabase().pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    teamFailure(error);
  } finally { client.release(); }
}
