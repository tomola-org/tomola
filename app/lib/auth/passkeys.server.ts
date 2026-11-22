import { isDeletedIdentity } from "../deleted-member";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Db, Tx } from "~/lib/db/client.server";
import { passkey, passkeyRecoveries, passkeyRecoveryPermits, profiles, session, signingChallenges, user } from "~/lib/db/schema";
import { boundChallenge, canonicalSigningJson, lockSigningMember, SIGNING_TTL_MS, SigningError, signingSite, transportsOf, verifySignedAssertion } from "~/lib/signing.server";
import { enqueue } from "~/lib/jobs/queue.server";
import { SEND_PASSKEY_NOTICE_JOB } from "~/lib/jobs/mail-kinds";
import { isOperatorEmail } from "~/lib/operators.server";
import { revokeAllCredentials } from "./revoke-credentials.server";
import { hasBackupPasskeys, invalidateEmailLogins, invalidateMemberLoginChallenges, protectedLogin } from "./login-method.server";
import { requireLoginReauthentication } from "./login-reauthentication.server";
import { recoveryToken } from "./passkey-recovery-token.server";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const credentialIds = (keys: { credentialID: string }[]) => keys.map(k => k.credentialID).sort();
const validName = (name: unknown) => {
  if (typeof name !== "string" || name.length > 64) throw new SigningError("name_too_long", 400);
  return name.trim();
};
async function enrollmentState(tx: Db, userId: string) {
  const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
  if (!profile) throw new SigningError("not_a_member");
  const keys = await tx.select().from(passkey).where(eq(passkey.userId, userId));
  if (!keys.length && profile.passkeyEnrolledAt !== null && protectedLogin(profile)) throw new SigningError("operator_recovery_required", 409);
  return { profile, keys };
}

export async function passkeyRegistrationOptions(db: Db, userId: string, sessionId: string | undefined, nameInput: unknown, proof?: { challenge: string; assertion: AuthenticationResponseJSON }, now?: Date) {
  const name = validName(nameInput);
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const checkedAt = now ?? new Date();
    const { profile, keys } = await enrollmentState(tx, userId);
    await requireLoginReauthentication(tx, userId, sessionId, undefined, checkedAt);
    const requireProof = keys.length > 0 && protectedLogin(profile);
    const proofPayload = canonicalSigningJson({ version: 1, operation: "add-passkey-proof", userId, sessionId, name, credentialIds: credentialIds(keys) });
    if (requireProof && !proof) {
      const challenge = boundChallenge(hash(proofPayload));
      const options = await generateAuthenticationOptions({ rpID: signingSite().rpId, challenge: Buffer.from(challenge, "base64url"), userVerification: "required", timeout: SIGNING_TTL_MS, allowCredentials: keys.map(k => ({ id: k.credentialID, transports: transportsOf(k.transports) })) });
      await tx.insert(signingChallenges).values({ challenge, userId, operation: "add-passkey-proof", payload: proofPayload, payloadHash: hash(proofPayload), formHash: hash(name), createdAt: checkedAt, expiresAt: new Date(checkedAt.getTime() + SIGNING_TTL_MS) });
      return { needsProof: true as const, challenge, options };
    }
    let proofCredentialId: string | null = null;
    if (requireProof) {
      const [issued] = await tx.select().from(signingChallenges).where(and(eq(signingChallenges.challenge, proof!.challenge), eq(signingChallenges.userId, userId))).for("update");
      if (!issued || issued.usedAt || issued.expiresAt <= checkedAt || issued.operation !== "add-passkey-proof" || issued.payload !== proofPayload) throw new SigningError("invalid_addition_proof");
      const existing = await verifySignedAssertion(tx, userId, issued.challenge, proof!.assertion);
      proofCredentialId = existing.credentialID;
      await tx.update(signingChallenges).set({ usedAt: checkedAt }).where(eq(signingChallenges.challenge, issued.challenge));
    } else if (proof) throw new SigningError("invalid_addition_proof");
    return registrationOptions(tx, profile, keys, { name, sessionId, proofCredentialId }, checkedAt);
  });
}

type RegistrationApproval = { name: string; credentialIds: string[]; sessionId?: string; proofCredentialId?: string | null; permitHash?: string };
async function registrationOptions(tx: Db, profile: typeof profiles.$inferSelect, keys: typeof passkey.$inferSelect[], approval: Omit<RegistrationApproval, "credentialIds">, now: Date) {
  const userId = profile.userId;
  const payload = canonicalSigningJson({ ...approval, version: 1, operation: "register-passkey", userId, credentialIds: credentialIds(keys) });
  const challenge = boundChallenge(hash(payload));
  const options = await generateRegistrationOptions({ rpID: signingSite().rpId, rpName: "tomola", userName: profile.handle, userID: new TextEncoder().encode(userId), userDisplayName: profile.handle, challenge: Buffer.from(challenge, "base64url"), timeout: SIGNING_TTL_MS, attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" }, excludeCredentials: keys.map(k => ({ id: k.credentialID, transports: transportsOf(k.transports) })) });
  await tx.insert(signingChallenges).values({ challenge, userId, operation: "register-passkey", payload, payloadHash: hash(payload), formHash: hash(approval.name), createdAt: now, expiresAt: new Date(now.getTime() + SIGNING_TTL_MS) });
  return { needsProof: false as const, challenge, options };
}

async function registrationApproval(tx: Db, userId: string, challenge: string, now: Date): Promise<RegistrationApproval> {
  const [issued] = await tx.select().from(signingChallenges).where(and(eq(signingChallenges.challenge, challenge), eq(signingChallenges.userId, userId))).for("update");
  if (!issued || issued.usedAt || issued.expiresAt <= now || issued.operation !== "register-passkey") throw new SigningError("invalid_registration_challenge");
  return JSON.parse(issued.payload) as RegistrationApproval;
}

async function registerPasskey(tx: Db, profile: typeof profiles.$inferSelect, challenge: string, response: RegistrationResponseJSON, name: string, now: Date) {
  const userId = profile.userId;
  let verification;
  try { verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: signingSite().origin, expectedRPID: signingSite().rpId, requireUserVerification: true, requireUserPresence: true }); }
  catch { throw new SigningError("invalid_registration"); }
  if (!verification.verified || !verification.registrationInfo.userVerified) throw new SigningError("user_verification_required");
  const info = verification.registrationInfo;
  const [duplicate] = await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.credentialID, info.credential.id));
  if (duplicate) throw new SigningError("credential_already_registered", 409);
  const id = randomUUID();
  await tx.insert(passkey).values({ id, userId, name: name || null, credentialID: info.credential.id, publicKey: Buffer.from(info.credential.publicKey).toString("base64"), counter: info.credential.counter, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, transports: response.response.transports?.join(",") ?? "", createdAt: now, aaguid: info.aaguid });
  await tx.update(profiles).set({ passkeyEnrolledAt: profile.passkeyEnrolledAt ?? now, passkeyRecoveryUntil: null }).where(eq(profiles.userId, userId));
  await tx.update(signingChallenges).set({ usedAt: now }).where(eq(signingChallenges.challenge, challenge));
  await enqueuePasskeyNotice(tx, userId, "added", name, now);
  return { ok: true as const, id, credentialId: info.credential.id };
}

export async function verifyPasskeyRegistration(db: Db, userId: string, sessionId: string | undefined, challenge: string, response: RegistrationResponseJSON, now?: Date) {
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const checkedAt = now ?? new Date();
    const { profile, keys } = await enrollmentState(tx, userId);
    await requireLoginReauthentication(tx, userId, sessionId, undefined, checkedAt);
    const approved = await registrationApproval(tx, userId, challenge, checkedAt);
    if (approved.permitHash || approved.sessionId !== sessionId || canonicalSigningJson(approved.credentialIds) !== canonicalSigningJson(credentialIds(keys))
      || (protectedLogin(profile) && keys.length > 0 && !keys.some(k => k.credentialID === approved.proofCredentialId))) throw new SigningError("registration_changed", 409);
    const { ok, id } = await registerPasskey(tx, profile, challenge, response, approved.name, checkedAt);
    return { ok, id };
  });
}

async function withRecoveryPermit<T>(db: Db, token: unknown, now: Date | undefined, work: (tx: Tx, profile: typeof profiles.$inferSelect, permit: typeof passkeyRecoveryPermits.$inferSelect, checkedAt: Date) => Promise<T>) {
  const invalid = () => new SigningError("invalid_recovery_permit", 403);
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  const permitHash = hash(token);
  const [target] = await db.select({ userId: passkeyRecoveryPermits.userId }).from(passkeyRecoveryPermits).where(eq(passkeyRecoveryPermits.tokenHash, permitHash));
  if (!target) throw invalid();
  return db.transaction(async tx => {
    await lockSigningMember(tx, target.userId);
    const checkedAt = now ?? new Date();
    const [permit] = await tx.select().from(passkeyRecoveryPermits).where(and(eq(passkeyRecoveryPermits.userId, target.userId), eq(passkeyRecoveryPermits.tokenHash, permitHash)));
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, target.userId));
    const [key] = await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, target.userId)).limit(1);
    if (!permit || permit.expiresAt <= checkedAt || !profile || !protectedLogin(profile) || key) throw invalid();
    return work(tx, profile, permit, checkedAt);
  });
}

export function recoveryRegistrationOptions(db: Db, token: unknown, now?: Date) {
  return withRecoveryPermit(db, token, now, (tx, profile, permit, checkedAt) => registrationOptions(tx, profile, [], { name: "", permitHash: permit.tokenHash }, checkedAt));
}

export function finishPasskeyRecovery<T>(db: Db, token: unknown, challenge: string, response: RegistrationResponseJSON, issue: (tx: Tx, userId: string, at: Date, credentialId: string) => Promise<T>, now?: Date) {
  return withRecoveryPermit(db, token, now, async (tx, profile, permit, checkedAt) => {
    const approved = await registrationApproval(tx, profile.userId, challenge, checkedAt);
    if (approved.permitHash !== permit.tokenHash) throw new SigningError("invalid_registration_challenge");
    const key = await registerPasskey(tx, profile, challenge, response, approved.name, checkedAt);
    await tx.delete(passkeyRecoveryPermits).where(eq(passkeyRecoveryPermits.userId, profile.userId));
    await tx.update(passkeyRecoveries).set({ completedAt: checkedAt }).where(eq(passkeyRecoveries.id, permit.recoveryId));
    return issue(tx, profile.userId, checkedAt, key.credentialId);
  });
}

export async function removeOwnPasskey(tx: Tx, userId: string, id: string, sessionId: string | undefined) {
  const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
  if (!profile) throw new SigningError("not_a_member");
  const keys = await tx.select().from(passkey).where(eq(passkey.userId, userId));
  if (!keys.some(k => k.id === id)) return { ok: false as const, error: "not_found" as const };
  if (keys.length === 1 && protectedLogin(profile)) throw new SigningError("last_passkey", 409);
  await requireLoginReauthentication(tx, userId, sessionId, keys.length === 1 ? "remaining" : undefined);
  const key = keys.find(k => k.id === id)!;
  await tx.delete(passkey).where(and(eq(passkey.id, id), eq(passkey.userId, userId)));
  await enqueuePasskeyNotice(tx, userId, "removed", key.name ?? "", new Date());
  return { ok: true as const };
}

export async function setPasskeyOnly<T>(db: Db, userId: string, sessionId: string | undefined, enabled: boolean, rotate: (tx: Tx, at: Date) => Promise<T>, now?: Date) {
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const checkedAt = now ?? new Date();
    const confirmed = await requireLoginReauthentication(tx, userId, sessionId, "passkey", checkedAt);
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
    if (profile.passkeyOnly === enabled) return null;
    const keys = await tx.select({ backedUp: passkey.backedUp }).from(passkey).where(eq(passkey.userId, userId));
    if (enabled && !hasBackupPasskeys(keys)) throw new SigningError("passkey_backup_required", 409);
    await tx.update(profiles).set({ passkeyOnly: enabled }).where(eq(profiles.userId, userId));
    await enqueuePasskeyNotice(tx, userId, enabled ? "passkey_only_enabled" : "passkey_only_disabled", "", checkedAt);
    if (!enabled) return null;
    await tx.delete(session).where(eq(session.userId, userId));
    await invalidateEmailLogins(tx, confirmed.email);
    return rotate(tx, confirmed.at);
  });
}

type PasskeyNoticeAction = "added" | "removed" | "recovery" | "google_connected" | "google_disconnected" | "passkey_only_enabled" | "passkey_only_disabled";
export async function enqueuePasskeyNotice(tx: Db, userId: string, action: PasskeyNoticeAction, name: string, at: Date, recoveryId?: number) {
  await enqueue(tx, SEND_PASSKEY_NOTICE_JOB, { userId, action, name, at: at.toISOString(), recoveryId }, { dedupeKey: `passkey-notice:${randomUUID()}`, runAt: at });
}

// Called only from the operator CLI after independent identity checks.
export async function recoverPasskeys(db: Db, operator: { id: string; email: string }, userId: string, note: string, identityVerification: string, now?: Date) {
  if (isDeletedIdentity(operator.id, operator.email) || !isOperatorEmail(operator.email) || operator.id === userId) throw new SigningError("operator_required");
  if (note.trim().length < 10 || note.length > 4000) throw new SigningError("recovery_note_required", 400);
  if (!identityVerification?.trim() || identityVerification.length > 4000) throw new SigningError("recovery_verification_required", 400);
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const checkedAt = now ?? new Date();
    const [actualOperator] = await tx.select({ email: user.email }).from(user).where(eq(user.id, operator.id));
    if (!actualOperator || actualOperator.email !== operator.email || !isOperatorEmail(actualOperator.email)) throw new SigningError("operator_required");
    const [member] = await tx.select({ email: user.email, signPosts: profiles.signPosts, passkeyOnly: profiles.passkeyOnly, passkeyEnrolledAt: profiles.passkeyEnrolledAt }).from(profiles).innerJoin(user, eq(user.id, profiles.userId)).where(eq(profiles.userId, userId));
    if (!member || !protectedLogin(member)) throw new SigningError("recovery_not_available", 409);
    const expiresAt = new Date(checkedAt.getTime() + 30 * 60 * 1000);
    await tx.delete(passkey).where(eq(passkey.userId, userId));
    await revokeAllCredentials(tx, userId, checkedAt);
    await invalidateEmailLogins(tx, member.email);
    await invalidateMemberLoginChallenges(tx, userId);
    await tx.update(signingChallenges).set({ usedAt: checkedAt }).where(eq(signingChallenges.userId, userId));
    await tx.update(profiles).set({ passkeyEnrolledAt: member.passkeyEnrolledAt ?? checkedAt, passkeyRecoveryUntil: null }).where(eq(profiles.userId, userId));
    const [recovery] = await tx.insert(passkeyRecoveries).values({ userId, operatorId: operator.id, note: note.trim(), identityVerification: identityVerification.trim(), createdAt: checkedAt, expiresAt }).returning({ id: passkeyRecoveries.id });
    const permit = { recoveryId: recovery.id, tokenHash: hash(recoveryToken(userId, recovery.id)), expiresAt };
    await tx.insert(passkeyRecoveryPermits).values({ userId, ...permit }).onConflictDoUpdate({ target: passkeyRecoveryPermits.userId, set: permit });
    await enqueuePasskeyNotice(tx, userId, "recovery", "", checkedAt, recovery.id);
    return { expiresAt };
  });
}
