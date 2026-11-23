import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic, createReply } from "~/lib/entries.server";
import { createDraft, getDraft } from "~/lib/drafts.server";
import { drafts, entries, memberSignatures, passkey, profiles, session, signingChallenges, user } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { action as createApiDraft } from "~/routes/api.drafts";
import { action as autosave } from "~/routes/draft-autosave";
import { action as publishDraftScreen } from "~/routes/draft";
import { action as publishPreview, loader as loadDraftPreview } from "~/routes/draft-preview";
import { action as reviewDraft } from "~/routes/signing";
import { action as saveSettings } from "~/routes/settings";
import { action as deleteAccount } from "~/routes/settings-delete-account";
import { createApiToken } from "~/lib/tokens.server";
import { createClientDraft, updateClientDraft } from "~/lib/mcp/drafts.server";
import { withMemberWrite } from "~/lib/signing.server";
import { changeVillageMembership, ensureLanguageVillages, setDefaultVillage } from "~/lib/villages.server";
import type { SigningPreview, WriteOperation } from "~/lib/signing";
import { signingCredential } from "./helpers/signing";
let h: RouteHarness;
let queries: string[] | null = null;
beforeAll(async () => {
  h = await setupRouteHarness({ logger: { logQuery(query) { queries?.push(query); } } });
});
afterAll(() => h.restore());

const retiredFields = { signatureChallenge: "retired", signatureAssertion: "invalid-json" };

function reviewRequest(path: string, fields: Record<string, string>, as?: string, headers?: Record<string, string>) {
  const basis = h.request("/signing", { as, headers });
  return h.args(new Request(basis, {
    method: "POST", body: JSON.stringify({ intent: "preview", pathname: path, fields: Object.entries(fields) }),
  }));
}

async function expectLegacyPreview(as: string, path: string, fields: Record<string, string>, operation: WriteOperation) {
  const response = await reviewDraft(reviewRequest(path, fields, as));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ operation, signatureRequired: false, lastEditor: null });
}

it.each([{}, retiredFields])("accepts ordinary browser writes with retired signing fields %j", async legacy => {
  const as = Object.keys(legacy).length ? "old_form_writer" : "ordinary_writer";
  const author = await h.signIn(as);
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, author));
  const topic = await createTopic(h.db, author, { title: "Original", body: "Original body", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, author, topic.id, { body: "Original reply", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  const draft = await createDraft(h.db, author, { kind: "topic", body: "Unpublished draft", lang: "ja" });
  if (!draft.ok) throw new Error(draft.error);
  const cases = [
    ["topic-new", "/t/new", {}, { body: "New topic", lang: "ja" }, "create-topic"],
    ["topic", `/t/${topic.id}`, { id: String(topic.id) }, { body: "New reply", lang: "ja" }, "create-reply"],
    ["topic-edit", `/t/${topic.id}/edit`, { id: String(topic.id) }, { title: "Edited title", body: "Edited topic" }, "edit-topic"],
    ["reply-edit", `/c/${reply.id}/edit`, { id: String(reply.id) }, { body: "Edited reply" }, "edit-reply"],
    ["draft", `/drafts/${draft.id}`, { id: String(draft.id) }, { intent: "publish", version: "1", body: "Published draft", lang: "ja" }, "publish-draft"],
    ["settings", "/settings", {}, { intent: "display-name", displayName: "Example Writer", displayNameLatin: "" }, "change-display-name"],
    ["settings", "/settings", {}, { intent: "handle", handle: `${as}_new` }, "change-handle"],
  ] as const;
  for (const [name, path, params, fields, operation] of cases) {
    const { action } = await import(`../app/routes/${name}.tsx`);
    const form = { ...fields, ...legacy } as Record<string, string>;
    if (legacy === retiredFields && operation !== "publish-draft") await expectLegacyPreview(as, path, form, operation);
    const request = h.request(path, { as, form });
    expect(await h.outcome(() => action(h.args(request, params))), name).toMatchObject({ status: 302 });
  }
  const stored = await h.db.select().from(entries).where(eq(entries.authorId, author));
  expect(stored.map(row => row.body).sort()).toEqual(["Edited reply", "Edited topic", "New reply", "New topic", "Published draft"]);
  expect(stored.find(row => row.id === reply.id)?.threadId).toBe(topic.id);
  expect(await h.db.select().from(drafts).where(eq(drafts.id, draft.id))).toEqual([]);
  expect(await h.db.select().from(profiles).where(eq(profiles.userId, author))).toMatchObject([{ handle: `${as}_new`, displayName: "Example Writer", signPosts: true }]);
  expect(await h.db.select().from(memberSignatures)).toEqual([]);
  expect(await h.db.select().from(signingChallenges)).toEqual([]);
});

it("lets pages loaded before the update remove a spare passkey and delete the account", async () => {
  const as = "old_account_settings";
  const id = await h.signIn(as);
  const spare = await signingCredential(h.db, id);
  const last = await signingCredential(h.db, id);
  await h.db.update(profiles).set({ signPosts: true, passkeyOnly: true }).where(eq(profiles.userId, id));
  await h.db.update(session).set({ loginMethod: "passkey", reauthenticationMethod: "passkey", reauthenticatedAt: new Date() }).where(eq(session.userId, id));
  const remove = { intent: "delete-passkey", passkeyId: spare.id, ...retiredFields };
  await expectLegacyPreview(as, "/settings", remove, "remove-passkey");
  expect(await h.outcome(() => saveSettings(h.args(h.request("/settings", { as, form: remove })))))
    .toMatchObject({ status: 302, location: "/settings?saved=passkey-removed#settings-passkeys" });
  expect(await h.db.select().from(passkey).where(eq(passkey.userId, id))).toMatchObject([{ id: last.id }]);
  expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.userId, id))).toEqual([]);
  expect(await h.db.select().from(signingChallenges).where(eq(signingChallenges.userId, id))).toEqual([]);

  const path = "/settings/delete-account";
  const quit = { intent: "delete-account", confirmation: as, ...retiredFields };
  await expectLegacyPreview(as, path, quit, "delete-account");
  expect(await h.outcome(() => deleteAccount(h.args(h.request(path, { as, form: quit })))))
    .toMatchObject({ status: 302, location: "/login?account-deleted=1" });
  expect(await h.db.select().from(user).where(eq(user.id, id))).toEqual([]);
});

it("keeps the preview guards and does no additional database work for a known operation", async () => {
  const as = "old_preview_writer";
  const id = await h.signIn(as);
  const path = "/t/999999/edit";
  expect(await h.outcome(() => reviewDraft(reviewRequest(path, {})))).toMatchObject({ status: 302, location: "/login" });
  expect(await h.outcome(() => reviewDraft(reviewRequest(path, {}, as, { origin: "https://other.example" })))).toMatchObject({ status: 403 });
  async function previewQueries(run: () => Promise<void>) {
    const recorded: string[] = [];
    queries = recorded;
    try { await run(); } finally { queries = null; }
    return recorded;
  }
  const unknown = await previewQueries(async () => {
    const response = await reviewDraft(reviewRequest("/settings", { intent: "sign-posts" }, as));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_target" });
  });
  expect(unknown.length).toBeGreaterThan(0);
  expect(await previewQueries(() => expectLegacyPreview(as, path, {}, "edit-topic"))).toEqual(unknown);
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(profiles.userId, id));
  expect(await h.outcome(() => reviewDraft(reviewRequest(path, {}, as)))).toMatchObject({ status: 302, location: "/suspended" });
});

it("refuses the old challenge operation without issuing a challenge", async () => {
  const as = "retired_challenge";
  await h.signIn(as);
  const basis = h.request("/signing", { as });
  const response = await reviewDraft(h.args(new Request(basis, {
    method: "POST", body: JSON.stringify({ intent: "challenge", pathname: "/t/new", fields: [], previewHash: "old" }),
  })));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "signing_closed" });
  expect(await h.db.select().from(signingChallenges)).toEqual([]);
});

describe("AI draft confirmation through browser routes", () => {
  const body = "Review this draft before publishing.";
  const client = { key: "oauth:review-client", id: "review-client", name: "Review client", uri: null, tokenId: null };
  let owner: string;
  let outsider: string;
  let apiToken: string;
  beforeAll(async () => {
    owner = await h.signIn("review_owner");
    outsider = await h.signIn("review_other");
    const token = await createApiToken(h.db, owner, { name: "Draft tool", kind: "draft" });
    if (!token.ok) throw new Error(token.error);
    apiToken = token.token;
    await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, owner));
  });

  const pathFor = (id: number) => `/drafts/${id}`;
  const paramsFor = (id: number) => ({ id: String(id) });
  const fieldsFor = (version = 1) => ({ intent: "publish", version: String(version), body, lang: "en" });
  async function makeApiDraft() {
    const request = new Request(`${BASE}/api/drafts`, {
      method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "text/markdown" },
      body: `---\ntype: topic\nlang: en\n---\n${body}`,
    });
    const response = await createApiDraft(h.args(request));
    expect(response.status).toBe(201);
    return (await response.json()).id as number;
  }
  async function review(path: string, fields: Record<string, string>, as = "review_owner") {
    const response = await reviewDraft(reviewRequest(path, fields, as));
    expect(response.status).toBe(200);
    const preview = await response.json() as SigningPreview;
    expect(preview.operation).toBe("publish-draft");
    return preview;
  }
  function publish(id: number, fields: Record<string, string>, fromPreview = false, as = "review_owner") {
    const path = pathFor(id) + (fromPreview ? "/preview" : "");
    const args = h.args(h.request(path, { as, form: fields }), paramsFor(id));
    return h.outcome(() => fromPreview ? publishPreview(args) : publishDraftScreen(args));
  }

  it("retains the requirement after browser saves and autosaves, and allows one publication with the reviewed changes", async () => {
    const id = await makeApiDraft();
    const path = pathFor(id);
    const fields = fieldsFor();
    const missing = { status: 409, value: { data: { error: "confirmation_required" } } };
    expect(await publish(id, fields)).toMatchObject(missing);
    expect(await publish(id, { ...fields, intent: "save", body: "Manual save." })).toMatchObject({ status: 200, value: { data: { version: 2 } } });
    expect(await publish(id, fieldsFor(2))).toMatchObject(missing);
    const saved = await autosave(h.args(h.request("/drafts/autosave", {
      as: "review_owner", form: { ...fieldsFor(2), draftId: String(id), ownerId: owner, body: "Autosave." },
    })));
    expect(await saved.json()).toMatchObject({ version: 3 });
    expect(await publish(id, fieldsFor(3))).toMatchObject(missing);
    const approved = { ...fieldsFor(3), body: "Unsaved reviewed changes.", title: "Reviewed title" };
    const { confirmation, signatureRequired } = await review(path, approved);
    expect(signatureRequired).toBe(false);
    expect(confirmation).toEqual(expect.any(String));
    const submit = { ...approved, confirmation: confirmation! };
    expect(await publish(id, submit)).toMatchObject({ status: 302 });
    expect(await publish(id, submit)).toMatchObject({ status: 404 });
    expect(await h.db.select().from(entries).where(eq(entries.body, approved.body))).toMatchObject([{ authorId: owner, title: approved.title, via: "api" }]);
  });

  it("binds actor, draft, version, content and target and expires at ten minutes", async () => {
    const id = await makeApiDraft();
    const otherDraft = await makeApiDraft();
    const path = pathFor(id);
    const fields = fieldsFor();
    const { confirmation } = await review(path, fields);
    const approved = { ...fields, confirmation: confirmation! };
    const changed = { status: 409, value: { data: { error: "confirmation_changed" } } };
    expect(await publish(otherDraft, approved)).toMatchObject(changed);
    expect(await publish(id, { ...approved, body: "Changed proposal." })).toMatchObject(changed);
    expect(await publish(id, { ...approved, version: "2" })).toMatchObject(changed);
    const original = await createTopic(h.db, outsider, { title: "Original question", body, lang: "en", asksStance: true });
    if (!original.ok) throw new Error(original.error);
    await h.db.update(drafts).set({ altOf: original.id, asksStance: true }).where(eq(drafts.id, id));
    expect(await publish(id, approved)).toMatchObject(changed);
    await h.db.update(drafts).set({ altOf: null, asksStance: false, authorId: outsider }).where(eq(drafts.id, id));
    expect(await publish(id, approved, false, "review_other")).toMatchObject(changed);
    await h.db.update(drafts).set({ authorId: owner }).where(eq(drafts.id, id));
    const form = await h.request(path, { as: "review_owner", form: approved }).formData();
    const expiresAt = Number(confirmation!.split(".")[0]);
    expect(expiresAt - Date.now()).toBeGreaterThan(599_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
    const mutate = vi.fn(async () => ({ ok: false }));
    await expect(withMemberWrite(h.db, owner, h.request(path), form, mutate, { now: new Date(expiresAt - 1) })).resolves.toEqual({ ok: false });
    mutate.mockClear();
    await expect(withMemberWrite(h.db, owner, h.request(path), form, mutate, { now: new Date(expiresAt) }))
      .rejects.toMatchObject({ code: "confirmation_expired", status: 409 });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects a confirmation issued before an MCP update and rolls back a mismatched publication", async () => {
    const draft = await createClientDraft(h.db, owner, client, { kind: "topic", body, lang: "en" });
    if (!draft.ok) throw new Error(draft.error);
    const path = pathFor(draft.id);
    const { confirmation } = await review(path, fieldsFor());
    expect(await updateClientDraft(h.db, owner, client, draft.id, { body: "Revised by the client.", expectedVersion: 1 })).toMatchObject({ ok: true, version: 2 });
    expect(await publish(draft.id, { ...fieldsFor(), confirmation: confirmation! })).toMatchObject({ status: 409, value: { data: { error: "confirmation_changed" } } });
    const fields = fieldsFor(2);
    const current = await review(path, fields);
    const form = await h.request(path, { form: { ...fields, confirmation: current.confirmation! } }).formData();
    const before = await h.db.select().from(entries);
    await expect(withMemberWrite(h.db, owner, h.request(path), form, async tx => {
      await tx.delete(drafts).where(eq(drafts.id, draft.id));
      return createTopic(tx, owner, { body: "Incorrect publication.", lang: "en" });
    })).rejects.toMatchObject({ code: "published_content_changed", status: 409 });
    expect(await h.db.select().from(entries)).toEqual(before);
    expect(await getDraft(h.db, owner, draft.id)).toMatchObject({ version: 2, body: "Revised by the client." });
  });

  it("issues the same kind of confirmation on preview GET without updating the draft or creating a challenge", async () => {
    const id = await makeApiDraft();
    const path = pathFor(id) + "/preview";
    const before = await h.db.select().from(drafts).where(eq(drafts.id, id));
    const challenges = await h.db.select().from(signingChallenges);
    // A valid old session would ordinarily refresh, and an operator's first member
    // read may materialize a role row.
    await h.db.update(session).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(session.userId, owner));
    vi.stubEnv("OPERATOR_EMAILS", "review_owner@example.com");
    queries = [];
    const page = await loadDraftPreview(h.args(h.request(path, { as: "review_owner" }), paramsFor(id))).finally(() => {
      const readQueries = queries!;
      queries = null;
      vi.unstubAllEnvs();
      expect(readQueries.length).toBeGreaterThan(0);
      expect(readQueries.filter(query => /^(?:insert|update|delete)\b|\bfor (?:key share|share|(?:no key )?update)\b/i.test(query))).toEqual([]);
    });
    expect(page.data.confirmation).toEqual(expect.any(String));
    expect(await h.db.select().from(drafts).where(eq(drafts.id, id))).toEqual(before);
    expect(await h.db.select().from(signingChallenges)).toEqual(challenges);
    const fields = { ...fieldsFor(), signingView: page.data.signingView };
    const { confirmation } = await review(pathFor(id), fields);
    expect(await publish(id, fields, true)).toMatchObject({ status: 409, value: { data: { error: "confirmation_required" } } });
    expect(await publish(id, { ...fields, confirmation: confirmation!, signingView: "wrong" }, true)).toMatchObject({ status: 400 });
    expect(await publish(id, { ...fields, confirmation: confirmation! }, true)).toMatchObject({ status: 302 });

    const secondId = await makeApiDraft();
    const second = await loadDraftPreview(h.args(h.request(pathFor(secondId) + "/preview", { as: "review_owner" }), paramsFor(secondId)));
    expect(await publish(secondId, { ...fieldsFor(), confirmation: second.data.confirmation!, signingView: second.data.signingView })).toMatchObject({ status: 302 });
  });

  it("issues no confirmation to API credentials, other members, browser drafts", async () => {
    const id = await makeApiDraft();
    const path = pathFor(id);
    const args = (as?: string, headers?: Record<string, string>) => h.args(h.request(path + "/preview", { as, headers }), paramsFor(id));
    const authorization = { Authorization: `Bearer ${apiToken}` };
    expect(await h.outcome(() => reviewDraft(reviewRequest(path, fieldsFor(), undefined, authorization)))).toMatchObject({ status: 302, location: "/login" });
    expect(await h.outcome(() => loadDraftPreview(args(undefined, authorization)))).toMatchObject({ status: 302, location: expect.stringMatching(/^\/login/) });
    expect((await reviewDraft(reviewRequest(path, fieldsFor(), "review_other"))).status).toBe(404);
    expect(await h.outcome(() => loadDraftPreview(args("review_other")))).toMatchObject({ status: 404 });
    const browser = await createDraft(h.db, owner, { kind: "topic", body, lang: "en" });
    if (!browser.ok) throw new Error(browser.error);
    expect((await review(pathFor(browser.id), fieldsFor())).confirmation).toBeUndefined();
    expect(await publish(browser.id, fieldsFor())).toMatchObject({ status: 302 });

  });

  it("binds the resolved posting village when the stored draft has no explicit village", async () => {
    vi.stubEnv("VILLAGES", "1");
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    try {
      await ensureLanguageVillages(h.db);
      await h.signIn("review_village", { homeArea: "en" });
      const userId = h.ids.review_village;
      expect(await changeVillageMembership(h.db, userId, "ja", "join")).toBe(true);
      expect(await setDefaultVillage(h.db, userId, "en")).toBe(true);
      const draft = await createDraft(h.db, userId, { kind: "topic", body, lang: "en" }, { via: "api" });
      if (!draft.ok) throw new Error(draft.error);
      const fields = { ...fieldsFor(), village: "", villageExplicit: "0", villageDisplayed: "en" };
      const old = await review(pathFor(draft.id), fields, "review_village");
      expect(await setDefaultVillage(h.db, userId, "ja")).toBe(true);
      expect(await publish(draft.id, { ...fields, confirmation: old.confirmation! }, false, "review_village"))
        .toMatchObject({ status: 409, value: { data: { error: "confirmation_changed" } } });
      const current = { ...fields, villageDisplayed: "ja" };
      const refreshed = await review(pathFor(draft.id), current, "review_village");
      expect(await publish(draft.id, { ...current, confirmation: refreshed.confirmation! }, false, "review_village")).toMatchObject({ status: 302 });
    } finally { vi.unstubAllEnvs(); }
  });

  it("confirms the disabled original language shown by the review", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    try {
      const body = "Das ist ein deutscher Text und wir haben ihn für diese Prüfung geschrieben. Die Sprache soll in dem veröffentlichten Beitrag erhalten bleiben.";
      const draft = await createDraft(h.db, owner, { kind: "topic", body, lang: "other" }, { via: "api" });
      if (!draft.ok) throw new Error(draft.error);
      const fields = { ...fieldsFor(), body, lang: "other" };
      const preview = await review(pathFor(draft.id), fields);
      expect(preview.content.lang).toBe("de");
      expect(await publish(draft.id, { ...fields, confirmation: preview.confirmation! })).toMatchObject({ status: 302 });
      expect(await h.db.select().from(entries).where(eq(entries.body, body))).toMatchObject([{ lang: "de" }]);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["clientKey", "clientId"])("requires a confirmation for a browser copy carrying only %s", async field => {
    const draft = await createDraft(h.db, owner, { kind: "topic", body, lang: "en" });
    if (!draft.ok) throw new Error(draft.error);
    await h.db.update(drafts).set({ [field]: "client-metadata" }).where(eq(drafts.id, draft.id));
    expect(await publish(draft.id, fieldsFor())).toMatchObject({ status: 409, value: { data: { error: "confirmation_required" } } });
    expect((await review(pathFor(draft.id), fieldsFor())).confirmation).toEqual(expect.any(String));
  });
});
