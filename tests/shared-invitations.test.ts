import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { invitationCookie, readInvitationCookie } from "~/lib/auth/invitation-cookie.server";
import { addressHasher, createMagicLinkSender, magicLinkOutcome, sharedInvitationContext, type MagicLinkOutcome } from "~/lib/auth/magic-link.server";
import { authSecret } from "~/lib/auth/secret.server";
import { profiles, rateLimits, sharedInvitations, suspendedEmailHashes, user } from "~/lib/db/schema";
import { addMember, createTestDb } from "./helpers/db";
import { suspendedEmailHash } from "~/lib/suspended-email.server";
import { createSharedInvitation } from "~/lib/shared-invitations.server";
import { MAGIC_LINK_EMAIL_IP_LIMIT, MAGIC_LINK_IP_LIMIT } from "~/lib/rate-limit.server";
import { action as invitesAction } from "~/routes/invites-new";
import { action as sharedAction, headers as sharedHeaders, loader as sharedLoader } from "~/routes/invites-shared";
import { action as adminAction } from "~/routes/admin-invitations";
import { seedRateLimit } from "./helpers/fixtures";
import { setupRouteHarness } from "./helpers/route-harness";
import { expectModerationReauthentication, withStaleSession } from "./helpers/reauth";

afterEach(() => { vi.unstubAllEnvs(); });

const BASE = "http://localhost:5173";
const issuer = { id: "link_operator", email: "link_operator@example.com" };

function linkForm(label: string) {
  const form = new FormData();
  form.set("label", label);
  form.set("maxUses", "1");
  form.set("ttlDays", "14");
  return form;
}

it("keeps legacy individual cookie bytes compatible and authenticates the shared kind", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const request = new Request(BASE);
  const shared = invitationCookie(request, { kind: "shared", id }).split(";")[0];
  const individual = invitationCookie(request, { kind: "individual", id }).split(";")[0];
  const read = (cookie: string) => readInvitationCookie(new Request(BASE, { headers: { cookie } }));
  expect(individual).toMatch(/^tomola\.invitation=12345678-/);
  expect(read(individual)).toEqual({ kind: "individual", id });
  expect(read(shared)).toEqual({ kind: "shared", id });
  expect(read(shared.replace("s:", ""))).toBeNull();
  expect(read(individual.replace("=", "=s:"))).toBeNull();
  expect(read(`${individual}; ${shared}`)).toBeNull();
});

it("returns 404 for member reads and shared writes under both invitation policies", async () => {
  vi.stubEnv("OPERATOR_EMAILS", issuer.email);
  const h = await setupRouteHarness();
  try {
    const as = "regular_inviter";
    await h.signIn(as);
    for (const setting of ["", "1"]) {
      vi.stubEnv("OPERATOR_ONLY_INVITATIONS", setting);
      expect((await h.outcome(() => sharedLoader(h.args(h.request("/invites/shared", { as }))))).status).toBe(404);
      for (const intent of ["create-shared", "revoke-shared"]) {
        const post = (path: string) => h.args(h.request(path, { as, form: { intent, label: "Example", maxUses: "10", ttlDays: "1" } }));
        expect((await h.outcome(() => sharedAction(post("/invites/shared")))).status).toBe(404);
        expect((await h.outcome(() => invitesAction(post("/invites/new")))).status).toBe(404);
        expect((await h.outcome(() => adminAction(post("/admin/invitations")))).status).toBe(404);
      }
    }
    expect(sharedHeaders()).toEqual({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
  } finally { h.restore(); }
});

it("redirects both legacy operator submissions without creating or revoking a link", async () => {
  vi.stubEnv("OPERATOR_EMAILS", issuer.email);
  const h = await setupRouteHarness();
  try {
    const as = issuer.id;
    const id = await h.signIn(as);
    const created = await createSharedInvitation(h.db, { id, email: issuer.email }, linkForm("Existing link"));
    if (created.error) throw new Error(created.error);
    await withStaleSession(h, as, async () => {
      const forms: Record<string, string>[] = [
        { intent: "create-shared", label: "Legacy link", maxUses: "1", ttlDays: "14" },
        { intent: "revoke-shared", id: created.id },
      ];
      for (const form of forms) {
        const response = await invitesAction(h.args(h.request("/invites/new", { as, form })));
        expect(response).toBeInstanceOf(Response);
        expect(response).toMatchObject({ status: 303 });
        if (response instanceof Response) expect(response.headers.get("Location")).toBe("/invites/shared");
      }
    });
    expect(await h.db.select({ id: sharedInvitations.id, revokedAt: sharedInvitations.revokedAt }).from(sharedInvitations))
      .toEqual([{ id: created.id, revokedAt: null }]);
    expect(await h.db.select({ count: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, `member:shared-invitation:${id}`)))
      .toEqual([{ count: 1 }]);
  } finally { h.restore(); }
});

it("requires a fresh operator session for shared writes and a writer for creation", async () => {
  vi.stubEnv("OPERATOR_EMAILS", issuer.email);
  const h = await setupRouteHarness();
  try {
    const as = issuer.id;
    const id = await h.signIn(as);
    const post = (form: Record<string, string>) => h.outcome(() => sharedAction(h.args(h.request("/invites/shared", { as, form }))));
    const create = { intent: "create-shared", label: "New link", maxUses: "1", ttlDays: "14" };
    const created = await createSharedInvitation(h.db, { id, email: issuer.email }, linkForm("Existing link"));
    if (created.error) throw new Error(created.error);
    const revoke = { intent: "revoke-shared", id: created.id };

    await withStaleSession(h, as, async () => {
      expectModerationReauthentication(await post(create), "/invites/shared");
      expectModerationReauthentication(await post(revoke), "/invites/shared");
    });
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(profiles.userId, id));
    expect(await post(create)).toMatchObject({ status: 302, location: "/suspended" });
    expect(await h.db.select({ id: sharedInvitations.id, revokedAt: sharedInvitations.revokedAt }).from(sharedInvitations))
      .toEqual([{ id: created.id, revokedAt: null }]);
    expect(await post(revoke)).toMatchObject({ status: 200 });
    expect(await h.db.select({ revokedAt: sharedInvitations.revokedAt }).from(sharedInvitations))
      .toEqual([{ revokedAt: expect.any(Date) }]);
  } finally { h.restore(); }
});

it("charges the operator's allowance only for successful creation and never stores raw tokens", async () => {
  vi.stubEnv("OPERATOR_EMAILS", issuer.email);
  const db = await createTestDb();
  await addMember(db, issuer.id, issuer.id, { email: issuer.email });
  const now = new Date();
  const bad = linkForm("bad\nlabel");
  const missingVillage = linkForm("Valid label");
  missingVillage.set("villageId", "missing");
  expect(await createSharedInvitation(db, issuer, bad, now)).toEqual({ error: "invalid" });
  expect(await createSharedInvitation(db, issuer, missingVillage, now)).toEqual({ error: "invalid_village" });
  for (let index = 0; index < 10; index++) {
    const created = await createSharedInvitation(db, issuer, linkForm(` Example ${index} `), now);
    expect(created.error).toBeNull();
    if (created.error) throw new Error(created.error);
    const [row] = await db.select().from(sharedInvitations).where(eq(sharedInvitations.id, created.id));
    expect(row.label).toBe(`Example ${index}`);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.token);
  }
  expect(await createSharedInvitation(db, issuer, linkForm("One more"), now)).toEqual({ error: "rate_limited" });
  expect(await db.select({ count: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, `member:shared-invitation:${issuer.id}`))).toEqual([{ count: 10 }]);
});

it("uses the same observed outcome and one awaited delivery for new, existing, and held addresses", async () => {
  const db = await createTestDb();
  const now = new Date();
  await db.insert(sharedInvitations).values({ id: "delivery-link", tokenHash: "fixture", label: "Delivery", createdBy: issuer.id, maxUses: 10, expiresAt: new Date(now.getTime() + 86_400_000) });
  await db.insert(user).values({ id: "existing", name: "", email: "existing@example.com" });
  await db.insert(suspendedEmailHashes).values({ hash: suspendedEmailHash("held@example.com"), expiresAt: new Date(now.getTime() + 36_000_000) });
  let delivered = false;
  const mail = vi.fn(async () => { await new Promise(resolve => setImmediate(resolve)); delivered = true; });
  const isKnown = vi.fn(async () => false);
  const send = createMagicLinkSender({ db, baseURL: BASE, secret: authSecret(), now: () => now, isKnown, decoyTo: () => "decoy@example.invalid",
    mailer: () => ({ kind: "memory", from: "test@example.com", send: mail }) });
  for (const [email, to] of [["fresh@example.com", "fresh@example.com"], ["existing@example.com", "existing@example.com"], ["held@example.com", "decoy@example.invalid"]]) {
    delivered = false;
    const outcome: MagicLinkOutcome = {};
    await sharedInvitationContext.run("delivery-link", () => magicLinkOutcome.run(outcome, () => send({ email, token: randomBytes(24).toString("base64url"), url: BASE })));
    expect(outcome.result).toBe("sent");
    expect(delivered).toBe(true);
    expect(mail).toHaveBeenLastCalledWith(expect.objectContaining({ to }));
  }
  expect(mail).toHaveBeenCalledTimes(3);
  expect(isKnown).not.toHaveBeenCalled();
});

async function deliver(send: ReturnType<typeof createMagicLinkSender>, link: string | null, email: string, ip: string) {
  const outcome: MagicLinkOutcome = {};
  const headers = new Headers({ "x-forwarded-for": ip });
  await sharedInvitationContext.run(link, () => magicLinkOutcome.run(outcome, () => send({ email, url: BASE, token: randomBytes(24).toString("base64url") }, { headers })));
  return outcome.result;
}

it("gives shared links and ordinary delivery separate allowances on the same source", async () => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  const db = await createTestDb();
  const now = new Date("2026-01-01T00:00:01Z");
  const ip = "198.51.100.30";
  const ipKey = eq(rateLimits.key, `magic-link:ip:${ip}`);
  await db.insert(sharedInvitations).values(["workshop", "second-workshop"].map(id => ({
    id, tokenHash: id, label: id, createdBy: issuer.id, maxUses: 10, expiresAt: new Date("2026-01-02T00:00:00Z"),
  })));
  const mail = vi.fn(async () => {});
  const send = createMagicLinkSender({ db, baseURL: BASE, secret: authSecret(), now: () => now, isKnown: async () => true,
    mailer: () => ({ kind: "memory", from: "test@example.com", send: mail }) });

  for (let i = 1; i <= 30; i++) expect(await deliver(send, "workshop", `guest-${i}@example.com`, ip)).toBe("sent");
  expect(await deliver(send, "workshop", "next-guest@example.com", ip)).toBe("later");
  expect(await db.$count(rateLimits, ipKey)).toBe(0);
  for (let i = 1; i <= 20; i++) expect(await deliver(send, null, `member-${i}@example.com`, ip)).toBe("sent");
  expect(await deliver(send, null, "next-member@example.com", ip)).toBe("later");
  expect(await deliver(send, "second-workshop", "other-guest@example.com", ip)).toBe("sent");
  expect(await db.select({ count: rateLimits.count }).from(rateLimits).where(ipKey)).toEqual([{ count: 21 }]);
  expect(mail).toHaveBeenCalledTimes(51);
});

it("applies the source sending allowance to unavailable shared links", async () => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  const db = await createTestDb();
  const now = new Date("2026-01-01T00:00:01Z");
  const expiresAt = new Date("2026-01-02T00:00:00Z");
  const fixture = { createdBy: issuer.id, maxUses: 1, expiresAt };
  await db.insert(sharedInvitations).values([
    { ...fixture, id: "expired", tokenHash: "expired", label: "Expired", expiresAt: now },
    { ...fixture, id: "revoked", tokenHash: "revoked", label: "Revoked", revokedAt: now },
    { ...fixture, id: "full", tokenHash: "full", label: "Full", usedCount: 1 },
  ]);
  const mail = vi.fn(async () => {});
  const send = createMagicLinkSender({ db, baseURL: BASE, secret: authSecret(), now: () => now,
    mailer: () => ({ kind: "memory", from: "test@example.com", send: mail }) });

  for (const [i, link] of ["missing", "expired", "revoked", "full"].entries()) {
    const ip = `198.51.100.${i + 1}`;
    const key = `magic-link:ip:${ip}`;
    await seedRateLimit(db, key, { ...MAGIC_LINK_IP_LIMIT, limit: 19 }, now);
    expect(await deliver(send, link, `first-${link}@example.com`, ip)).toBe("invitation_unavailable");
    expect(await deliver(send, link, `second-${link}@example.com`, ip)).toBe("later");
    expect(await db.select({ count: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, key))).toEqual([{ count: 21 }]);
  }
  expect(mail).not.toHaveBeenCalled();
});

it("caps shared delivery across links and sources while sharing the usual address allowances", async () => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  const db = await createTestDb();
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  let now = new Date(hour + 1_000);
  await db.insert(sharedInvitations).values(["delivery-a", "delivery-b"].map(id => ({
    id, tokenHash: id, label: id, createdBy: issuer.id, maxUses: 2, expiresAt: new Date(hour + 86_400_000),
  })));
  const secret = authSecret();
  const mail = vi.fn(async () => {});
  const send = createMagicLinkSender({ db, baseURL: BASE, secret, now: () => now, isKnown: async () => true,
    mailer: () => ({ kind: "memory", from: "test@example.com", send: mail }) });
  let source = 0;
  const nextSource = (email: string, link: string | null) => deliver(send, link, email, `198.51.100.${++source}`);
  for (const minutes of [0, 15]) {
    now = new Date(hour + minutes * 60_000 + 1_000);
    for (const link of ["delivery-a", "delivery-b", "delivery-b"]) expect(await nextSource("capped@example.com", link)).toBe("sent");
    expect(await nextSource("capped@example.com", "delivery-a")).toBe("later");
  }
  now = new Date(hour + 30 * 60_000);
  expect(await nextSource("capped@example.com", "delivery-a")).toBe("later");
  for (let i = 0; i < 28; i++) expect(await nextSource(`link_cap_${i}@example.com`, "delivery-a")).toBe("sent");
  expect(await nextSource("link_capped@example.com", "delivery-a")).toBe("later");

  const address = "standard_cap@example.com";
  const hash = addressHasher(secret)(address);
  await db.insert(rateLimits).values({ key: `magic-link:email:${hash}`, count: 28, windowStart: new Date(hour), expiresAt: new Date(hour + 3_600_000) });
  expect(await nextSource(address, null)).toBe("sent");
  expect(await nextSource(address, "delivery-b")).toBe("sent");
  expect(await nextSource(address, null)).toBe("later");
  expect(await nextSource(address, "delivery-b")).toBe("later");

  const pairAddress = "standard_pair_cap@example.com";
  const ip = "198.51.100.100";
  const pair = addressHasher(secret)(`${pairAddress}:${ip}`);
  await seedRateLimit(db, `magic-link:email-ip:${pair}`, MAGIC_LINK_EMAIL_IP_LIMIT, now);
  expect(await deliver(send, "delivery-b", pairAddress, ip)).toBe("later");
  expect(await nextSource(pairAddress, "delivery-b")).toBe("sent");
});
