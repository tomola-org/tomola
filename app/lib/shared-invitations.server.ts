import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql, TransactionRollbackError } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db, Tx } from "~/lib/db/client.server";
import { accountDeletions, profiles, sharedInvitations, sharedInvitationUses, user, villages } from "~/lib/db/schema";
import { hashInvitationToken } from "~/lib/invitations.server";
import { getWriter } from "~/lib/members.server";
import { isOperatorEmail } from "~/lib/operators.server";
import { hitMemberLimit } from "~/lib/rate-limit.server";
import { lockSignupVillage } from "~/lib/signup-village.server";

type SharedInvitation = typeof sharedInvitations.$inferSelect;
export const SHARED_INVITATION_LIST_LIMIT = 200;

const details = {
  id: sharedInvitations.id,
  createdBy: sharedInvitations.createdBy,
  villageId: sharedInvitations.villageId,
  maxUses: sharedInvitations.maxUses,
  usedCount: sharedInvitations.usedCount,
  expiresAt: sharedInvitations.expiresAt,
  revokedAt: sharedInvitations.revokedAt,
};

type SharedInvitationStatus = "valid" | "full" | "expired" | "revoked";
export function sharedInvitationStatus(link: Pick<SharedInvitation, "createdBy" | "revokedAt" | "expiresAt" | "usedCount" | "maxUses">, now = new Date()): SharedInvitationStatus {
  if (!link.createdBy || link.revokedAt) return "revoked";
  if (link.expiresAt <= now) return "expired";
  return link.usedCount >= link.maxUses ? "full" : "valid";
}

function available(now: Date) {
  return and(isNotNull(sharedInvitations.createdBy), isNull(sharedInvitations.revokedAt),
    gt(sharedInvitations.expiresAt, now), sql`${sharedInvitations.usedCount} < ${sharedInvitations.maxUses}`);
}

export async function findSharedInvitation(db: Db, lookup: { id: string } | { token: string }) {
  if ("token" in lookup && !/^[A-Za-z0-9_-]{43}$/.test(lookup.token)) return null;
  const [link] = await db.select(details).from(sharedInvitations).where("id" in lookup
    ? eq(sharedInvitations.id, lookup.id)
    : eq(sharedInvitations.tokenHash, hashInvitationToken(lookup.token)));
  return link ?? null;
}

function boundedInteger(value: FormDataEntryValue | null, max: number) {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= max ? n : null;
}

export async function createSharedInvitation(db: Db, actor: { id: string; email: string }, form: FormData, now = new Date()) {
  if (!isOperatorEmail(actor.email)) return { error: "forbidden" as const };
  const rawLabel = form.get("label");
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  const maxUses = boundedInteger(form.get("maxUses"), 100);
  const ttlDays = boundedInteger(form.get("ttlDays"), 30);
  const village = form.get("villageId");
  if (!label || [...label].length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(String(rawLabel))
      || !maxUses || !ttlDays || (village !== null && typeof village !== "string")) return { error: "invalid" as const };
  const villageId = village || null;
  return db.transaction(async tx => {
    const [profile] = await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, actor.id)).for("update");
    if (!profile || !(await getWriter(tx, actor.id, { now })).ok) return { error: "forbidden" as const };
    const [deletion] = await tx.select({ id: accountDeletions.id }).from(accountDeletions).where(and(
      eq(accountDeletions.userId, actor.id), inArray(accountDeletions.state, ["pending", "failed"]),
    ));
    if (deletion) return { error: "forbidden" as const };
    if (villageId && !await lockSignupVillage(tx, actor.id, villageId)) return { error: "invalid_village" as const };
    const rate = await hitMemberLimit(tx, "shared-invitation", actor.id, now);
    if (!rate.allowed) {
      // A denied creation must not charge the issuance allowance.
      tx.rollback();
    }
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    await tx.insert(sharedInvitations).values({
      id, tokenHash: hashInvitationToken(token), label, createdBy: actor.id, villageId, maxUses,
      createdAt: now, expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
    });
    return { id, token, error: null };
  }).catch((error: unknown) => {
    if (error instanceof TransactionRollbackError) return { error: "rate_limited" as const };
    throw error;
  });
}

export async function listSharedInvitations(db: Db, opts: { createdBy?: string; limit?: number } = {}) {
  const rows = await db.select({
    ...details, label: sharedInvitations.label, createdAt: sharedInvitations.createdAt, inviterHandle: profiles.handle, villageName: villages.name,
  }).from(sharedInvitations)
    .leftJoin(profiles, eq(profiles.userId, sharedInvitations.createdBy)).leftJoin(villages, eq(villages.id, sharedInvitations.villageId))
    .where(opts.createdBy === undefined ? undefined : eq(sharedInvitations.createdBy, opts.createdBy))
    .orderBy(desc(sharedInvitations.createdAt), desc(sharedInvitations.id)).limit(opts.limit ?? SHARED_INVITATION_LIST_LIMIT);
  const now = new Date();
  return rows.map(({ createdBy, villageId, revokedAt, ...row }) => ({
    ...row, status: sharedInvitationStatus({ ...row, createdBy, revokedAt }, now),
  }));
}

export async function listSharedInvitationUses(db: Db, opts: { createdBy?: string; limit?: number } = {}) {
  const inviter = alias(profiles, "inviter");
  const usedByProfile = alias(profiles, "used_by_profile");
  const rows = await db.select({
    id: sharedInvitationUses.id,
    usedAt: sharedInvitationUses.usedAt,
    label: sharedInvitations.label,
    inviterHandle: inviter.handle,
    usedByHandle: usedByProfile.handle,
    usedByUserId: user.id,
  }).from(sharedInvitationUses)
    .innerJoin(sharedInvitations, eq(sharedInvitations.id, sharedInvitationUses.linkId))
    .leftJoin(inviter, eq(inviter.userId, sharedInvitations.createdBy))
    .leftJoin(user, eq(user.id, sharedInvitationUses.usedBy))
    .leftJoin(usedByProfile, eq(usedByProfile.userId, user.id))
    .where(opts.createdBy === undefined ? undefined : eq(sharedInvitations.createdBy, opts.createdBy))
    .orderBy(desc(sharedInvitationUses.usedAt), desc(sharedInvitationUses.id))
    .limit(opts.limit ?? SHARED_INVITATION_LIST_LIMIT);
  return rows.map(({ usedByUserId, ...row }) => ({ ...row, usedByExists: usedByUserId !== null }));
}

export async function revokeSharedInvitation(db: Db, id: string, createdBy?: string, now = new Date()) {
  const rows = await db.update(sharedInvitations).set({ revokedAt: now }).where(and(
    eq(sharedInvitations.id, id), available(now), createdBy === undefined ? undefined : eq(sharedInvitations.createdBy, createdBy),
  )).returning({ id: sharedInvitations.id });
  return rows.length > 0;
}

export async function consumeSharedInvitation(tx: Tx, id: string, userId: string, now = new Date()) {
  const [claimed] = await tx.update(sharedInvitations).set({ usedCount: sql`${sharedInvitations.usedCount} + 1` })
    .where(and(eq(sharedInvitations.id, id), available(now))).returning({ id: sharedInvitations.id });
  if (!claimed) return false;
  await tx.insert(sharedInvitationUses).values({ id: randomUUID(), linkId: id, usedBy: userId, usedAt: now });
  return true;
}
