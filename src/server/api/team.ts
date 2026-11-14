import type { PoolClient } from 'pg';
import { z } from 'zod';
import { FoundationError } from '../auth.ts';
import { getConfig } from '../config.ts';
import { emailLimitKey } from '../client-rate-limit.ts';
import { getDatabase } from '../db.ts';
import { getEmailStatus, sendTransactionalEmail } from '../email.ts';
import { changeRole, getTeam, inviteMember, removeMember, renameWorkspace, revokeInvitation, rotateInvitation, setTwoFactorRequirement, transferOwnership } from '../teams.ts';
import { team } from '../workspace-team.ts';
import { readJson } from '../validation.ts';
import { json, limit, limitWindow, type SignedInArea } from './http.ts';

const id = '[0-9a-f-]{36}';

// Fixed text: company and inviter names are member-chosen, so they never reach the installation's sender (phishing surface).
function sendInvitationEmail(to: string, role: string, inviteUrl: string) {
  return sendTransactionalEmail({ to, subject: 'Your Books company invitation', text: `You were invited to join a company's books on the Books installation at ${getConfig().appUrl} with the ${role} role.\n\nOpen this link within 7 days to accept:\n${inviteUrl}\n\nOnly the newest invitation link sent to this address for a company works. If you did not expect this invitation, ignore this email.` });
}

/** The signed-in account, its workspaces (each one company, D-03), members, roles and invitations. */
export const teamApi: SignedInArea = async ({ request, path, user }) => {
  const config = getConfig();
  // No POST /api/workspaces: a workspace is a company (D-03), so companies come only from first-user setup and
  // POST /api/companies, never without their books settings.
  if (path === '/api/me' && request.method === 'GET') {
    const { pool } = getDatabase();
    const { rows } = await pool.query(
      // twoFactorLocked mirrors the shared controller's gate so the shell can explain the 403 before any workspace read.
      'SELECT w.id,w.name,m.role,EXISTS(SELECT 1 FROM workspace_two_factor_requirement r JOIN "user" u ON u.id=m.user_id WHERE r.workspace_id=w.id AND NOT u."twoFactorEnabled") AS "twoFactorLocked" FROM workspace w JOIN membership m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at,w.id', [user.id]);
    return json({ user: { id: user.id, name: user.name, email: user.email }, instanceOperator: await team.isInstanceOperator(pool, user.id), workspaces: rows });
  }
  let match = path.match(new RegExp(`^/api/workspaces/(${id})/(team|rename|invitations|transfer-ownership|two-factor)$`, 'i'));
  if (match) {
    if (request.method === 'GET' && match[2] === 'team') {
      // Lets managers see whether resend email can work; it never exposes the transport or its settings.
      return json({ ...await getTeam(match[1], user.id), emailConfigured: getEmailStatus().configured });
    }
    if (request.method === 'POST') {
      await limit(`team:${user.id}`, 60);
      if (match[2] === 'transfer-ownership') return json(await transferOwnership(match[1], user.id, await readJson(request)));
      if (match[2] === 'two-factor') return json(await setTwoFactorRequirement(match[1], user.id, await readJson(request)));
      if (match[2] === 'rename') return json(await renameWorkspace(match[1], user.id, await readJson(request)));
      if (match[2] === 'invitations') {
        const result = await inviteMember(match[1], user.id, await readJson(request));
        const { email: to, role } = result.invitation, inviteUrl = `${config.appUrl}/#invite=${result.token}`;
        // Committed above; no PoolClient is held, one attempt only, and no failure undoes the invitation.
        const email = !getEmailStatus().configured ? 'disabled' : await limit(emailLimitKey('invitation-email', to), 3)
          .then(() => limit('invitation-email:global', 20))
          .then(() => sendInvitationEmail(to, role, inviteUrl))
          .then(() => 'accepted' as const, () => 'failed' as const);
        return json({ invitation: result.invitation, inviteUrl, email }, 201);
      }
    }
  }
  match = path.match(new RegExp(`^/api/workspaces/(${id})/(members|invitations)/(${id})/(role|remove|revoke|resend|new-link)$`, 'i'));
  if (match && request.method === 'POST') {
    await limit(`team:${user.id}`, 60);
    const input = await readJson(request);
    if (match[2] === 'members' && match[4] === 'role') { await changeRole(match[1], user.id, match[3], input); return json({ ok: true }); }
    if (match[2] === 'members' && match[4] === 'remove') { z.object({}).strict().parse(input); await removeMember(match[1], user.id, match[3]); return json({ ok: true }); }
    if (match[2] === 'invitations' && match[4] === 'revoke') { z.object({}).strict().parse(input); await revokeInvitation(match[1], user.id, match[3]); return json({ ok: true }); }
    if (match[2] === 'invitations' && (match[4] === 'resend' || match[4] === 'new-link')) {
      z.object({}).strict().parse(input);
      // Resend spends its budgets inside the rotation transaction after authorization and the pending check, so any refusal
      // rolls back every count it spent and leaves the current link working.
      const [workspaceKey, invitationKey] = [match[1].toLowerCase(), match[3].toLowerCase()];
      const admit = match[4] !== 'resend' ? undefined : async (client: PoolClient, invitation: { email: string }) => {
        if (!getEmailStatus().configured) throw new FoundationError(409, 'Email is not set up on this installation, so nothing was sent and the current link still works. Use New link to get a link you can copy and share yourself.');
        await limitWindow(`invitation-resend:${invitationKey}`, 3, 60, client);
        await limitWindow(`invitation-resend:workspace:${workspaceKey}`, 20, 60, client);
        await limit(emailLimitKey('invitation-email', invitation.email), 3, client);
        await limit('invitation-email:global', 20, client);
      };
      const result = await rotateInvitation(match[1], user.id, match[3], admit);
      const inviteUrl = `${config.appUrl}/#invite=${result.token}`;
      if (match[4] === 'new-link') return json({ invitation: result.invitation, inviteUrl });
      const email = await sendInvitationEmail(result.invitation.email, result.invitation.role, inviteUrl).then(() => 'accepted' as const, () => 'failed' as const);
      return json({ invitation: result.invitation, inviteUrl, email });
    }
  }
  return null;
};
