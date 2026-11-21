import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "~/lib/db/client.server";
import { safeErrorText } from "~/lib/error-text.server";
import { invitations, sharedInvitationUses } from "~/lib/db/schema";
import { isDeletedIdentity } from "~/lib/deleted-member";
import { markInvitationUsed } from "~/lib/invitations.server";
import { consumeSharedInvitation } from "~/lib/shared-invitations.server";
import { rememberSignupInvitation } from "~/lib/signup-village.server";
import { isSuspendedDeletedAddress } from "~/lib/suspended-email.server";
import { invitationRequired, type InvitationRef } from "./invitation-ref.server";

export type SignupInvitationGrant = { ref: InvitationRef | null; strict: boolean };

export async function redeemSignupInvitation(tx: Tx, id: string, email: string, grant: SignupInvitationGrant) {
  const now = new Date();
  if (grant.ref?.kind === "shared") {
    if (isDeletedIdentity(id, email) || await isSuspendedDeletedAddress(tx, email, now)
      || !await consumeSharedInvitation(tx, grant.ref.id, id, now)) throw invitationRequired();
    return;
  }
  const invitationId = grant.ref?.id;
  const claimed = await markInvitationUsed(tx, email, { usedBy: id, invitationId, requireInvitationId: grant.strict, now });
  if (!claimed) throw invitationRequired();
  if (invitationId) {
    // Preserve registration if an optional legacy village association cannot be written.
    try { await tx.transaction(savepoint => rememberSignupInvitation(savepoint, id, invitationId)); }
    catch (error) { console.warn("[auth] Signup invitation association failed", { invitationId }, safeErrorText(error)); }
  }
}

export async function usedSignupInvitation(db: Db, userId: string, ref: InvitationRef) {
  if (ref.kind === "individual") {
    const [used] = await db.select({ id: invitations.id }).from(invitations)
      .where(and(eq(invitations.id, ref.id), eq(invitations.usedBy, userId)));
    return !!used;
  }
  const [used] = await db.select({ id: sharedInvitationUses.id }).from(sharedInvitationUses)
    .where(and(eq(sharedInvitationUses.linkId, ref.id), eq(sharedInvitationUses.usedBy, userId)));
  return !!used;
}
