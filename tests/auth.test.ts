import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { invitations, session, user, verification } from "~/lib/db/schema";
import * as loginMethod from "~/lib/auth/login-method.server";
import { hashMagicLinkToken } from "~/lib/auth/plugins";
import { createInvitation } from "~/lib/invitations.server";
import { createTestDb } from "./helpers/db";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

async function setup() {
  const db = await createTestDb();
  const sent: { email: string; url: string }[] = [];
  const auth = createAuth(db, {
    baseURL: "http://localhost:5173",
    secret: SECRET,
    sendMagicLink: async ({ email, url }) => {
      sent.push({ email, url });
    },
  });
  return { db, auth, sent };
}

type VerifyOutcome = { ok: true } | { ok: false; code: string | null; error: unknown };

// magicLinkVerify throws a FOUND redirect on both success and failure.
// Only failures add error=<code> to the destination.
function interpretVerifyError(error: unknown): VerifyOutcome {
  const e = error as { status?: unknown; headers?: Headers; body?: { code?: string } };
  if (e.status === "FOUND") {
    const location = e.headers?.get("location");
    const code = location ? new URL(location).searchParams.get("error") : null;
    return code === null ? { ok: true } : { ok: false, code, error };
  }
  return { ok: false, code: e.body?.code ?? null, error };
}

async function signInWithLink(
  auth: ReturnType<typeof createAuth>,
  sent: { email: string; url: string }[],
  email: string,
): Promise<VerifyOutcome> {
  await auth.api.signInMagicLink({ body: { email, callbackURL: "/" }, headers: new Headers() });
  const last = sent.at(-1);
  if (!last) throw new Error("no magic link was sent");
  const token = new URL(last.url).searchParams.get("token");
  if (!token) throw new Error("magic link has no token");
  try {
    await auth.api.magicLinkVerify({ query: { token, callbackURL: "/" }, headers: new Headers() });
    return { ok: true };
  } catch (error) {
    return interpretVerifyError(error);
  }
}

describe("invite-only magic link auth", () => {
  it("creates the user and session and consumes the invitation when invited", async () => {
    const { db, auth, sent } = await setup();
    await createInvitation(db, { email: "alice@example.com" });
    const outcome = await signInWithLink(auth, sent, "alice@example.com");
    expect(outcome).toEqual({ ok: true });
    const rows = await db.select().from(user).where(eq(user.email, "alice@example.com"));
    expect(rows).toHaveLength(1);
    const sessions = await db.select().from(session).where(eq(session.userId, rows[0].id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ loginMethod: "email_link", reauthenticationMethod: "email_link", reauthenticatedAt: expect.any(Date) });
    const [invitation] = await db.select().from(invitations).where(eq(invitations.email, "alice@example.com"));
    expect(invitation.usedAt).toBeInstanceOf(Date);
    expect(invitation.usedBy).toBe(rows[0].id);
  });

  it("records no email proof when verification only cleans up expired rows", async () => {
    const { auth, db, sent } = await setup();
    const expired = "expired@example.com";
    await auth.api.signInMagicLink({ body: { email: expired }, headers: new Headers() });
    const token = new URL(sent[0].url).searchParams.get("token")!;
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(verification.identifier, `magic-link:${hashMagicLinkToken(token)}`));
    const mark = vi.spyOn(loginMethod, "markVerifiedLogin");
    try {
      const result = await auth.api.magicLinkVerify({ query: { token }, headers: new Headers(), asResponse: true });
      expect(result.headers.get("location")).toContain("error=INVALID_TOKEN");
      expect(await db.select().from(verification)).toEqual([]);
      expect(mark).not.toHaveBeenCalled();
      expect(await db.select().from(session)).toEqual([]);
    } finally { mark.mockRestore(); }
  });

  it("rejects verification and creates no user or session without an invitation", async () => {
    const { db, auth, sent } = await setup();
    const outcome = await signInWithLink(auth, sent, "mallory@example.com");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVITATION_REQUIRED");
    const rows = await db.select().from(user).where(eq(user.email, "mallory@example.com"));
    expect(rows).toHaveLength(0);
    expect(await db.select().from(session)).toHaveLength(0);
  });

  it("does not create a user from an expired invitation", async () => {
    const { db, auth, sent } = await setup();
    await createInvitation(db, { email: "eve@example.com", now: new Date("2020-01-01T00:00:00Z"), ttlDays: 1 });
    const outcome = await signInWithLink(auth, sent, "eve@example.com");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVITATION_REQUIRED");
    const rows = await db.select().from(user).where(eq(user.email, "eve@example.com"));
    expect(rows).toHaveLength(0);
    expect(await db.select().from(session)).toHaveLength(0);
  });
});
