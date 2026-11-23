import { seedRateLimit } from "./helpers/fixtures";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { completeMagicLink, magicLinkUsedIdentifier } from "~/lib/auth/complete-magic-link.server";
import { getAuth } from "~/lib/auth/auth.server";
import { prepareLoginCode } from "~/lib/auth/login-code-cookie.server";
import { issueLoginCode, loginCodeIdentifier } from "~/lib/auth/login-code.server";
import { browserBindingIdentifier } from "~/lib/auth/magic-link-browser.server";
import { magicLinkNextIdentifier } from "~/lib/auth/magic-link-next.server";
import { magicLinkReauthenticationIdentifier } from "~/lib/auth/login-method.server";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { account, passkey, session, verification } from "~/lib/db/schema";
import * as signing from "~/lib/signing.server";
import { action as loginAction } from "~/routes/login";
import { action as inviteAction } from "~/routes/invite";
import { action as mcpAction } from "~/routes/mcp-login";
import { action as settingsAction, loader as settingsLoader } from "~/routes/settings";
import { passkeyRegistrationOptions, verifyPasskeyRegistration } from "~/lib/auth/passkeys.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { signingCredential } from "./helpers/signing";
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); });
afterAll(() => h.restore());

async function prepareCode(email: string, reauthentication = false) {
  const token = await h.issueLink(email, "/settings", { reauthentication });
  const pending = prepareLoginCode(h.request("/login", { headers: { cookie: h.linkCookie(token) } }), email);
  const code = await issueLoginCode(h.db, { id: pending.id, email, token, nonce: pending.browser.nonce, secret: "test-secret-0123456789abcdef0123456789abcdef" });
  return { token, code, cookie: [h.linkCookie(token), pending.cookie.split(";")[0], pending.emailCookie.split(";")[0]].join("; ") };
}

async function prepareReauthenticationCode(as: string) {
  const { code, cookie } = await prepareCode(as + "@example.com");
  const oldHeaders = h.request("/", { as }).headers;
  const auth = await getAuth();
  const source = (await auth.api.getSession({ headers: oldHeaders }))!.session.id;
  const submit = () => loginAction(h.args(h.request("/login?reauth=1", { form: { intent: "login-code", reauth: "1", code }, headers: { cookie: oldHeaders.get("cookie") + "; " + cookie } })));
  return { auth, oldHeaders, source, submit };
}

it("replaces just the current browser session after email code reauthentication", async () => {
  const as = "email_reauth";
  const userId = await h.signIn(as);
  const deviceToken = await h.issueLink(as + "@example.com");
  const deviceLogin = await (await getAuth()).api.magicLinkVerify({ query: { token: deviceToken }, headers: new Headers(), asResponse: true });
  const deviceCookie = deviceLogin.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))!.split(";")[0];
  const { auth, oldHeaders, source, submit } = await prepareReauthenticationCode(as);
  const response = await submit() as Response;
  expect(response.status).toBe(303);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))!.split(";")[0];
  const current = await auth.api.getSession({ headers: new Headers({ cookie }) });
  expect(current).toMatchObject({ user: { id: userId } });
  expect(current!.session.id).not.toBe(source);
  expect(await auth.api.getSession({ headers: oldHeaders })).toBeNull();
  expect((await h.outcome(() => settingsLoader(h.args(h.request("/settings", { as }))))).location).toContain("/login");
  expect(await auth.api.getSession({ headers: new Headers({ cookie: deviceCookie }) })).toMatchObject({ user: { id: userId } });
});

it("keeps the source session when the replacement cannot be inserted", async () => {
  const as = "email_session_rollback";
  await h.signIn(as);
  const { auth, oldHeaders, source, submit } = await prepareReauthenticationCode(as);
  await h.db.execute(sql`alter table session add constraint fixture_reject_email_code check (login_method <> 'email_code') not valid`);
  try {
    await expect(submit()).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await auth.api.getSession({ headers: oldHeaders })).toMatchObject({ session: { id: source } });
    expect(await h.db.select({ id: session.id }).from(session).where(eq(session.userId, h.ids[as]))).toEqual([{ id: source }]);
  } finally {
    await h.db.execute(sql`alter table session drop constraint fixture_reject_email_code`);
  }
});

it("honors credential revocation from settings and accepts freshly issued login credentials", async () => {
  const as = "settings_revocation";
  const id = await h.signIn(as);
  const registered = await signingCredential(h.db, id);
  const registrationKey = await signingCredential(h.db, id, { enroll: false });
  await h.db.insert(account).values({ id: "settings-google-fixture", accountId: "fixture-subject", providerId: "google", userId: id });
  const [source] = await h.db.select({ id: session.id }).from(session).where(eq(session.userId, id));
  const registration = await passkeyRegistrationOptions(h.db, id, source.id, "Replacement");
  const pending = await prepareCode(as + "@example.com", true);
  const reauthenticationMarker = eq(verification.identifier, magicLinkReauthenticationIdentifier(hashMagicLinkToken(pending.token)));
  expect(await h.db.$count(verification, reauthenticationMarker)).toBe(1);
  await h.signIn("settings_revocation_other");
  const other = await prepareCode("settings_revocation_other@example.com");
  const submit = ({ code, cookie }: Awaited<ReturnType<typeof prepareCode>>) =>
    h.outcome(() => loginAction(h.args(h.request("/login", { form: { intent: "login-code", code }, headers: { cookie } }))));
  const revoke = h.request("/settings", { as, form: { intent: "revoke-login-credentials" } });
  expect(await h.outcome(() => settingsAction(h.args(revoke)))).toMatchObject({ status: 303, location: "/login" });
  expect((await submit(pending)).status).toBe(400);
  const confirm = h.request("/auth/confirm", { form: { token: pending.token }, headers: { cookie: pending.cookie } });
  expect(await completeMagicLink(confirm, pending.token)).toEqual({ kind: "invalid" });
  expect(await h.db.$count(verification, reauthenticationMarker)).toBe(0);
  expect(await (await getAuth()).api.getSession({ headers: revoke.headers })).toBeNull();
  expect(await h.db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, id))).toEqual([{ id: registered.id }]);
  expect(await h.db.select({ id: account.id }).from(account).where(eq(account.userId, id))).toEqual([{ id: "settings-google-fixture" }]);
  expect((await submit(other)).status).toBe(303);

  const fresh = await submit(await prepareCode(as + "@example.com"));
  expect(fresh.status).toBe(303);
  const [renewed] = await h.db.select({ id: session.id }).from(session).where(eq(session.userId, id));
  await expect(verifyPasskeyRegistration(h.db, id, renewed.id, registration.challenge, registrationKey.register(registration.options.challenge)))
    .rejects.toMatchObject({ code: "invalid_registration_challenge" });
});
it("rejects foreign and missing origins on code, resend, and restart POSTs at every entry", async () => {
  for (const [path, action] of [["/login", loginAction], ["/invite/unknown", inviteAction], ["/mcp/login", mcpAction]] as const) {
    for (const intent of ["login-code", "login-resend", "login-restart"]) {
      const result = await h.outcome(() => action(h.args(h.request(path, { form: { intent, code: "123456" }, headers: { origin: "https://foreign.example" } }), { token: "unknown" })));
      expect(result.status).toBe(403);
      const missing = new Request(`http://localhost:5173${path}`, { method: "POST", body: new URLSearchParams({ intent, code: "123456" }) });
      expect((await h.outcome(() => action(h.args(missing, { token: "unknown" })))).status).toBe(403);
    }
  }
});
it("enforces the auth-page IP cap on code POSTs", async () => {
  process.env.TRUSTED_PROXY_HOPS = "1";
  try {
    const { AUTH_PAGE_IP_LIMIT } = await import("~/lib/rate-limit.server");
    const req = () => h.request("/login", { form: { intent: "login-code", code: "123456" }, headers: { "x-forwarded-for": "198.51.100.61" } });
    await seedRateLimit(h.db, "ip:auth-page:198.51.100.61", AUTH_PAGE_IP_LIMIT);
    expect((await h.outcome(() => loginAction(h.args(req())))).status).toBe(429);
  } finally { delete process.env.TRUSTED_PROXY_HOPS; }
});

it("code and link racing on separate connections create exactly one session", async () => {
  const { prepareLoginCode } = await import("~/lib/auth/login-code-cookie.server");
  const { issueLoginCode } = await import("~/lib/auth/login-code.server");
  const { action: confirmAction } = await import("~/routes/auth-confirm");
  const { user } = await import("~/lib/db/schema");
  const token = await h.issueLink("race@example.com", "/settings?race=1");
  const pending = prepareLoginCode(h.request("/login", { headers: { cookie: h.linkCookie(token) } }), "race@example.com");
  const code = await issueLoginCode(h.db, { id: pending.id, email: "race@example.com", token, nonce: pending.browser.nonce, secret: "test-secret-0123456789abcdef0123456789abcdef" });
  const cookie = `${h.linkCookie(token)}; ${pending.cookie.split(";")[0]}`;
  const results = await Promise.all([
    h.outcome(() => loginAction(h.args(h.request("/login", { form: { intent: "login-code", code }, headers: { cookie } })))),
    h.outcome(() => confirmAction(h.args(h.request("/auth/confirm", { form: { token }, headers: { cookie } })))),
  ]);
  expect(results.map(r => r.status).sort()).toEqual([303, 400]);
  const [member] = await h.db.select().from(user).where(eq(user.email, "race@example.com"));
  expect(await h.db.select().from(session).where(eq(session.userId, member.id))).toHaveLength(1);
});

it("records a verified code and clears a pending code and its link when passkey-only login is enabled", async () => {
  const { setPasskeyOnly } = await import("~/lib/auth/passkeys.server");
  const { issuePasskeySession } = await import("~/lib/auth/auth.server");
  const { action: confirm } = await import("~/routes/auth-confirm");
  const email = "code_method@example.com";
  const userId = await h.signIn("code_method");
  const issue = async () => {
    const token = await h.issueLink(email);
    const pending = prepareLoginCode(h.request("/login", { headers: { cookie: h.linkCookie(token) } }), email);
    const code = await issueLoginCode(h.db, { id: pending.id, email, token, nonce: pending.browser.nonce, secret: "test-secret-0123456789abcdef0123456789abcdef" });
    return { id: pending.id, token, code, cookie: `${h.linkCookie(token)}; ${pending.cookie.split(";")[0]}` };
  };
  const submit = ({ code, cookie }: Awaited<ReturnType<typeof issue>>) => h.outcome(() => loginAction(h.args(h.request("/login", { form: { intent: "login-code", code }, headers: { cookie } }))));
  expect((await submit(await issue())).status).toBe(303);
  const confirmed = (await h.db.select().from(session).where(eq(session.userId, userId))).find(row => row.loginMethod === "email_code");
  expect(confirmed).toMatchObject({ reauthenticationMethod: "email_code", reauthenticatedAt: expect.any(Date) });
  const pending = await issue();
  await signingCredential(h.db, userId, { counterZero: true });
  await h.db.update(session).set({ loginMethod: "passkey", reauthenticationMethod: "passkey" }).where(eq(session.id, confirmed!.id));
  const auth = await getAuth();
  await setPasskeyOnly(h.db, userId, confirmed!.id, true, (tx, at) => issuePasskeySession(auth, tx, userId, at));
  expect((await submit(pending)).status).toBe(400);
  expect((await h.outcome(() => confirm(h.args(h.request("/auth/confirm", { form: { token: pending.token }, headers: { cookie: pending.cookie } }))))).status).toBe(400);
  expect(await h.db.$count(verification, eq(verification.identifier, loginCodeIdentifier(pending.id)))).toBe(0);
  expect(await h.db.select().from(session).where(eq(session.userId, userId))).toMatchObject([{ loginMethod: "passkey" }]);
});

it("treats a member lock SigningError as an invalid magic link and clears the bindings", async () => {
  const email = "lock_failed@example.com";
  const userId = await h.signIn("lock_failed");
  const token = await h.issueLink(email, "/settings");
  const bindings = inArray(verification.identifier, [browserBindingIdentifier(token), magicLinkNextIdentifier(token)]);
  expect(await h.db.$count(verification, bindings)).toBe(2);
  const lock = vi.spyOn(signing, "lockSigningMember").mockRejectedValueOnce(new signing.SigningError("not_a_member"));
  try {
    const request = h.request("/auth/confirm", { form: { token }, headers: { cookie: h.linkCookie(token) } });
    expect(await completeMagicLink(request, token)).toEqual({ kind: "invalid" });
    expect(lock).toHaveBeenCalledExactlyOnceWith(expect.anything(), userId);
    expect(await h.db.$count(verification, bindings)).toBe(0);
    expect(await h.db.$count(verification, eq(verification.identifier, magicLinkUsedIdentifier(token)))).toBe(0);
    expect(await h.db.$count(session, eq(session.userId, userId))).toBe(1);
  } finally {
    lock.mockRestore();
  }
});
