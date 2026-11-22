import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic, createReply } from "~/lib/entries.server";
import { createDraft, getDraft } from "~/lib/drafts.server";
import { drafts, entries, memberSignatures, profiles, session, signingChallenges } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { action as createApiDraft } from "~/routes/api.drafts";
import { action as autosave } from "~/routes/draft-autosave";
import { action as publishDraftScreen } from "~/routes/draft";
import { action as publishPreview, loader as loadDraftPreview } from "~/routes/draft-preview";
import { action as reviewDraft } from "~/routes/signing";
import { createApiToken } from "~/lib/tokens.server";
import { createClientDraft, updateClientDraft } from "~/lib/mcp/drafts.server";
import { withSignedWrite } from "~/lib/signing.server";
import { changeVillageMembership, ensureLanguageVillages, setDefaultVillage } from "~/lib/villages.server";
import type { SigningPreview } from "~/lib/signing";
import { attachSigningProof, signingCredential } from "./helpers/signing";
let h: RouteHarness;
let queries: string[] | null = null;
beforeAll(async () => {
  h = await setupRouteHarness({ logger: { logQuery(query) { queries?.push(query); } } });
  await h.signIn("hana");
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.hana));
});
afterAll(() => h.restore());

it("rejects every named HTTP write with a real member session but no signature, preserving all rows", async () => {
  const topic = await createTopic(h.db, h.ids.hana, { title: "Original", body: "Original body", lang: "ja" }); if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, h.ids.hana, topic.id, { body: "Original reply", lang: "ja" }); if (!reply.ok) throw new Error(reply.error);
  const draft = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "Unpublished draft", lang: "ja" }); if (!draft.ok) throw new Error(draft.error);
  const cases = [
    ["topic-new", "/t/new", {}, { body: "Forged topic", lang: "ja" }],
    ["topic", `/t/${topic.id}`, { id: String(topic.id) }, { body: "Forged reply", lang: "ja" }],
    ["topic-edit", `/t/${topic.id}/edit`, { id: String(topic.id) }, { title: "Forged title", body: "Forged edit" }],
    ["reply-edit", `/c/${reply.id}/edit`, { id: String(reply.id) }, { body: "Forged reply edit" }],
    ["draft", `/drafts/${draft.id}`, { id: String(draft.id) }, { intent: "publish", body: "Forged draft publication", lang: "ja" }],
    ["settings", "/settings", {}, { intent: "handle", handle: "forged" }],
  ] as const;
  const before = await h.db.select().from(entries);
  const draftBefore = await h.db.select().from(drafts);
  for (const [name, path, params, form] of cases) {
    const mod = await import(`../app/routes/${name}.tsx`);
    const request = h.request(path, { as: "hana", form });
    expect(request.method).toBe("POST");
    expect(await h.outcome(() => mod.action(h.args(request, params))), name).toMatchObject({ status: 403 });
  }
  expect(await h.db.select().from(entries)).toEqual(before);
  expect(await h.db.select().from(drafts)).toEqual(draftBefore);
  expect((await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].handle).toBe("hana");
  expect(await h.db.select().from(memberSignatures)).toHaveLength(0);
});

it("refuses an invalid signing proof through all six write paths without changing posts, drafts or the handle", async () => {
  const topic = await createTopic(h.db, h.ids.hana, { body: "Original signed target", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, h.ids.hana, topic.id, { body: "Original reply", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  const draft = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "Unpublished draft", lang: "ja" });
  if (!draft.ok) throw new Error(draft.error);
  const before = await h.db.select().from(entries);
  const draftBefore = await h.db.select().from(drafts);
  const handleBefore = (await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].handle;
  const version = String(draftBefore.find(row => row.id === draft.id)!.version);
  for (const [name, url, params, form] of [
    ["topic-new", "/t/new", {}, { body: "Forged topic", lang: "ja" }],
    ["topic", `/t/${topic.id}`, { id: String(topic.id) }, { body: "Forged reply", lang: "ja" }],
    ["topic-edit", `/t/${topic.id}/edit`, { id: String(topic.id) }, { body: "Forged edit", lang: "ja" }],
    ["reply-edit", `/c/${reply.id}/edit`, { id: String(reply.id) }, { body: "Forged reply edit", lang: "ja" }],
    ["draft", `/drafts/${draft.id}`, { id: String(draft.id) }, { intent: "publish", body: "Forged draft publication", lang: "ja", version }],
    ["settings", "/settings", {}, { intent: "handle", handle: "forged" }],
  ] as const) {
    const mod = await import(`../app/routes/${name}.tsx`);
    const response = await h.outcome(() => mod.action(h.args(h.request(url, { as: "hana", form: { ...form, signatureChallenge: "invalid", signatureAssertion: "invalid-json" } }), params)));
    expect(response.status, name).toBe(403);
    expect(response.value, name).toMatchObject({ data: { error: "invalid_signature" } });
    expect(await h.db.select().from(entries), name).toEqual(before);
    expect(await h.db.select().from(drafts), name).toEqual(draftBefore);
    expect((await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.hana)))[0].handle, name).toBe(handleBefore);
    expect(await h.db.select().from(memberSignatures), name).toHaveLength(0);
  }
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
  function reviewRequest(path: string, fields: Record<string, string>, as?: string, headers?: Record<string, string>) {
    const basis = h.request("/signing", { as, headers });
    return h.args(new Request(basis, {
      method: "POST", body: JSON.stringify({ intent: "preview", pathname: path, fields: Object.entries(fields) }),
    }));
  }
  async function review(path: string, fields: Record<string, string>, as = "review_owner") {
    const response = await reviewDraft(reviewRequest(path, fields, as));
    expect(response.status).toBe(200);
    return await response.json() as SigningPreview;
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
    await expect(withSignedWrite(h.db, owner, h.request(path), form, mutate, { now: new Date(expiresAt - 1) })).resolves.toEqual({ ok: false });
    mutate.mockClear();
    await expect(withSignedWrite(h.db, owner, h.request(path), form, mutate, { now: new Date(expiresAt) }))
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
    await expect(withSignedWrite(h.db, owner, h.request(path), form, async tx => {
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

  it("issues no confirmation to API credentials, other members, browser drafts or signed members", async () => {
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

    const signedDraft = await createDraft(h.db, h.ids.hana, { kind: "topic", body, lang: "en" }, { via: "api" });
    if (!signedDraft.ok) throw new Error(signedDraft.error);
    const signedPath = pathFor(signedDraft.id);
    const preview = await review(signedPath, fieldsFor(), "hana");
    expect(preview.signatureRequired).toBe(true);
    expect(preview.confirmation).toBeUndefined();
    const key = await signingCredential(h.db, h.ids.hana);
    const request = await attachSigningProof(h.db, h.ids.hana, h.request(signedPath, { as: "hana", form: fieldsFor() }), key);
    expect(await h.outcome(() => publishDraftScreen(h.args(request, paramsFor(signedDraft.id))))).toMatchObject({ status: 302 });
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
