import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createReply, createTopic } from "~/lib/entries.server";
import { entries, entryRevisions, jobs, translations } from "~/lib/db/schema";
import { buildManifest } from "~/lib/md/manifest.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("source_corrector"); });
afterAll(() => h.restore());

it("corrects topic and reply languages through the real author routes", async () => {
  const userId = h.ids.source_corrector;
  const topic = await createTopic(h.db, userId, { title: "Existing title", body: "Existing body", lang: "ja" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, userId, topic.id, { body: "Existing reply", lang: "ja" });
  if (!reply.ok) throw new Error(reply.error);
  for (const [kind, id, body] of [["topic", topic.id, "Existing body"], ["reply", reply.id, "Existing reply"]] as const) {
    const manifestBefore = (await buildManifest(h.db, { after: 0, k: null })).topics.find(t => t.id === `p-${topic.id}`)!.content_hash;
    const [before] = await h.db.select().from(entries).where(eq(entries.id, id));
    await h.db.insert(translations).values({ entryId: id, field: "body", lang: "en", kind: "human", text: "Discard this translation", sourceHash: before.sourceHash });
    await h.db.update(entries).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(entries.id, id));
    const path = `/${kind === "topic" ? "t" : "c"}/${id}/edit`;
    const request = h.request(path, { as: "source_corrector", form: { ...(kind === "topic" ? { title: "Existing title" } : {}), body, lang: "en" } });
    const route = kind === "topic" ? await import("~/routes/topic-edit") : await import("~/routes/reply-edit");
    expect(await h.outcome(() => route.action(h.args(request, { id: String(id) })))).toMatchObject({ status: 302 });
    expect((await h.db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "en", body, mentionRevision: 1 });
    expect((await buildManifest(h.db, { after: 0, k: null })).topics.find(t => t.id === `p-${topic.id}`)!.content_hash).not.toBe(manifestBefore);
    expect(await h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id))).toHaveLength(1);
    expect(await h.db.select().from(translations).where(eq(translations.entryId, id))).toEqual([]);
    const work = (await h.db.select().from(jobs).where(and(eq(jobs.kind, "translate_entry"), eq(jobs.status, "queued")))).filter(j => (j.payload as { entryId: number }).entryId === id);
    expect(work.length).toBeGreaterThan(0);
    expect(work.every(j => (j.payload as { lang: string }).lang !== "en")).toBe(true);
  }
});

it("edits topic and reply bodies without changing their closed language", async () => {
  const userId = h.ids.source_corrector;
  vi.stubEnv("ENABLED_LANGS", "ja,en,vi");
  try {
    const topic = await createTopic(h.db, userId, { title: "Existing title", body: "Existing body", lang: "vi" });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(h.db, userId, topic.id, { body: "Existing reply", lang: "vi" });
    if (!reply.ok) throw new Error(reply.error);
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    for (const [kind, id] of [["topic", topic.id], ["reply", reply.id]] as const) {
      await h.db.update(entries).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(entries.id, id));
      const path = `/${kind === "topic" ? "t" : "c"}/${id}/edit`;
      const body = `Corrected ${kind} body`;
      const request = h.request(path, { as: "source_corrector", form: { ...(kind === "topic" ? { title: "Existing title" } : {}), body, lang: "vi" } });
      const route = kind === "topic" ? await import("~/routes/topic-edit") : await import("~/routes/reply-edit");
      expect(await h.outcome(() => route.action(h.args(request, { id: String(id) })))).toMatchObject({ status: 302 });
      expect((await h.db.select().from(entries).where(eq(entries.id, id)))[0]).toMatchObject({ lang: "vi", body, mentionRevision: 1 });
      expect(await h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id))).toHaveLength(1);
    }
  } finally { vi.unstubAllEnvs(); }
});
