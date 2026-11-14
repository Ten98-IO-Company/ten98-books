import type { Invitation } from '@ten98/runtime';
import type { PoolClient } from 'pg';
import { FoundationError } from './auth.ts';
import { getDatabase } from './db.ts';
import { team, teamFailure, transaction } from './workspace-team.ts';

// Thin adapters over the shared controller (@ten98/runtime createWorkspaceTeam): the app keeps its routes, transactions
// and FoundationError responses; every decision, lock and validation lives in the package.

export const createWorkspace = (userId: string, input: unknown) => transaction(client => team.createWorkspace(client, userId, input));
export const renameWorkspace = (workspaceId: string, userId: string, input: unknown) => transaction(client => team.renameWorkspace(client, workspaceId, userId, input));
export const getTeam = (workspaceId: string, userId: string) => transaction(client => team.getTeam(client, workspaceId, userId));
export const setTwoFactorRequirement = (workspaceId: string, userId: string, input: unknown) => transaction(client => team.setTwoFactorRequirement(client, workspaceId, userId, input));
export const inviteMember = (workspaceId: string, userId: string, input: unknown) => transaction(client => team.inviteMember(client, workspaceId, userId, input));
export const revokeInvitation = (workspaceId: string, userId: string, invitationId: string): Promise<void> => transaction(client => team.revokeInvitation(client, workspaceId, userId, invitationId));
export const changeRole = (workspaceId: string, userId: string, targetUserId: string, input: unknown): Promise<void> => transaction(client => team.changeRole(client, workspaceId, userId, targetUserId, input));
/** Promote an existing member and demote this owner in the same workspace transaction. */
export const transferOwnership = (workspaceId: string, userId: string, input: unknown) => transaction(client => team.transferOwnership(client, workspaceId, userId, input));
/** Removes a member, or lets any member leave (userId === targetUserId); an owner is always kept. */
export const removeMember = (workspaceId: string, userId: string, targetUserId: string): Promise<void> => transaction(client => team.removeMember(client, workspaceId, userId, targetUserId));
export const acceptInvitation = (input: unknown, signedInUser?: { id: string; email: string }) => transaction(client => team.acceptInvitation(client, input, signedInUser));
export const inspectInvitation = (input: unknown) => team.inspectInvitation(getDatabase().pool, input).catch(teamFailure);

/**
 * Owner/admin: replaces a pending invitation's token and restarts its seven days. Only the token hash is stored, so this is
 * also how a resend gets a link to email. `admit` runs in the same transaction after authorization and the pending check;
 * a refusal there rolls back everything it spent.
 */
export const rotateInvitation = (workspaceId: string, userId: string, invitationId: string, admit?: (client: PoolClient, invitation: Invitation) => Promise<void>) =>
  transaction(client => team.rotateInvitation(client, workspaceId, userId, invitationId, admit && ((_, invitation) => admit(client, invitation))));

const factorGatedPath = /^\/api\/(?:workspaces|companies)\/([0-9a-f-]{36})(?:\/|$)/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ponytail: point-in-time check before each service transaction (the projectAccess class); a request already past it when the
// requirement turns on or the member disables their factor can finish. Soundness relies on verify/disable revoking other sessions
// (keepResponseSession in account-security.ts). Upgrade path: carry the predicate into withCompany.
/**
 * Refuses a member without a verified factor on every route of a company (workspace) that requires one. A company id is
 * the workspace id (D-03), so both route families name the workspace directly.
 */
export async function requireWorkspaceFactor(path: string, userId: string): Promise<void> {
  const match = factorGatedPath.exec(path);
  // A malformed id or a non-member finds no requirement and falls through to the service's own answer.
  if (!match || !uuid.test(match[1]) || !uuid.test(userId)) return;
  const { pool } = getDatabase();
  if (await team.memberNeedsFactor(pool, match[1].toLowerCase(), userId).catch(teamFailure)) {
    throw new FoundationError(403, 'This company requires two-factor authentication. Turn it on in Account security, then try again.');
  }
}
