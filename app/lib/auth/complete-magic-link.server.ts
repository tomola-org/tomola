import { randomUUID } from "node:crypto";
import { isAPIError } from "better-auth/api";
import { inArray, eq } from "drizzle-orm";
import { redirect, redirectDocument } from "react-router";
import { getDb, type Db } from "~/lib/db/client.server";
import { user, verification } from "~/lib/db/schema";
import { getProfile, rememberUiLocale } from "~/lib/profiles.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { negotiateUiLocale } from "~/lib/http/locale.server";
import { bindAuthToDatabase, getAuth } from "./auth.server";
import { browserBindingIdentifier, matchesMagicLinkBrowser } from "./magic-link-browser.server";
import { magicLinkNextIdentifier, readMagicLinkNext } from "./magic-link-next.server";
import { loginCodeIdentifier, loginCodeLinkIdentifier } from "./login-code.server";
import { clearLoginCodeCookies } from "./login-code-cookie.server";
import { clearReadingReturn } from "./reading-return.server";
import { clearInvitationCookie, readInvitationCookie } from "./invitation-cookie.server";
import { magicLinkInvitationContext, magicLinkInvitationIdentifier, parseInvitationRef, sameInvitation } from "./invitation-ref.server";
import { usedSignupInvitation } from "./signup-invitation.server";
import { lockSigningMember, SigningError } from "~/lib/signing.server";
import { verifiedEmailLogin } from "./login-method.server";
import { getSessionUser, loginManagementSession } from "./session.server";
import { hashMagicLinkToken } from "./plugins";
export const LOGIN_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin", "X-Robots-Tag": "noindex" };
export const magicLinkUsedIdentifier = (token: string) => `magic-link-used:${hashMagicLinkToken(token)}`;
export const magicLinkOwnerHash = (userId: string) => hashMagicLinkToken(userId);
const confirmations = new Map<string, Promise<void>>();

export async function waitForMagicLinkCompletion(token: string): Promise<boolean> {
  const pending = confirmations.get(magicLinkUsedIdentifier(token));
  if (!pending) return false;
  await pending;
  return true;
}

// Both entry points use Better Auth's atomic token consumption. A simultaneous
// link/code request can create only one session, even on separate connections.
type Completion = { kind: "ok"; response: Response } | { kind: "invitation_unavailable" } | { kind: "invalid" };
const invalid = { kind: "invalid" } as const;
type EmailLogin = { method: "email_link" } | { method: "email_code"; reauthenticate: boolean };

export async function completeMagicLink(request: Request, token: string, login: EmailLogin = { method: "email_link" }): Promise<Completion> {
  // Serialize local confirmations through marker insertion as well as token use.
  // Better Auth still enforces atomic consumption across separate processes.
  const key = magicLinkUsedIdentifier(token);
  const previous = confirmations.get(key);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  confirmations.set(key, pending);
  try {
    await previous;
    return await verifyMagicLink(request, token, login);
  } finally {
    release();
    if (confirmations.get(key) === pending) confirmations.delete(key);
  }
}

async function verifyMagicLink(request: Request, token: string, login: EmailLogin): Promise<Completion> {
  const db = await getDb();
  if (!(await matchesMagicLinkBrowser(db, request, token))) return invalid;
  const [credential] = await db.select({ expiresAt: verification.expiresAt, value: verification.value }).from(verification)
    .where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
  if (!credential || credential.expiresAt <= new Date()) return invalid;
  const email = (JSON.parse(credential.value) as { email?: string }).email?.toLowerCase();
  const signedIn = login.method === "email_link" || login.reauthenticate ? await getSessionUser(request) : null;
  const sessionId = signedIn ? await loginManagementSession(request) : undefined;
  const sourceSessionId = email === signedIn?.email.toLowerCase() ? sessionId : undefined;
  if (login.method === "email_code" && sessionId && !sourceSessionId) return invalid;
  const proof = { method: login.method, sourceSessionId, fresh: login.method === "email_code" || sourceSessionId !== undefined };
  const identifier = magicLinkInvitationIdentifier(token);
  const [binding] = await db.select().from(verification).where(eq(verification.identifier, identifier));
  let ref = null;
  if (binding && binding.expiresAt > new Date()) {
    try { ref = parseInvitationRef(JSON.parse(binding.value)); }
    catch { /* A malformed server binding cannot authorize signup. */ }
  }
  const clean = async () => {
    const mappings = await db.select().from(verification).where(eq(verification.identifier, loginCodeLinkIdentifier(token)));
    await db.delete(verification).where(inArray(verification.identifier, [
      identifier, browserBindingIdentifier(token), magicLinkNextIdentifier(token), loginCodeLinkIdentifier(token), ...mappings.map(row => loginCodeIdentifier(row.value)),
    ]));
  };
  const auth = await getAuth();
  const verify = (connection?: Db) => verifiedEmailLogin.run(proof, () =>
    (connection ? bindAuthToDatabase(auth, connection) : auth).api.magicLinkVerify({ query: { token }, headers: request.headers, request, asResponse: true }));
  const verifyWithMemberLock = async () => {
    const [member] = email ? await db.select({ id: user.id }).from(user).where(eq(user.email, email)) : [];
    if (!member) return verify();
    return db.transaction(async tx => {
      await lockSigningMember(tx, member.id);
      return verify(tx);
    });
  };
  let res: Response;
  try {
    res = await (binding ? magicLinkInvitationContext.run({ ref }, verifyWithMemberLock) : verifyWithMemberLock());
  } catch (error) {
    if (error instanceof SigningError) {
      await clean();
      return invalid;
    }
    if (!isAPIError(error)) throw error;
    if (error.body?.code === "INVITATION_REQUIRED") {
      await clean();
      return { kind: "invitation_unavailable" };
    }
    await clean();
    return invalid;
  }
  if (res.status !== 200) {
    // Better Auth relays user creation errors as a redirect from the verifier.
    const location = res.headers.get("location");
    const reason = location && URL.parse(location, request.url)?.searchParams.get("error");
    if (reason === "INVITATION_REQUIRED") {
      await clean();
      return { kind: "invitation_unavailable" };
    }
    await clean();
    return invalid;
  }
  const body = await res.json() as { user?: { id?: unknown } };
  if (typeof body.user?.id !== "string") return invalid;
  // Retain hashes for the token and its owner, without raw IDs or destinations.
  await db.insert(verification).values({ id: randomUUID(), identifier: magicLinkUsedIdentifier(token), value: magicLinkOwnerHash(body.user.id), expiresAt: new Date(credential.expiresAt.getTime() + 86_400_000) });
  const headers = new Headers(LOGIN_HEADERS);
  for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  clearLoginCodeCookies(request, headers);
  const next = await readMagicLinkNext(db, token);
  await clean();
  const current = readInvitationCookie(request);
  if (sameInvitation(current, ref) || (!binding && current?.kind === "individual"
    && await usedSignupInvitation(db, body.user.id, current))) {
    clearInvitationCookie(request, headers);
  }
  const profile = await getProfile(db, body.user.id);
  if (profile) clearReadingReturn(request, headers);
  const ui = negotiateUiLocale(request, enabledLangs(), null);
  if (profile && (ui.source === "cookie" || ui.source === "accept-language")) {
    await rememberUiLocale(db, body.user.id, profile.uiLocale, ui.locale);
  }
  // Login may introduce an account language unknown to the guest's client runtime.
  const savedUi = negotiateUiLocale(request, enabledLangs(), profile?.uiLocale ?? null);
  const response = (savedUi.locale !== ui.locale ? redirectDocument : redirect)(profile ? next : next === "/" ? "/onboarding" : `/onboarding?${new URLSearchParams({ next })}`, { status: 303, headers });
  return { kind: "ok", response };
}
