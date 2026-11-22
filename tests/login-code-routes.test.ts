import { seedRateLimit } from "./helpers/fixtures";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { completeMagicLink, magicLinkUsedIdentifier } from "~/lib/auth/complete-magic-link.server";
import { browserBindingIdentifier } from "~/lib/auth/magic-link-browser.server";
import { magicLinkNextIdentifier } from "~/lib/auth/magic-link-next.server";
import { session, verification } from "~/lib/db/schema";
import * as signing from "~/lib/signing.server";
import { action as loginAction } from "~/routes/login";
import { action as inviteAction } from "~/routes/invite";
import { action as mcpAction } from "~/routes/mcp-login";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); });
afterAll(() => h.restore());
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
  const { prepareLoginCode } = await import("~/lib/auth/login-code-cookie.server");
  const { issueLoginCode } = await import("~/lib/auth/login-code.server");
  const { setPasskeyOnly } = await import("~/lib/auth/passkeys.server");
  const { getAuth, issuePasskeySession } = await import("~/lib/auth/auth.server");
  const { action: confirm } = await import("~/routes/auth-confirm");
  const { signingCredential } = await import("./helpers/signing");
  const email = "code_method@example.com";
  const userId = await h.signIn("code_method");
  const issue = async () => {
    const token = await h.issueLink(email);
    const pending = prepareLoginCode(h.request("/login", { headers: { cookie: h.linkCookie(token) } }), email);
    const code = await issueLoginCode(h.db, { id: pending.id, email, token, nonce: pending.browser.nonce, secret: "test-secret-0123456789abcdef0123456789abcdef" });
    return { token, code, cookie: `${h.linkCookie(token)}; ${pending.cookie.split(";")[0]}` };
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
  expect((await h.db.select().from(verification)).filter(row => row.identifier.startsWith("magic-link-code:"))).toEqual([]);
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
