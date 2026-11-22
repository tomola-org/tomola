import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { completeAccountDeletion, deleteAccount, requestAccountDeletion } from "~/lib/account-delete.server";
import { createAuth } from "~/lib/auth/auth.server";
import { invitationCookie } from "~/lib/auth/invitation-cookie.server";
import { magicLinkInvitationContext, magicLinkInvitationIdentifier, type InvitationRef } from "~/lib/auth/invitation-ref.server";
import { authSecret } from "~/lib/auth/secret.server";
import { migrationsFolder, type Db } from "~/lib/db/client.server";
import { invitations, profiles, sharedInvitations, sharedInvitationUses, user, verification, villageMembers, villages } from "~/lib/db/schema";
import { createInvitation, findValidInvitationByToken, markInvitationUsed } from "~/lib/invitations.server";
import { createProfile } from "~/lib/profiles.server";
import { createSharedInvitation, findSharedInvitation } from "~/lib/shared-invitations.server";
import { signupInvitationIdentifier } from "~/lib/signup-village.server";
import { addMember } from "./helpers/db";
import { acceptTrialFixture } from "./helpers/trial";
import { migrationsBefore } from "./helpers/migrations";
import { holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

const BASE = "http://localhost:5173";
const operator = { id: "shared_issuer", email: "shared_issuer@example.com" };

function input(label: string, maxUses = 1, villageId?: string) {
  const form = new FormData();
  form.set("label", label);
  form.set("maxUses", String(maxUses));
  form.set("ttlDays", "14");
  if (villageId) form.set("villageId", villageId);
  return form;
}

function authFor(db: Db) {
  const tokens = new Map<string, string>();
  const auth = createAuth(db, { baseURL: BASE, secret: authSecret(), sendMagicLink: async ({ email, token }) => { tokens.set(email, token); } });
  return {
    async issue(email: string, ref?: InvitationRef) {
      await auth.api.signInMagicLink({ body: { email, metadata: { invitationRef: ref } }, headers: new Headers() });
      return tokens.get(email)!;
    },
    async verify(token: string, ref?: InvitationRef, cookie?: string) {
      const headers = new Headers(cookie ? { cookie } : {});
      const verify = () => auth.api.magicLinkVerify({ query: { token }, headers, asResponse: true });
      return ref ? magicLinkInvitationContext.run({ ref }, verify) : verify();
    },
  };
}

describe.skipIf(!REAL_PG_URL)("shared invitation registration on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  let db: Db;
  let seq = 0;
  beforeAll(async () => {
    scratch = await createScratchDb();
    db = await scratch.open("shared-test");
    await addMember(db, operator.id, operator.id, { homeArea: "other" });
  }, 60_000);
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => { await scratch?.drop(); });

  async function link(maxUses = 1, villageId?: string, issuer = operator) {
    vi.stubEnv("OPERATOR_EMAILS", issuer.email);
    const result = await createSharedInvitation(db, issuer, input(`Link ${++seq}`, maxUses, villageId), new Date(Date.now() + seq * 1000));
    expect(result.error).toBeNull();
    if (result.error) throw new Error(result.error);
    expect(await findSharedInvitation(db, { token: result.token })).toMatchObject({ id: result.id });
    return { kind: "shared" as const, id: result.id };
  }

  async function counts(ref: InvitationRef, count: number) {
    expect(await findSharedInvitation(db, ref)).toMatchObject({ usedCount: count });
    const uses = await db.select().from(sharedInvitationUses).where(eq(sharedInvitationUses.linkId, ref.id));
    expect(uses).toHaveLength(count);
    return uses;
  }

  it.each([false, true])("serializes competing user inserts (same address: %s)", async sameEmail => {
    const ref = await link(sameEmail ? 2 : 1);
    const a = authFor(await scratch.open("shared-verify-a"));
    const b = authFor(await scratch.open("shared-verify-b"));
    const emailA = sameEmail ? "single_address@example.com" : "last_slot_a@example.com";
    const emailB = sameEmail ? emailA : "last_slot_b@example.com";
    const [tokenA, tokenB] = await Promise.all([a.issue(emailA, ref), b.issue(emailB, ref)]);
    expect(await db.select().from(verification).where(eq(verification.identifier, magicLinkInvitationIdentifier(tokenA))))
      .toMatchObject([{ value: JSON.stringify(ref) }]);

    const blocker = holdTx(await scratch.open(), tx => tx.execute('lock table "user" in share mode'));
    await blocker.ready;
    const confirmations = Promise.allSettled([a.verify(tokenA, ref), b.verify(tokenB, ref)]);
    const admin = await scratch.admin();
    try {
      await Promise.all([waitForLockWait(admin, "shared-verify-a"), waitForLockWait(admin, "shared-verify-b")]);
    } finally { await blocker.commit(); await admin.end(); }
    const outcomes = await confirmations;
    const responses = outcomes.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    if (!sameEmail) expect(responses.find(response => response.status !== 200)?.headers.get("location")).toContain("error=INVITATION_REQUIRED");
    const [created] = await db.select().from(user).where(inArray(user.email, [emailA, emailB]));
    expect(await db.select().from(user).where(inArray(user.email, [emailA, emailB]))).toHaveLength(1);
    expect(await counts(ref, 1)).toMatchObject([{ usedBy: created.id }]);
  });

  it("rejects a closed or malformed shared invitation without using an individual invitation for the email", async () => {
    const ref = await link();
    const email = "shared_fallback@example.com";
    const individual = await createInvitation(db, { email });
    const cookie = invitationCookie(new Request(BASE), { kind: "individual", id: individual.id }).split(";")[0];
    await db.update(sharedInvitations).set({ revokedAt: new Date() }).where(eq(sharedInvitations.id, ref.id));
    const auth = authFor(db);
    const bound = await auth.verify(await auth.issue(email, ref), ref, cookie);
    expect(bound.headers.get("location")).toContain("error=INVITATION_REQUIRED");
    const sharedCookie = invitationCookie(new Request(BASE), ref).split(";")[0];
    const malformed = await auth.verify(await auth.issue(email), undefined, `${sharedCookie}altered`);
    expect(malformed.headers.get("location")).toContain("error=INVITATION_REQUIRED");
    expect(await findValidInvitationByToken(db, individual.token)).not.toBeNull();
    expect(await db.select().from(user).where(eq(user.email, email))).toEqual([]);
    await counts(ref, 0);
  });

  it("leaves the link and its usage history untouched after a rejected user INSERT", async () => {
    const ref = await link();
    const admin = await scratch.admin();
    const email = "rejected_insert@example.com";
    await admin.query(`alter table "user" add constraint reject_fixture_registration check (email <> '${email}')`);
    try {
      const auth = authFor(await scratch.open());
      const token = await auth.issue(email, ref);
      await expect(auth.verify(token, ref)).rejects.toThrow();
      expect(await db.select().from(user).where(eq(user.email, email))).toEqual([]);
      await counts(ref, 0);
    } finally { await admin.query('alter table "user" drop constraint reject_fixture_registration'); await admin.end(); }
  });

  it("preserves usage after a recipient leaves and serializes link issuance with the issuer's departure", async () => {
    const issuer = { id: "leaving_issuer", email: "leaving_issuer@example.com" };
    await addMember(db, issuer.id, issuer.id, { homeArea: "other" });
    const ref = await link(2, undefined, issuer);
    const auth = authFor(db);
    const email = "leaving_recipient@example.com";
    expect((await auth.verify(await auth.issue(email, ref), ref)).status).toBe(200);
    const [recipient] = await db.select().from(user).where(eq(user.email, email));
    expect(await createProfile(db, recipient.id, { handle: "leaving_recipient", homeArea: "other" })).toMatchObject({ ok: true });
    await deleteAccount(db, recipient.id, { confirmation: "leaving_recipient" });
    expect(await counts(ref, 1)).toMatchObject([{ usedBy: null }]);

    const deletion = await requestAccountDeletion(db, issuer.id, { confirmation: issuer.id });
    const writing = await scratch.open("shared-issuing");
    expect(await createSharedInvitation(writing, issuer, input("Pending departure"))).toEqual({ error: "forbidden" });
    const admin = await scratch.admin();
    try {
      await completeAccountDeletion(await scratch.open(), deletion, {
        execute: async (mutate, lock) => {
          const held = holdTx(await scratch.open(), async tx => { await lock(tx); return mutate(tx); });
          const result = await held.ready;
          const creation = createSharedInvitation(writing, issuer, input("Concurrent link"));
          try { await waitForLockWait(admin, "shared-issuing"); }
          finally { await held.commit(); }
          expect(await creation).toEqual({ error: "forbidden" });
          return result;
        },
      });
    } finally { await admin.end(); }
    expect(await findSharedInvitation(db, ref)).toMatchObject({ createdBy: null, revokedAt: expect.any(Date), usedCount: 1 });
    expect(await db.select().from(sharedInvitations).where(eq(sharedInvitations.label, "Concurrent link"))).toEqual([]);
  });

  it.each(["deleted", "closed", "owner removed"] as const)("completes onboarding for a %s destination", async change => {
    vi.stubEnv("VILLAGES", "1");
    const name = `shifted-${seq}`;
    const [village] = await db.insert(villages).values({ slug: name, kind: "invite_public", name }).returning();
    await db.insert(villageMembers).values({ villageId: village.id, userId: operator.id, role: "owner" });
    const ref = await link(2, village.id);
    const auth = authFor(db);
    const email = `onboarding_${seq}@example.com`;
    expect((await auth.verify(await auth.issue(email, ref), ref)).status).toBe(200);
    const [member] = await db.select().from(user).where(eq(user.email, email));
    if (change === "deleted") await db.delete(villages).where(eq(villages.id, village.id));
    if (change === "closed") await db.update(villages).set({ kind: "closed" }).where(eq(villages.id, village.id));
    if (change === "owner removed") await db.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, operator.id)));
    expect(await createProfile(db, member.id, { handle: `new_member_${seq}`, homeArea: "other" })).toMatchObject({ ok: true });
    expect(await db.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, member.id)))).toEqual([]);
    await counts(ref, 1);
  });

  it("upgrades pending legacy signups and keeps individual invitation reads and writes compatible", { timeout: 60_000 }, async () => {
    vi.stubEnv("VILLAGES", "1");
    const legacy = await createScratchDb({ migrate: false });
    const before = migrationsBefore("shared_invitations");
    try {
      const old = await legacy.open();
      await migrate(old as Parameters<typeof migrate>[0], { migrationsFolder: before });
      await old.insert(user).values([
        { id: "legacy_issuer", name: "", email: "legacy_issuer@example.com" },
        { id: "legacy_waiting", name: "", email: "legacy_waiting@example.com", emailVerified: true },
      ]);
      // The legacy database predates later profile columns, so write only the columns it already had.
      await old.execute(sql`insert into profiles (user_id, handle, handle_key, home_area, read_langs) values ('legacy_issuer', 'legacy_issuer', 'legacy_issuer', 'other', array['en'])`);
      await acceptTrialFixture(old, "legacy_issuer");
      const [village] = await old.insert(villages).values({ slug: "legacy-village", kind: "invite_public", name: "Legacy village" }).returning();
      await old.insert(villageMembers).values({ userId: "legacy_issuer", villageId: village.id, role: "owner" });
      const original = await createInvitation(old, { email: "legacy_new@example.com", createdBy: "legacy_issuer", villageId: village.id });
      const waiting = await createInvitation(old, { email: "legacy_waiting@example.com", createdBy: "legacy_issuer", villageId: village.id });
      await markInvitationUsed(old, waiting.email, { usedBy: "legacy_waiting", invitationId: waiting.id });
      await old.insert(verification).values({
        id: randomUUID(), identifier: signupInvitationIdentifier("legacy_waiting"), value: waiting.id, expiresAt: new Date(Date.now() + 3600_000),
      });
      const cookie = invitationCookie(new Request(BASE), { kind: "individual", id: original.id }).split(";")[0];
      expect(cookie).toMatch(/^tomola\.invitation=[a-f0-9-]{36}\./);
      const auth = authFor(old);
      const token = await auth.issue(original.email);
      await migrate(old as Parameters<typeof migrate>[0], { migrationsFolder: migrationsFolder() });

      expect(await findValidInvitationByToken(old, original.token)).toMatchObject({ id: original.id, villageId: village.id });
      expect((await auth.verify(token, undefined, cookie)).status).toBe(200);
      const [newAccount] = await old.select().from(user).where(eq(user.email, original.email));
      for (const [id, handle] of [["legacy_waiting", "legacy_waiting"], [newAccount.id, "legacy_new"]]) {
        expect(await createProfile(old, id, { handle, homeArea: "other" })).toMatchObject({ ok: true });
        expect(await old.select().from(villageMembers).where(and(eq(villageMembers.userId, id), eq(villageMembers.villageId, village.id)))).toHaveLength(1);
      }
      expect(await old.select().from(invitations).where(eq(invitations.id, original.id))).toMatchObject([{ usedBy: newAccount.id }]);
      const after = await createInvitation(old, { email: "legacy_api@example.com" });
      expect(await markInvitationUsed(old, after.email, { invitationId: after.id })).toBe(1);
    } finally { await legacy.drop(); fs.rmSync(before, { recursive: true, force: true }); }
  });
});
