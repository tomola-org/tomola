import { APIError, addOAuthServerContext, getAuthoritativeSessionFromCtx, getOAuthState } from "better-auth/api";
import type { BetterAuthOptions } from "better-auth";
import { AsyncLocalStorage } from "node:async_hooks";
import { GOOGLE_CLOCK_SKEW_MS, LOGIN_METHOD_FRESH_MS, markVerifiedLogin } from "./login-method.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { loginMethodReauthenticationPath, type LoginMethodPurpose } from "~/lib/reauth";

import { clearInvitationCookie, readInvitationCookie } from "./invitation-cookie.server";
import { parseInvitationRef, sameInvitation, type InvitationRef } from "./invitation-ref.server";

type BeforeContext = Parameters<typeof validateGoogleUser>[1];
export type GoogleReauthentication = { userId: string; sessionId: string; purpose?: LoginMethodPurpose; remaining?: boolean };
export const googleReauthenticationContext = new AsyncLocalStorage<GoogleReauthentication & { next: string }>();
export const googleInvitationContext = new AsyncLocalStorage<InvitationRef | null>();

export function googleInvitationRef(state: Awaited<ReturnType<typeof getOAuthState>>) {
  const context = state?.serverContext;
  return parseInvitationRef({ id: context?.invitationId, kind: context?.invitationKind === undefined ? "individual" : context.invitationKind });
};

// Only the server can bind an invitation to OAuth state. Client additionalData
// and requestSignUp never establish eligibility to create a user.
export async function prepareGoogleFlow(ctx: BeforeContext, enabled: boolean, reauthenticated: (userId: string, sessionId: string) => Promise<unknown>) {
  if (ctx.path === "/unlink-account") {
    const current = await getAuthoritativeSessionFromCtx(ctx);
    if (!current || !await reauthenticated(current.user.id, current.session.id)) throw new APIError("FORBIDDEN", { code: "SESSION_NOT_FRESH", message: "Reauthentication required" });
    return;
  }
  const start = ctx.path === "/sign-in/social" || ctx.path === "/link-social";
  const callback = ctx.path === "/callback/:id" && ctx.params?.id === "google";
  if (!start && !callback) return;
  // Replace only this endpoint's logger, leaving passkey and MCP diagnostics intact.
  const logger = ctx.context.logger;
  ctx.context.logger = { ...logger,
    error: () => logger.error("Google authentication request failed"),
    warn: () => logger.warn("Google authentication request failed"),
    info: () => logger.info("Google authentication request failed"),
    debug: () => logger.debug("Google authentication request failed"),
    success: () => logger.success("Google authentication request failed"),
  };
  if (!enabled || (start && ctx.body?.provider !== "google")) throw new APIError("NOT_FOUND", { message: "Not found" });
  if (!start) return;
  if (ctx.body?.idToken) throw new APIError("NOT_FOUND", { message: "ID token sign-in is disabled" });
  if (ctx.path === "/link-social") {
    const current = await getAuthoritativeSessionFromCtx(ctx);
    if (!current || !await reauthenticated(current.user.id, current.session.id)) throw new APIError("FORBIDDEN", { code: "SESSION_NOT_FRESH", message: "Reauthentication required" });
    await addOAuthServerContext({ linkSessionId: current.session.id });
  }
  const reauth = googleReauthenticationContext.getStore();
  if (ctx.path === "/sign-in/social") await addOAuthServerContext({ freshLogin: true, ...(reauth ? { reauthUserId: reauth.userId, reauthSessionId: reauth.sessionId } : {}) });
  const invitation = ctx.path === "/sign-in/social" ? googleInvitationContext.getStore() ?? null : null;
  if (invitation) await addOAuthServerContext({ invitationId: invitation.id, invitationKind: invitation.kind });
  const targetPath = new URL(safeLocalPath(ctx.body?.callbackURL), ctx.context.baseURL).pathname;
  // State is stored in plaintext. Keep invite links, query values and fragments
  // out of every return URL. Decode only for checks and keep the encoded path.
  let callbackURL = "/";
  try {
    const decodedPath = decodeURIComponent(targetPath);
    if (!decodedPath.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(decodedPath)
      && !/^\/(?:invite|auth|api\/auth)(?:[/?#]|$)/i.test(decodedPath)) callbackURL = targetPath;
  } catch { /* Invalid encoding returns home. */ }
  // Keep arbitrary scopes, authorization parameters and client state out of the
  // provider request. Never send an address as a Google login_hint.
  for (const key of Object.keys(ctx.body)) delete ctx.body[key];
  Object.assign(ctx.body, {
    provider: "google", callbackURL: ctx.path === "/link-social" ? "/settings#settings-google" : reauth?.next ?? callbackURL, newUserCallbackURL: "/onboarding",
    ...(ctx.path === "/sign-in/social" && reauth ? { additionalParams: { max_age: "0" } } : {}),
    errorCallbackURL: ctx.path === "/link-social" ? "/settings?google=1#settings-google" : reauth
      ? `${loginMethodReauthenticationPath(reauth.next, reauth.purpose, reauth.remaining ? "remaining" : undefined)}&google=1`
      : invitation ? "/invite?google=1" : "/login?google=1",
  });
}

export function googleEmailFailure(profile: Record<string, unknown>): "google_unverified" | "google_unmanaged" | null {
  if (profile.email_verified !== true) return "google_unverified";
  const email = typeof profile.email === "string" ? profile.email.toLowerCase() : "";
  const domain = email.split("@")[1];
  if (!domain || (!["gmail.com", "googlemail.com"].includes(domain) && profile.hd !== domain)) return "google_unmanaged";
  return null;
}

export async function finishGoogleFlow(ctx: Pick<BeforeContext, "path" | "params" | "request"> & { context: { baseURL: string; responseHeaders?: Headers } }, secret: string) {
  if (ctx.path !== "/callback/:id" || ctx.params?.id !== "google") return;
  const headers = ctx.context.responseHeaders;
  const location = headers?.get("location");
  if (!headers || !location) return;
  const base = new URL(ctx.context.baseURL);
  const url = URL.parse(location, base);
  // Enforce the return boundary even for state issued before the path checks.
  if (!url || url.protocol !== base.protocol || url.origin !== base.origin || url.pathname.startsWith("//")) {
    headers.set("location", "/");
    return;
  }
  if (ctx.request && !url.searchParams.has("error")
    && sameInvitation(readInvitationCookie(ctx.request, secret), googleInvitationRef(await getOAuthState()))) {
    clearInvitationCookie(ctx.request, headers);
  }
  // Better Auth adds a description for a rejected new user but omits it for
  // an existing unlinked user. Normalize that observable difference as well.
  if (url.pathname === "/login") {
    if (!url.searchParams.has("reauth") && url.searchParams.get("error") === "account_not_linked") {
      headers.set("location", "/login?google=1&error=account_not_linked");
    } else if (url.searchParams.has("reauth") && url.searchParams.has("error_description")) {
      url.searchParams.delete("error_description");
      headers.set("location", url.pathname + url.search + url.hash);
    }
  }
}

export const validateGoogleUser: NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]> = async ({ source, user }, ctx) => {
  if (source.method !== "oauth" || source.oauth?.providerId !== "google") return;
  if (source.action === "link-account") {
    try {
      const current = await getAuthoritativeSessionFromCtx(ctx);
      const state = await getOAuthState();
      if (!state?.link || current?.user.id !== state.link.userId || current.session.id !== state.serverContext?.linkSessionId) return { error: "google_reauth" };
    } catch { return { error: "google_reauth" }; }
    return;
  }
  const state = await getOAuthState();
  const profile = source.oauth?.profile ?? {};
  if (source.action === "create-user") {
    // Match the existing unlinked-account failure before inspecting email claims.
    if (!googleInvitationRef(state)) return { error: "account_not_linked" };
    const failure = googleEmailFailure(profile);
    if (failure) return { error: failure };
  } else if (source.action !== "sign-in") return;
  const expected = state?.serverContext?.reauthUserId;
  if (expected && user.id !== expected) return { error: "account_not_linked" };
  const now = Date.now();
  const authenticated = typeof profile.auth_time === "number" && Number.isSafeInteger(profile.auth_time) ? profile.auth_time * 1000 : 0;
  const at = state?.serverContext?.freshLogin === true
    && authenticated <= now + GOOGLE_CLOCK_SKEW_MS && authenticated >= now - LOGIN_METHOD_FRESH_MS - GOOGLE_CLOCK_SKEW_MS
    ? new Date(Math.min(authenticated + GOOGLE_CLOCK_SKEW_MS, now)) : null;
  const sourceSessionId = state?.serverContext?.reauthSessionId;
  if (expected && (!at || typeof sourceSessionId !== "string")) return { error: "google_reauth" };
  markVerifiedLogin(ctx.context, { method: "google", at, googleSubject: typeof profile.sub === "string" ? profile.sub : undefined, sourceSessionId: typeof sourceSessionId === "string" ? sourceSessionId : undefined });
};

export function maskGoogleInvitationEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
