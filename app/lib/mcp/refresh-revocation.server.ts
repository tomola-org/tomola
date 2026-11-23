import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { mcpRevokedToken, oauthAccessToken, oauthRefreshToken } from "~/lib/db/schema";
import { MCP_ACCESS_TOKEN_SECONDS, lineMark, revokedLineId } from "./line.server";

type Line = { userId: string; clientId: string; authorizationCodeId: string };
export type RefreshReplayOutcome =
  | { lineMark: string; revokedCount: number; secondsSinceRotation: number | null }
  | { deletedCount: number };

export const refreshReplayScope = new AsyncLocalStorage<{
  sent: Pick<typeof oauthRefreshToken.$inferSelect, "id" | "userId" | "clientId" | "authorizationCodeId" | "rotatedAt">;
  outcome?: RefreshReplayOutcome;
}>();

export async function stopRefreshLine(db: Db, sent: Line, revoked: Date) {
  const line = and(eq(oauthRefreshToken.userId, sent.userId), eq(oauthRefreshToken.clientId, sent.clientId),
    eq(oauthRefreshToken.authorizationCodeId, sent.authorizationCodeId));
  const rows = await db.update(oauthRefreshToken).set({ revoked }).where(and(line, isNull(oauthRefreshToken.revoked)))
    .returning({ id: oauthRefreshToken.id });
  await db.update(oauthRefreshToken).set({ rotationReplayResponse: null }).where(and(line, isNotNull(oauthRefreshToken.rotationReplayResponse)));
  // The mark must stay on the revocation list until any access JWT in the line has expired.
  const mark = lineMark(sent.authorizationCodeId);
  const now = Date.now();
  const expiresAt = new Date(now + MCP_ACCESS_TOKEN_SECONDS * 1000);
  await db.delete(mcpRevokedToken).where(lte(mcpRevokedToken.expiresAt, new Date(now)));
  await db.insert(mcpRevokedToken).values({ id: revokedLineId(mark), expiresAt }).onConflictDoUpdate({
    target: mcpRevokedToken.id, set: { expiresAt },
  });
  return { lineMark: mark, revokedCount: rows.length };
}

export async function deleteRefreshLineAccessTokens(db: Db, sent: Line) {
  const rows = await db.delete(oauthAccessToken).where(and(eq(oauthAccessToken.userId, sent.userId),
    eq(oauthAccessToken.clientId, sent.clientId), eq(oauthAccessToken.authorizationCodeId, sent.authorizationCodeId)))
    .returning({ id: oauthAccessToken.id });
  return rows.length;
}
