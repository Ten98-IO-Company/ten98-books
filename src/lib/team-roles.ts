import { mayGrantWorkspaceRole, workspaceRoles, type WorkspaceRole } from '@ten98/runtime/browser';

/** Roles the actor may assign to an existing member. */
export function assignableRoles(actor: unknown): WorkspaceRole[] {
  return workspaceRoles.filter(role => mayGrantWorkspaceRole(actor, role));
}

/** Invitations never grant ownership; ownership arrives only by transfer. */
export function invitableRoles(actor: unknown): WorkspaceRole[] {
  return assignableRoles(actor).filter(role => role !== 'owner');
}

const roleLabels: Record<Exclude<WorkspaceRole, 'owner'>, string> = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
const roleDescriptions: Record<Exclude<WorkspaceRole, 'owner'>, string> = {
  admin: 'Manage members and companies.',
  editor: 'Create companies and change their books.',
  viewer: 'View companies and their books.',
};

/** Invitation role choices the actor may grant, each with its one-line description, least privileged last. */
export function inviteRoleOptions(actor: unknown) {
  return invitableRoles(actor).map(role => {
    const value = role as Exclude<WorkspaceRole, 'owner'>;
    return { value, label: roleLabels[value], description: roleDescriptions[value] };
  });
}

export type InviteResult = { kind: 'create' | 'resend' | 'new-link'; delivery: 'accepted' | 'failed' | 'disabled'; email: string };

/** Delivery-state copy for a just-issued link: accepted is provider acceptance, never confirmed delivery. */
export function inviteResultText({ kind, delivery, email }: InviteResult): string {
  if (kind === 'new-link') return `New invitation link for ${email}. The previous link no longer works. Copy the link and share it yourself — no email was sent.`;
  if (kind === 'resend') {
    return delivery === 'accepted'
      ? `Invitation emailed again to ${email}. The email provider accepted the message; delivery is not confirmed. The previous link no longer works.`
      : `The invitation email to ${email} could not be sent. The previous link no longer works. Copy the new link and share it yourself.`;
  }
  if (delivery === 'accepted') return `Invitation emailed to ${email}. The email provider accepted the message; delivery is not confirmed. You can also copy the link.`;
  if (delivery === 'failed') return `The invitation email to ${email} could not be sent, so share this link yourself.`;
  return 'Email isn’t set up, so share this link yourself.';
}
