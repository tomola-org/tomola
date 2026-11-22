import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createDraft, updateDraft } from "~/lib/drafts.server";
import { entries } from "~/lib/db/schema";
import { previewDraftPublication, signingViewToken, withMemberWrite } from "~/lib/signing.server";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("hana"); });
afterAll(() => h.restore());

function formFor(body: string) {
  const form = new FormData();
  form.set("body", body);
  form.set("lang", "ja");
  form.set("version", "1");
  return form;
}

it("matches the write route on native and hydrated requests", async () => {
  const form = formFor("Hydrated submission");
  const mutate = vi.fn(async () => ({ ok: true }));
  for (const path of ["/t/new", "/t/new.data"]) {
    await expect(withMemberWrite(h.db, h.ids.hana, h.request(path), form, mutate)).resolves.toEqual({ ok: true });
  }
  for (const path of ["/", "/_.data?index", "/t/new.data.data", "/t/not-an-id/edit"]) {
    await expect(withMemberWrite(h.db, h.ids.hana, h.request(path), form, mutate)).rejects.toMatchObject({ status: 400 });
  }
  expect(mutate).toHaveBeenCalledTimes(2);
});

it("rolls back a failed browser write to its savepoint", async () => {
  await h.db.transaction(async tx => {
    await expect(withMemberWrite(tx, h.ids.hana, h.request("/t/new"), formFor("Savepoint"), async savepoint => {
      await savepoint.insert(entries).values({ kind: "topic", authorId: h.ids.hana, lang: "ja", body: "Savepoint" });
      throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect(await tx.select().from(entries).where(eq(entries.body, "Savepoint"))).toEqual([]);
  });
});

describe("draft confirmation preview", () => {
  it("shows the current AI draft and the version the member previously saw", async () => {
    const userId = h.ids.hana;
    const draft = await createDraft(h.db, userId, { kind: "topic", body: "Initial draft", lang: "ja" }, { via: "api" });
    if (!draft.ok) throw new Error(draft.error);
    const path = `/drafts/${draft.id}`;
    const form = formFor("My changes");
    form.set("intent", "publish");
    form.set("signingView", signingViewToken({ userId, kind: "draft", id: draft.id, version: "1", title: null, body: "Initial draft", lang: "ja" }));
    await updateDraft(h.db, userId, draft.id, { body: "AI revises the draft", lang: "ja" });
    await expect(previewDraftPublication(h.db, userId, path, form)).rejects.toMatchObject({ code: "draft_conflict" });
    form.set("version", "2");
    expect(await previewDraftPublication(h.db, userId, path, form)).toMatchObject({
      current: { body: "AI revises the draft" }, viewed: { body: "Initial draft" }, content: { body: "My changes" },
    });
  });

  it("uses the draft language as a hint when previewing ambiguous Han text", async () => {
    const created = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "確認", lang: "ja" });
    if (!created.ok) throw new Error(created.error);
    const form = formFor("確認"); form.set("intent", "publish");
    const preview = await previewDraftPublication(h.db, h.ids.hana, `/drafts/${created.id}`, form);
    expect(preview.language).toEqual({ source: "explicit", detected: "ja" });
  });
  it("preserves the canonical AI client identity and edit time separately from its claimed name and website", async () => {
    const now = new Date();
    const created = await createDraft(h.db, h.ids.hana, { kind: "topic", body: "Complete AI draft", lang: "ja" }, { via: "api", now, client: { key: "oauth:test-client", id: "https://identity.example/client.json", name: "Claimed assistant", uri: "https://claimed.example" } });
    if (!created.ok) throw new Error(created.error);
    const form = formFor("Complete AI draft"); form.set("intent", "publish");
    const preview = await previewDraftPublication(h.db, h.ids.hana, `/drafts/${created.id}`, form);
    expect(preview.lastEditor).toEqual({ id: "https://identity.example/client.json", name: "Claimed assistant", uri: "https://claimed.example", at: now.toISOString() });
    expect(preview.content.body).toBe("Complete AI draft");
  });

});
