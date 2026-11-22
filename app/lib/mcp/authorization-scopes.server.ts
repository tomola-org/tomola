import { eq } from "drizzle-orm";
import { MCP_SCOPES } from "~/lib/connect-paths";
import type { Db } from "~/lib/db/client.server";
import { oauthClient } from "~/lib/db/schema";

export const AUTHORIZE_PATH = "/api/auth/oauth2/authorize";

export async function scopeWithOfflineAccess(db: Db, query: URLSearchParams): Promise<string | undefined> {
  const clientId = query.get("client_id");
  const scope = query.get("scope");
  if (!clientId || scope === null || ["client_id", "scope", "prompt"].some(name => query.getAll(name).length > 1)) return;
  const scopes = scope.split(" ").filter(Boolean);
  if (scopes.includes("offline_access") || query.get("prompt")?.split(" ").some(prompt => prompt.trim() === "none")) return;

  const [client] = await db.select({ disabled: oauthClient.disabled, grants: oauthClient.grantTypes, scopes: oauthClient.scopes })
    .from(oauthClient).where(eq(oauthClient.clientId, clientId));
  if (!client || client.disabled || !client.grants?.includes("refresh_token")) return;
  if (!(client.scopes ?? MCP_SCOPES).includes("offline_access")) return;
  return [...scopes, "offline_access"].join(" ");
}
