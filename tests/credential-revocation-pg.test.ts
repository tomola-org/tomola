import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAuth } from "~/lib/auth/auth.server";
import { withCredentialSession } from "~/lib/auth/credential-session.server";
import { revokeAllCredentials } from "~/lib/auth/revoke-credentials.server";
import { apiTokens, oauthClient, oauthConsent } from "~/lib/db/schema";
import { createApiToken } from "~/lib/tokens.server";
import { addMember } from "./helpers/db";
import { holdTx } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

const globals = globalThis as { __tomolaAuth?: Promise<ReturnType<typeof createAuth>> };
describe.skipIf(!REAL_PG_URL)("credential creation versus complete revocation", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  const previous = globals.__tomolaAuth;
  beforeAll(async () => { scratch = await createScratchDb(); });
  afterEach(async () => { globals.__tomolaAuth = previous; await scratch.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); });
  it.each(["PAT", "OAuth consent"])("cannot create a %s from a request authenticated before revocation", async kind => {
    const writer = await scratch.open(), reader = await scratch.open(`credential-${kind}`), admin = await scratch.admin();
    const id = kind === "PAT" ? "pat-race" : "oauth-race";
    await addMember(writer, id, `sec_${id.replaceAll("-", "_")}`);
    const tokens: string[] = [];
    const auth = createAuth(writer, { baseURL: "http://localhost:5173", secret: "test-secret-0123456789abcdef0123456789abcdef", sendMagicLink: async ({ token }) => { tokens.push(token); } });
    globals.__tomolaAuth = Promise.resolve(auth);
    await auth.api.signInMagicLink({ body: { email: `${id}@example.com` }, headers: new Headers() });
    const loggedIn = await auth.api.magicLinkVerify({ query: { token: tokens.at(-1)! }, headers: new Headers(), asResponse: true });
    const cookie = loggedIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const request = new Request("http://localhost:5173/settings/tokens", { method: "POST", headers: { cookie } });
    expect(await auth.api.getSession({ headers: request.headers })).not.toBeNull();
    await writer.insert(oauthClient).values({ id, clientId: id, redirectUris: ["https://client.example/cb"], createdAt: new Date() });
    const create = (db: typeof writer) => kind === "PAT" ? createApiToken(db, id, { name: "Race", kind: "read" }) : db.insert(oauthConsent).values({ id, clientId: id, userId: id, scopes: ["read"], createdAt: new Date(), updatedAt: new Date() });
    // Legitimate control: the same fresh session can create before revocation.
    await withCredentialSession(reader, id, request, "/settings/tokens", create);
    const held = holdTx(writer, tx => revokeAllCredentials(tx, id));
    await held.ready;
    let settled = false;
    const result = withCredentialSession(reader, id, request, "/settings/tokens", create).catch(error => error).finally(() => { settled = true; });
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await admin.query("select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [`credential-${kind}`]);
        if (waiting.rows.length) break;
        expect(settled, "credential creation did not wait for revocation").toBe(false);
        if (Date.now() > deadline) throw new Error("Expected profile lock wait");
      }
      await held.commit();
      expect(await result).toMatchObject({ status: 302 });
      expect(await reader.select().from(apiTokens).where(eq(apiTokens.userId, id))).toMatchObject(kind === "PAT" ? [{ revokedAt: expect.any(Date) }] : []);
      expect(await reader.select().from(oauthConsent).where(eq(oauthConsent.userId, id))).toEqual([]);
    } finally { await held.rollback(); await result; }
  });
});

// The member lock must cover the settings change and the session insertion,
// even when the email credential was consumed on another connection first.
describe.skipIf(!REAL_PG_URL)("passkey-only login races", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  beforeAll(async () => { scratch = await createScratchDb(); });
  afterAll(async () => { await scratch?.drop(); });
  it("leaves only the rotated passkey session and preserves the final passkey", async () => {
    const { issuePasskeySession } = await import("~/lib/auth/auth.server");
    const { setPasskeyOnly, removeOwnPasskey } = await import("~/lib/auth/passkeys.server");
    const { lockSigningMember } = await import("~/lib/signing.server");
    const { session, passkey } = await import("~/lib/db/schema");
    const { signingCredential } = await import("./helpers/signing");
    const { waitForLockWait } = await import("./helpers/pg-concurrency");
    const writer = await scratch.open("passkey-setting"), email = await scratch.open("passkey-email"), remover = await scratch.open("passkey-deletion"), admin = await scratch.admin();
    const userId = "passkey-race";
    await addMember(writer, userId, "passkey_race");
    const key = await signingCredential(writer, userId, { counterZero: true });
    const links: string[] = [];
    const opts = { baseURL: "http://localhost:5173", secret: "test-secret-0123456789abcdef0123456789abcdef", sendMagicLink: async ({ token }: { token: string }) => { links.push(token); } };
    const auth = createAuth(writer, opts), emailAuth = createAuth(email, opts);
    const issue = () => emailAuth.api.signInMagicLink({ body: { email: `${userId}@example.com` }, headers: new Headers() });
    const verify = () => emailAuth.api.magicLinkVerify({ query: { token: links.at(-1)! }, headers: new Headers(), asResponse: true });
    await issue();
    expect((await verify()).status).toBe(200);
    const [old] = await writer.select().from(session).where(eq(session.userId, userId));
    const confirm = await writer.transaction(tx => issuePasskeySession(auth, tx, userId, new Date(), key.id));
    const current = await auth.api.getSession({ headers: new Headers({ cookie: confirm.getSetCookie().map(value => value.split(";")[0]).join("; ") }) });
    expect(current).not.toBeNull();
    await issue();
    let locked!: () => void;
    let enable!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const allowEnable = new Promise<void>(resolve => { enable = resolve; });
    const setting = writer.transaction(async tx => {
      await lockSigningMember(tx, userId);
      locked();
      await allowEnable;
      return setPasskeyOnly(tx, userId, current!.session.id, true, (inner, at) => issuePasskeySession(auth, inner, userId, at));
    });
    await lockReady;
    const emailResult = verify();
    const deletion = remover.transaction(async tx => {
      await lockSigningMember(tx, userId);
      return removeOwnPasskey(tx, userId, key.id, old.id);
    }).catch(error => error);
    try {
      await Promise.all([waitForLockWait(admin, "passkey-email"), waitForLockWait(admin, "passkey-deletion")]);
    } finally { enable(); }
    await setting;
    expect((await emailResult).status).toBe(401);
    expect(await deletion).toMatchObject({ code: "last_passkey" });
    expect(await writer.select().from(session).where(eq(session.userId, userId))).toMatchObject([{ loginMethod: "passkey" }]);
    expect(await writer.select().from(passkey).where(eq(passkey.userId, userId))).toHaveLength(1);
  });
});
