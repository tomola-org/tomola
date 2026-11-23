import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { Tx } from "~/lib/db/client.server";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { signingCredential } from "./helpers/signing";
import { finishPasskeyRecovery, passkeyRegistrationOptions, recoveryRegistrationOptions, recoverPasskeys, removeOwnPasskey, setPasskeyOnly, verifyPasskeyRegistration } from "~/lib/auth/passkeys.server";
import { jobs, passkey, passkeyRecoveries, passkeyRecoveryPermits, profiles, session, memberSignatures, signingChallenges, verification } from "~/lib/db/schema";
import { isAllowedAuthEndpoint } from "~/lib/auth/endpoints.server";
import { getAuth, issuePasskeySession } from "~/lib/auth/auth.server";
import { recoveryToken } from "~/lib/auth/passkey-recovery-token.server";
import { lockSigningMember } from "~/lib/signing.server";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createPasskeyHandlers } from "~/lib/jobs/passkey-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { SEND_PASSKEY_NOTICE_JOB } from "~/lib/jobs/mail-kinds";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); });
afterAll(() => h.restore());
const member = async (handle: string) => {
  const userId = await h.signIn(handle);
  const [current] = await h.db.select().from(session).where(eq(session.userId, userId));
  return { userId, sessionId: current.id };
};
const usePasskeyProof = (sessionId: string) => h.db.update(session).set({ loginMethod: "passkey", reauthenticationMethod: "passkey", reauthenticatedAt: new Date() }).where(eq(session.id, sessionId));
const remove = (userId: string, id: string, sessionId: string) => h.db.transaction(async tx => {
  await lockSigningMember(tx, userId);
  return removeOwnPasskey(tx, userId, id, sessionId);
});
const notices = async (userId: string) => (await h.db.select().from(jobs).where(eq(jobs.kind, SEND_PASSKEY_NOTICE_JOB))).map(row => row.payload as { userId: string; action: string }).filter(payload => payload.userId === userId).map(payload => payload.action);

describe("passkey lifecycle barriers", () => {
  it("closes Better Auth registration and internal session issuance over HTTP", () => {
    expect(isAllowedAuthEndpoint(new Request("http://localhost:5173/api/auth/passkey/generate-register-options"))).toBe(false);
    expect(isAllowedAuthEndpoint(new Request("http://localhost:5173/api/auth/passkey/verify-registration", { method: "POST" }))).toBe(false);
    expect(isAllowedAuthEndpoint(new Request("http://localhost:5173/api/auth/tomola/passkey-session", { method: "POST" }))).toBe(false);
  });

  it("requires user verification for first enrollment and offers hybrid-capable options", async () => {
    const { userId, sessionId } = await member("first_key");
    const options = await passkeyRegistrationOptions(h.db, userId, sessionId, "First key");
    if (options.needsProof) throw new Error("Expected registration");
    expect(options.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.options.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
  });

  it("requires fresh passkey verification and an existing UV assertion for protected enrollment", async () => {
    const { userId, sessionId } = await member("protected_add");
    const key = await signingCredential(h.db, userId);
    await h.db.update(profiles).set({ passkeyOnly: true }).where(eq(profiles.userId, userId));
    await expect(passkeyRegistrationOptions(h.db, userId, sessionId, "Additional")).rejects.toMatchObject({ code: "SESSION_NOT_FRESH" });
    await usePasskeyProof(sessionId);
    const proof = await passkeyRegistrationOptions(h.db, userId, sessionId, "Additional");
    if (!proof.needsProof) throw new Error("Expected proof");
    expect(proof.options.userVerification).toBe("required");
    const submit = (uv = true) => passkeyRegistrationOptions(h.db, userId, sessionId, "Additional", { challenge: proof.challenge, assertion: key.assert(proof.options.challenge, { uv }) });
    await expect(submit(false)).rejects.toMatchObject({ status: 403 });
    const approved = await submit();
    if (approved.needsProof) throw new Error("Expected registration");
    await expect(submit()).rejects.toMatchObject({ status: 403 });
    const additional = await signingCredential(h.db, userId, { enroll: false });
    expect(await verifyPasskeyRegistration(h.db, userId, sessionId, approved.challenge, additional.register(approved.options.challenge))).toMatchObject({ ok: true });
    expect(await notices(userId)).toEqual(["added"]);
  });

  it("keeps the last protected key and requires operator recovery if a protected member loses all keys", async () => {
    const { userId, sessionId } = await member("protected_last");
    const key = await signingCredential(h.db, userId);
    await h.db.update(profiles).set({ passkeyOnly: true }).where(eq(profiles.userId, userId));
    await usePasskeyProof(sessionId);
    await expect(remove(userId, key.id, sessionId)).rejects.toMatchObject({ code: "last_passkey" });
    await h.db.delete(passkey).where(eq(passkey.userId, userId));
    await expect(passkeyRegistrationOptions(h.db, userId, sessionId, "New key")).rejects.toMatchObject({ code: "operator_recovery_required" });
  });

  it("removes a spare passkey with a fresh passkey session and no write challenge", async () => {
    const as = "protected_remove";
    const { userId, sessionId } = await member(as);
    const spare = await signingCredential(h.db, userId);
    const last = await signingCredential(h.db, userId);
    await h.db.update(profiles).set({ passkeyOnly: true }).where(eq(profiles.userId, userId));
    const { action } = await import("~/routes/settings");
    const submit = (passkeyId: string) => h.outcome(() => action(h.args(h.request("/settings", {
      as, form: { intent: "delete-passkey", passkeyId },
    }))));
    await h.db.update(session).set({ loginMethod: "passkey", reauthenticationMethod: "email_code", reauthenticatedAt: new Date() }).where(eq(session.id, sessionId));
    const reauth = { status: 302, location: expect.stringContaining("purpose=remove-passkey") };
    expect(await submit(spare.id)).toMatchObject(reauth);
    await h.db.update(session).set({ reauthenticationMethod: "passkey", reauthenticatedAt: new Date(Date.now() - 601_000) }).where(eq(session.id, sessionId));
    expect(await submit(spare.id)).toMatchObject(reauth);
    expect(await h.db.select().from(passkey).where(eq(passkey.userId, userId))).toHaveLength(2);
    await usePasskeyProof(sessionId);
    expect(await submit(spare.id)).toMatchObject({ status: 302, location: "/settings?saved=passkey-removed#settings-passkeys" });
    expect(await submit(last.id)).toMatchObject({ status: 409, value: { data: { error: "last_passkey" } } });
    expect(await h.db.select().from(passkey).where(eq(passkey.userId, userId))).toMatchObject([{ id: last.id }]);
    expect(await h.db.select().from(signingChallenges).where(eq(signingChallenges.userId, userId))).toEqual([]);
    expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.userId, userId))).toEqual([]);
    expect(await notices(userId)).toEqual(["removed"]);
  });

  it.each(["email_link", "email_code"])("allows removing the last unprotected key after reauthentication with %s", async method => {
    const { userId, sessionId } = await member(`unprotected_${method}`);
    await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, userId));
    const key = await signingCredential(h.db, userId);
    await usePasskeyProof(sessionId);
    await expect(remove(userId, key.id, sessionId)).rejects.toMatchObject({ code: "remaining_login_required" });
    await h.db.update(session).set({ reauthenticationMethod: method, reauthenticatedAt: new Date(Date.now() - 601_000) }).where(eq(session.id, sessionId));
    await expect(remove(userId, key.id, sessionId)).rejects.toMatchObject({ code: "remaining_login_required" });
    await h.db.update(session).set({ reauthenticatedAt: new Date() }).where(eq(session.id, sessionId));
    expect(await remove(userId, key.id, sessionId)).toEqual({ ok: true });
    expect((await passkeyRegistrationOptions(h.db, userId, sessionId, "Replacement")).needsProof).toBe(false);
    expect(await notices(userId)).toEqual(["removed"]);
  });

  it("serializes first registrations and lets ordinary members add another passkey without existing-key proof", async () => {
    const { userId, sessionId } = await member("enrollment_race");
    const attempts = await Promise.all(["First", "Racing first"].map(async name => ({
      options: await passkeyRegistrationOptions(h.db, userId, sessionId, name), key: await signingCredential(h.db, userId, { enroll: false }),
    })));
    const results = await Promise.allSettled(attempts.map(({ options, key }) => verifyPasskeyRegistration(h.db, userId, sessionId, options.challenge, key.register(options.options.challenge))));
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await passkeyRegistrationOptions(h.db, userId, sessionId, "Additional")).needsProof).toBe(false);
    expect(await notices(userId)).toEqual(["added"]);
  });

  it("rotates the current session and clears other sessions and outstanding email credentials when enabled", async () => {
    const { userId, sessionId } = await member("login_only");
    const auth = await getAuth();
    const adapter = (await auth.$context).internalAdapter;
    const other = await h.issueLink("login_only@example.com");
    expect((await auth.api.magicLinkVerify({ query: { token: other }, headers: new Headers(), asResponse: true })).status).toBe(200);
    const pending = await h.issueLink("login_only@example.com");
    const key = await signingCredential(h.db, userId);
    const rotate = (tx: Tx, at: Date) => issuePasskeySession(auth, tx, userId, at);
    await expect(setPasskeyOnly(h.db, userId, sessionId, true, rotate)).rejects.toMatchObject({ code: "SESSION_NOT_FRESH" });
    await usePasskeyProof(sessionId);
    await expect(setPasskeyOnly(h.db, userId, sessionId, true, rotate)).rejects.toMatchObject({ code: "passkey_backup_required" });
    await h.db.update(passkey).set({ backedUp: true }).where(eq(passkey.id, key.id));
    const headers = await setPasskeyOnly(h.db, userId, sessionId, true, rotate);
    expect(headers?.getSetCookie().some(cookie => cookie.includes("session_token="))).toBe(true);
    const rows = await h.db.select().from(session).where(eq(session.userId, userId));
    expect(rows).toMatchObject([{ loginMethod: "passkey", reauthenticationMethod: "passkey" }]);
    expect(rows[0].id).not.toBe(sessionId);
    expect((await h.db.select().from(verification)).filter(row => row.identifier.endsWith(`:${hashMagicLinkToken(pending)}`))).toEqual([]);
    await expect(adapter.createSession(userId)).rejects.toMatchObject({ statusCode: 401 });
    await expect(setPasskeyOnly(h.db, userId, sessionId, false, rotate)).rejects.toMatchObject({ code: "SESSION_NOT_FRESH" });
    await setPasskeyOnly(h.db, userId, rows[0].id, false, rotate);
    expect((await notices(userId)).sort()).toEqual(["passkey_only_disabled", "passkey_only_enabled"]);
  });

  it("invalidates earlier recovery work and commits the replacement key, permit and passkey session together", async () => {
    const { userId, sessionId } = await member("recoverable");
    const other = await member("ordinary_recovery");
    await signingCredential(h.db, other.userId);
    await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, other.userId));
    const boss = await member("recovery_operator");
    const operator = { id: boss.userId, email: "recovery_operator@example.com" };
    const key = await signingCredential(h.db, userId);
    const pending = await passkeyRegistrationOptions(h.db, userId, sessionId, "Pending");
    await h.db.update(profiles).set({ passkeyOnly: true }).where(eq(profiles.userId, userId));
    const previous = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = operator.email;
    try {
      const run = (id: string, evidence = "Verified by a call to the known number") => recoverPasskeys(h.db, operator, id, "All passkeys were lost", evidence);
      await expect(run(other.userId)).rejects.toMatchObject({ code: "recovery_not_available" });
      await expect(run(userId, "")).rejects.toMatchObject({ code: "recovery_verification_required" });
      await expect(recoverPasskeys(h.db, { ...operator, id: other.userId }, userId, "All passkeys were lost", "Forged operator")).rejects.toMatchObject({ code: "operator_required" });
      await run(userId);
      const [older] = await h.db.select().from(passkeyRecoveries).where(eq(passkeyRecoveries.userId, userId));
      const oldToken = recoveryToken(userId, older.id);
      const oldOptions = await recoveryRegistrationOptions(h.db, oldToken);
      const recovery = await run(userId);
      const [current] = (await h.db.select().from(passkeyRecoveries).where(eq(passkeyRecoveries.userId, userId))).filter(row => row.id !== older.id);
      expect(current.identityVerification).toBe("Verified by a call to the known number");
      const token = recoveryToken(userId, current.id);
      const mailbox = createMemoryMailbox();
      const handlers = createPasskeyHandlers(() => createMailer(mailbox.transport, "tomola <no-reply@example.org>"));
      await runDueJobs(h.db, handlers);
      const recoveryMail = mailbox.sent.filter(mail => mail.text.includes("/auth/recover-passkeys"));
      expect(recoveryMail).toHaveLength(1);
      expect(recoveryMail[0].subject).toBe("tomola のログインの設定が変わりました");
      expect(recoveryMail[0].text).toContain(`/auth/recover-passkeys#${token}`);
      expect(recoveryMail[0].text).not.toContain(oldToken);
      await expect(recoveryRegistrationOptions(h.db, oldToken)).rejects.toMatchObject({ code: "invalid_recovery_permit" });
      await expect(recoveryRegistrationOptions(h.db, token, recovery.expiresAt)).rejects.toMatchObject({ code: "invalid_recovery_permit" });
      expect(await h.db.select().from(session).where(eq(session.userId, userId))).toEqual([]);
      expect(await h.db.select().from(passkey).where(eq(passkey.id, key.id))).toEqual([]);
      for (const challenge of [pending.challenge, oldOptions.challenge]) expect((await h.db.select().from(signingChallenges).where(eq(signingChallenges.challenge, challenge)))[0].usedAt).not.toBeNull();
      const options = await recoveryRegistrationOptions(h.db, token);
      const replacement = await signingCredential(h.db, userId, { enroll: false });
      const registration = replacement.register(options.options.challenge);
      await expect(finishPasskeyRecovery(h.db, token, options.challenge, replacement.register(options.options.challenge, { uv: false }), async () => { throw new Error("Session must not be issued"); })).rejects.toMatchObject({ code: "invalid_registration" });
      await expect(finishPasskeyRecovery(h.db, token, options.challenge, registration, async () => { throw new Error("Session failed"); })).rejects.toThrow("Session failed");
      expect(await h.db.select().from(passkey).where(eq(passkey.userId, userId))).toEqual([]);
      expect(await h.db.select().from(session).where(eq(session.userId, userId))).toEqual([]);
      expect(await h.db.select().from(passkeyRecoveryPermits).where(eq(passkeyRecoveryPermits.userId, userId))).toHaveLength(1);
      expect(await h.db.select().from(passkeyRecoveries).where(eq(passkeyRecoveries.id, current.id))).toMatchObject([{ completedAt: null }]);
      const auth = await getAuth();
      const headers = await finishPasskeyRecovery(h.db, token, options.challenge, registration, (tx, id, at, credentialId) => issuePasskeySession(auth, tx, id, at, credentialId));
      expect(headers.getSetCookie().some(cookie => cookie.includes("session_token="))).toBe(true);
      expect(await h.db.select().from(session).where(eq(session.userId, userId))).toMatchObject([{ loginMethod: "passkey", reauthenticationMethod: "passkey" }]);
      expect(await h.db.select().from(profiles).where(eq(profiles.userId, userId))).toMatchObject([{ passkeyOnly: true }]);
      expect(await h.db.select().from(passkeyRecoveries).where(eq(passkeyRecoveries.id, current.id))).toMatchObject([{ completedAt: expect.any(Date) }]);
      expect(await h.db.select().from(passkeyRecoveries).where(eq(passkeyRecoveries.id, older.id))).toMatchObject([{ completedAt: null }]);
      await expect(recoveryRegistrationOptions(h.db, token)).rejects.toMatchObject({ code: "invalid_recovery_permit" });
    } finally { if (previous === undefined) delete process.env.OPERATOR_EMAILS; else process.env.OPERATOR_EMAILS = previous; }
  });

  it("warns without mailing when the current recovery permit hash mismatches", async () => {
    const { userId } = await member("recovery_bad_hash");
    const boss = await member("recovery_hash_operator");
    const operator = { id: boss.userId, email: "recovery_hash_operator@example.com" };
    const previous = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = operator.email;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.db.update(profiles).set({ passkeyOnly: true }).where(eq(profiles.userId, userId));
      await recoverPasskeys(h.db, operator, userId, "All passkeys were lost", "Verified by a call to the known number");
      const [permit] = await h.db.update(passkeyRecoveryPermits).set({ tokenHash: "incorrect-fixture-hash" }).where(eq(passkeyRecoveryPermits.userId, userId)).returning();
      const mailbox = createMemoryMailbox();
      await runDueJobs(h.db, createPasskeyHandlers(() => createMailer(mailbox.transport, "tomola <no-reply@example.org>")));
      expect(mailbox.sent.filter(mail => mail.to === "recovery_bad_hash@example.com")).toEqual([]);
      expect(warn.mock.calls).toContainEqual(["[passkey-recovery] active permit hash does not match the delivery job"]);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(permit.tokenHash);
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = previous;
    }
  });
});
