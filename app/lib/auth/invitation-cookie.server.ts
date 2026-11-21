import { createHmac, timingSafeEqual } from "node:crypto";
import type { InvitationRef } from "./invitation-ref.server";
import { authSecret } from "./secret.server";

export const INVITATION_COOKIE_TTL_SECONDS = 3600;
type BrowserRequest = Pick<Request, "url" | "headers">;
export function invitationCookieName(request: BrowserRequest): string {
  return `${new URL(request.url).protocol === "https:" ? "__Host-" : ""}tomola.invitation`;
}
function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`signup-invitation:${payload}`).digest("base64url");
}
function cookie(request: BrowserRequest, value: string, maxAge: number): string {
  return `${invitationCookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function invitationCookie(request: BrowserRequest, ref: InvitationRef, secret = authSecret(), now = new Date()): string {
  const payload = `${ref.kind === "shared" ? "s:" : ""}${ref.id}.${Math.floor(now.getTime() / 1000) + INVITATION_COOKIE_TTL_SECONDS}`;
  return cookie(request, `${payload}.${signature(payload, secret)}`, INVITATION_COOKIE_TTL_SECONDS);
}
export function clearInvitationCookie(request: BrowserRequest, headers: Headers): void {
  headers.append("Set-Cookie", cookie(request, "", 0));
}
// Reject duplicates and enforce the signed expiry on the server, even if a client
// retains a cookie beyond Max-Age. The cookie carries no address or invite token.
function invitationValues(request: BrowserRequest) {
  const prefix = `${invitationCookieName(request)}=`;
  return (request.headers.get("cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));
}

export function hasSharedInvitationCookie(request: BrowserRequest) {
  return invitationValues(request).some(value => value.startsWith("s:"));
}

export function readInvitationCookie(request: BrowserRequest, secret = authSecret(), now = new Date()): InvitationRef | null {
  const values = invitationValues(request);
  if (values.length !== 1 || values[0].length > 256) return null;
  const match = /^(s:)?([a-f0-9-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(values[0]);
  if (!match) return null;
  const [, shared, id, expiry, supplied] = match;
  const seconds = Math.floor(now.getTime() / 1000);
  if (Number(expiry) <= seconds || Number(expiry) > seconds + INVITATION_COOKIE_TTL_SECONDS) return null;
  const expected = signature(`${shared ?? ""}${id}.${expiry}`, secret);
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) ? { kind: shared ? "shared" : "individual", id } : null;
}
