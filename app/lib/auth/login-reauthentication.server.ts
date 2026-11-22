import { and, eq, gt } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles, session, user } from "~/lib/db/schema";
import { SigningError } from "~/lib/signing.server";
import { DAY_MS, RETENTION } from "~/lib/retention";
import { googleLoginConfig } from "./google-config.server";
import { freshLoginMethod, linkedGoogle, protectedLogin } from "./login-method.server";

type RequiredMethod = "remaining" | "passkey";

export async function loginReauthentication(db: Db, userId: string, sessionId: string | undefined, required?: RequiredMethod, now = new Date()) {
  if (!sessionId) return null;
  const [row] = await db.select({ reauthenticatedAt: session.reauthenticatedAt, reauthenticationMethod: session.reauthenticationMethod, email: user.email, passkeyOnly: profiles.passkeyOnly }).from(session)
    .innerJoin(user, eq(user.id, session.userId)).innerJoin(profiles, eq(profiles.userId, user.id))
    .where(and(eq(session.id, sessionId), eq(session.userId, userId), gt(session.expiresAt, now), gt(session.createdAt, new Date(now.getTime() - RETENTION.sessionAbsoluteDays * DAY_MS))));
  if (!row) return null;
  const method = freshLoginMethod(row, now);
  if (protectedLogin(row) || required === "passkey") return method === "passkey" ? row : null;
  if (method === "passkey") return required === "remaining" ? null : row;
  if (method === "email_code" || method === "email_link") return row.email ? row : null;
  if (method === "google" && googleLoginConfig() && await linkedGoogle(db, userId)) return row;
  return null;
}

// Mutations check this while holding the member lock, so logout, rotation and
// changes to the available sign-in methods are evaluated against the live row.
export async function requireLoginReauthentication(db: Db, userId: string, sessionId: string | undefined, required?: RequiredMethod, now?: Date) {
  const row = await loginReauthentication(db, userId, sessionId, required, now);
  if (!row) throw new SigningError(required === "remaining" ? "remaining_login_required" : "SESSION_NOT_FRESH");
  return { at: row.reauthenticatedAt!, email: row.email };
}
