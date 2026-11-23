export const refreshReplayDescription = "This refresh token was already used. Sign in again.";

const oauthErrors = new Set([
  "access_denied", "invalid_client", "invalid_client_metadata", "invalid_dpop_proof", "invalid_grant", "invalid_redirect_uri",
  "invalid_request", "invalid_scope", "invalid_target", "invalid_token", "rate_limited", "request_too_large",
  "server_error", "temporarily_unavailable", "unauthorized_client", "use_dpop_nonce",
  "unsupported_grant_type", "unsupported_token_type",
]);
const fixedDescriptions = new Set([
  refreshReplayDescription, "invalid refresh token", "session not found", "requested resource invalid", "invalid code",
  "client assertion jti has already been used", "Missing required client_id", "Missing a required refresh_token for refresh_token grant",
  "token not found", "refresh token revoked",
]);

export function oauthMachineEndpoint(path: string): "token" | "revoke" | undefined {
  if (path === "/api/auth/oauth2/token") return "token";
  if (path === "/api/auth/oauth2/revoke") return "revoke";
}

export async function logOAuthFailure(response: Response, endpoint: "token" | "revoke" | undefined, grantType?: string, clientId?: string) {
  if (!endpoint || response.status < 400) return response;
  const body = await response.clone().json().catch(() => null) as { error?: unknown; error_description?: unknown } | null;
  const error = typeof body?.error === "string" && oauthErrors.has(body.error) ? body.error : "other";
  const description = typeof body?.error_description === "string" && fixedDescriptions.has(body.error_description)
    ? body.error_description : error.replaceAll("_", " ");
  // Grant names and descriptions can contain arbitrary request values. Only
  // log known constants and IDs from the client table, with URL queries omitted.
  const grant = grantType === "authorization_code" || grantType === "refresh_token" ? grantType : null;
  const client = clientId?.split(/[?#]/, 1)[0].replace(/[\u2028\u2029]/g, "?").slice(0, 200) ?? null;
  console.log(`[http] OAuth failure ${JSON.stringify({
    endpoint, grant_type: grant, status: response.status, error, error_description: description, client_id: client,
  })}`);
  return response;
}
