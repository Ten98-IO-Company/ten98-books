import { createWorkspaceTeam, isTeamError } from '@ten98/runtime';
import { hashPassword } from 'better-auth/crypto';
import type { PoolClient } from 'pg';
import { FoundationError } from './auth.ts';
import { emailLockKey, getDatabase } from './db.ts';
import { companyNotFound } from './tenancy.ts';

/** The app's one shared team controller, with its own per-email lock key. */
export const team = createWorkspaceTeam({ hashPassword, emailLockKey });

/**
 * The shared controller's refusals that name a workspace, in the app's wording: here a workspace is a company (D-03).
 * Every other message is shown as the controller wrote it.
 */
// A function, not a table: tenancy.ts and this module import each other through auth.ts, so companyNotFound is read
// when a refusal is mapped, never while the modules load.
const companyWording = (message: string): string | undefined => ({
  'Workspace not found or unavailable.': companyNotFound,
  'Only a workspace owner can change the two-factor requirement.': 'Only a company owner can change the two-factor requirement.',
  'Turn on two-factor authentication for your own account before requiring it for this workspace.': 'Turn on two-factor authentication for your own account before requiring it for this company.',
  'This person already belongs to the workspace.': 'This person already belongs to the company.',
  'Choose another existing workspace member.': 'Choose another member of the company.',
} as Record<string, string>)[message];

/** Maps a shared-controller refusal to the app's error; anything else is rethrown unchanged. */
export function teamFailure(error: unknown): never {
  if (isTeamError(error)) throw new FoundationError(error.status, companyWording(error.message) ?? error.message);
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
