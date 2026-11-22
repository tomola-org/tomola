import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { account, profiles, user, verification } from "~/lib/db/schema";

export type LoginMethod = "email_link" | "email_code" | "google" | "passkey" | "unknown";
export type VerifiedLogin = { method: Exclude<LoginMethod, "unknown">; at: Date | null; credentialId?: string; backedUp?: boolean; googleSubject?: string; sourceSessionId?: string };
const verified = new WeakMap<object, VerifiedLogin>();
export const passkeyChallenges = new WeakMap<object, { userId: string; sessionId?: string }>();
export const internalLogin = new AsyncLocalStorage<VerifiedLogin & { userId: string }>();
export const verifiedEmailCode = new AsyncLocalStorage<boolean>();
export const markVerifiedLogin = (context: object, login: VerifiedLogin) => verified.set(context, login);
export function verifiedLogin(context: object | undefined, userId: string): VerifiedLogin | undefined {
  const issued = internalLogin.getStore();
  return issued?.userId === userId ? issued : context ? verified.get(context) : undefined;
}

export const LOGIN_METHOD_FRESH_MS = 10 * 60 * 1000;
export const GOOGLE_CLOCK_SKEW_MS = 60_000;
export const protectedLogin = (profile: { signPosts: boolean; passkeyOnly: boolean }) => profile.signPosts || profile.passkeyOnly;
export const hasBackupPasskeys = (keys: { backedUp: boolean }[]) => keys.length >= 2 || keys.some(key => key.backedUp);

export function freshLoginMethod(session: { reauthenticationMethod: string | null; reauthenticatedAt: Date | null } | undefined, now = new Date()) {
  if (!session?.reauthenticatedAt) return null;
  const age = now.getTime() - session.reauthenticatedAt.getTime();
  return age >= 0 && age <= LOGIN_METHOD_FRESH_MS ? session.reauthenticationMethod : null;
}

export async function linkedGoogle(db: Db, userId: string, subject?: string) {
  const [linked] = await db.select({ id: account.id }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, "google"), subject === undefined ? undefined : eq(account.accountId, subject))).limit(1);
  return !!linked;
}

export async function passkeyOnlyAddress(db: Db, email: string) {
  const [member] = await db.select({ enabled: profiles.passkeyOnly }).from(user).innerJoin(profiles, eq(user.id, profiles.userId)).where(eq(user.email, email));
  return member?.enabled === true;
}

// Better Auth stores the email beside the token hash. Delete its bound browser,
// return and code data by that hash as well, including links issued before this setting existed.
export async function invalidateEmailLogins(db: Db, email: string) {
  const links = await db.delete(verification).where(and(like(verification.identifier, "magic-link:%"), sql`strpos(lower(${verification.value}), ${`"email":${JSON.stringify(email.toLowerCase())}`}) > 0`)).returning({ identifier: verification.identifier });
  const hashes = links.map(row => row.identifier.slice("magic-link:".length));
  if (!hashes.length) return;
  const mappings = await db.select({ value: verification.value }).from(verification).where(inArray(verification.identifier, hashes.map(hash => `magic-link-code-link:${hash}`)));
  await db.delete(verification).where(inArray(verification.identifier, [
    ...hashes.flatMap(hash => ["magic-link-browser", "magic-link-next", "magic-link-invite", "magic-link-code-link"].map(prefix => `${prefix}:${hash}`)),
    ...mappings.map(row => `magic-link-code:${row.value}`),
  ]));
}

export async function invalidateMemberLoginChallenges(db: Db, userId: string) {
  const id = JSON.stringify(userId);
  await db.delete(verification).where(sql`(
    strpos(${verification.value}, ${'"type":"authentication"'}) > 0
    and strpos(${verification.value}, ${`"userData":{"id":${id}}`}) > 0
  ) or (
    strpos(${verification.value}, ${`"reauthUserId":${id}`}) > 0
    or (strpos(${verification.value}, ${'"encryptedSessionToken":'}) > 0 and strpos(${verification.value}, ${`"userId":${id}`}) > 0)
  )`);
}
