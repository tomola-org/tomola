import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createAppAuth } from "~/lib/auth/auth.server";
import { magicLinkOutcome, settleMagicLinkMail, type MagicLinkOutcome } from "~/lib/auth/magic-link.server";
import { decodeLoginCode, loginCodeIdentifier, loginCodeState } from "~/lib/auth/login-code.server";
import { createInvitation } from "~/lib/invitations.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createTestDb } from "./helpers/db";
import { MAGIC_LINK_EMAIL_IP_LIMIT, MAGIC_LINK_EMAIL_LIMIT } from "~/lib/rate-limit.server";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

it("prepares identical code state before the recipient check, for members and unknown addresses", async () => {
  const db = await createTestDb();
  const box = createMemoryMailbox();
  const mailer = createMailer(box.transport, "tomola <no-reply@example.org>");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const auth = createAppAuth(db, { baseURL: "http://localhost:5173", secret: SECRET, mailer: () => mailer, isKnown: async (_db, email) => { await gate; return email === "member@example.com"; } });
  const nonce = randomBytes(32).toString("base64url");
  const ids = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  const responses = [];
  for (const [i, email] of ["member@example.com", "unknown@example.com"].entries()) {
    responses.push(await auth.api.signInMagicLink({ body: { email, metadata: { browserNonce: nonce, codeId: ids[i] } }, headers: new Headers() }));
  }
  expect(responses).toEqual([{ status: true }, { status: true }]);
  expect(box.sent).toHaveLength(0);
  const { verification } = await import("~/lib/db/schema");
  const rows = (await db.select().from(verification)).filter(r => r.identifier.startsWith("magic-link-code:"));
  release();
  await settleMagicLinkMail();
  expect(rows).toHaveLength(2);
  expect(box.sent).toHaveLength(1);
  expect(box.sent[0].text).toMatch(/\b\d{3} \d{3}\b/);
  for (const id of ids) {
    for (let n = 0; n < 6; n++) expect(await decodeLoginCode(db, { id, nonce, code: "bad", ip: null })).toBeNull();
  }
});

it("keeps plaintext codes out of storage and delivery-failure logs, including transport error bodies", async () => {
  const db = await createTestDb();
  await createInvitation(db, { email: "safe@example.com" });
  let mailText = "";
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const auth = createAppAuth(db, { baseURL: "http://localhost:5173", secret: SECRET,
      mailer: () => ({ kind: "memory", from: "test", send: async mail => { mailText = mail.text; throw new Error(mail.text); } }) });
    await auth.api.signInMagicLink({ body: { email: "safe@example.com", metadata: { browserNonce: randomBytes(32).toString("base64url"), codeId: randomBytes(32).toString("base64url") } }, headers: new Headers() });
    await settleMagicLinkMail();
    const code = mailText.match(/\b\d{3} \d{3}\b/)![0];
    const { verification, rateLimits } = await import("~/lib/db/schema");
    const stored = JSON.stringify([await db.select().from(verification), await db.select().from(rateLimits)]);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.replace(" ", ""));
    expect(logger).toHaveBeenCalled();
    expect(logger.mock.calls.flat().join(" ")).not.toContain(code);
    expect(mailText.match(/https?:\/\/\S+/)![0]).not.toContain(code.replace(" ", ""));
  } finally { logger.mockRestore(); }
});

it("sends a rate-limited notice and keeps the ordinary code screen for passkey-only members", async () => {
  const { addMember } = await import("./helpers/db");
  const { eq } = await import("drizzle-orm");
  const { profiles, verification } = await import("~/lib/db/schema");
  const db = await createTestDb();
  await addMember(db, "email-policy", "email_policy");
  await db.update(profiles).set({ passkeyOnly: true }).where(eq(profiles.userId, "email-policy"));
  const box = createMemoryMailbox();
  const auth = createAppAuth(db, { baseURL: "http://localhost:5173", secret: SECRET, mailer: () => createMailer(box.transport, "tomola <no-reply@example.org>") });
  const limit = Math.min(MAGIC_LINK_EMAIL_IP_LIMIT.limit, MAGIC_LINK_EMAIL_LIMIT.limit);
  const email = "email-policy@example.com";
  const codeIdentifiers = [];
  for (let i = 0; i <= limit; i++) {
    const outcome: MagicLinkOutcome = {};
    const codeId = randomBytes(32).toString("base64url");
    const reply = await magicLinkOutcome.run(outcome, () => auth.api.signInMagicLink({
      body: { email, metadata: { browserNonce: randomBytes(32).toString("base64url"), codeId } }, headers: new Headers(),
    }));
    expect(reply).toEqual({ status: true });
    expect(outcome.result).toBe(i < limit ? "sent" : "later");
    if (i < limit) {
      codeIdentifiers.push(loginCodeIdentifier(codeId));
      expect(await loginCodeState(db, codeId, null)).toEqual({ invalid: false, limited: null });
      expect(box.sent[i]).toMatchObject({ to: email, text: expect.stringContaining("passkeys only") });
      expect(box.sent[i].text).not.toMatch(/https?:|\b\d{3} ?\d{3}\b/);
    }
  }
  expect(box.sent).toHaveLength(limit);
  const identifiers = (await db.select().from(verification)).map(row => row.identifier);
  expect(identifiers.filter(identifier => identifier.startsWith("magic-link-code:")).sort()).toEqual(codeIdentifiers.sort());
  expect(identifiers.filter(identifier => identifier.startsWith("magic-link:"))).toEqual([]);
});
