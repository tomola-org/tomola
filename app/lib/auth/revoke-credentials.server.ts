import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken, passkeyRecoveryPermits, profiles, session, signingChallenges, user } from "~/lib/db/schema";
import { revokeConnection } from "~/lib/mcp/connections.server";
import { revokeOpenInAiLinks } from "~/lib/open-in-ai.server";
import { revokeAllApiTokens } from "~/lib/tokens.server";
import { invalidateEmailLogins, invalidateMemberLoginChallenges, recordPasskeyRevocation } from "./login-method.server";

export async function revokeAllCredentials(db: Db, userId: string, now = new Date()) {
  return db.transaction(async tx => {
    const [owner] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId)).for("no key update");
    if (!owner) return { ok: false as const };
    const [member] = await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!member) return { ok: false as const };
    const grants = await tx.select({ id: oauthConsent.id, clientId: oauthConsent.clientId }).from(oauthConsent).where(eq(oauthConsent.userId, userId)).orderBy(asc(oauthConsent.clientId), asc(oauthConsent.id));
    const access = await tx.select({ clientId: oauthAccessToken.clientId }).from(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    const refresh = await tx.select({ clientId: oauthRefreshToken.clientId }).from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    const clients = [...new Set([...grants, ...access, ...refresh].map(row => row.clientId))].sort();
    for (const clientId of clients) await tx.select({ id: oauthClient.id }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).for("no key update");
    for (const grant of grants) await revokeConnection(tx, userId, grant.id);
    // Also remove orphaned token rows left without a consent by older versions.
    await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    const tokens = await revokeAllApiTokens(tx, userId, { now });
    const sessions = await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
    await revokeOpenInAiLinks(tx, userId);
    await invalidateEmailLogins(tx, owner.email);
    await invalidateMemberLoginChallenges(tx, userId);
    await tx.update(signingChallenges).set({ usedAt: now }).where(and(eq(signingChallenges.userId, userId), isNull(signingChallenges.usedAt)));
    await tx.delete(passkeyRecoveryPermits).where(eq(passkeyRecoveryPermits.userId, userId));
    // Use the same wall clock that timestamps Better Auth verification rows.
    await recordPasskeyRevocation(tx, userId, new Date());
    return { ok: true as const, tokens, sessions: sessions.length, connections: grants.length };
  });
}
