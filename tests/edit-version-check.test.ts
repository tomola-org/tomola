import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { entryEditVersion } from "~/lib/entry-edit-version.server";
import { sourceHash } from "~/lib/source-hash.server";
import { entries, entryRevisions, jobs, memberSignatures } from "~/lib/db/schema";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); await h.signIn("version_writer"); });
afterAll(() => h?.restore());

async function world(kind: "topic" | "reply") {
  const author = h.ids.version_writer;
  const topic = await createTopic(h.db, author, { title: "Title A", body: "Body A", lang: "en", asksStance: kind === "reply" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = kind === "reply" ? await createReply(h.db, author, topic.id, { body: "Body A", lang: "en", stanceTag: "agree" }) : null;
  if (reply && !reply.ok) throw new Error(reply.error);
  const id = reply?.ok ? reply.id : topic.id;
  const path = `/${kind === "topic" ? "t" : "c"}/${id}/edit`;
  const route = kind === "topic" ? await import("~/routes/topic-edit") : await import("~/routes/reply-edit");
  const load = () => route.loader(h.args(h.request(path, { as: "version_writer" }), { id: String(id) }));
  const row = async () => (await h.db.select().from(entries).where(eq(entries.id, id)))[0];
  const initial = await load();
  const input = { ...(kind === "topic" ? { title: "Title C" } : { stanceTag: "neither" }), body: "Body C", lang: "ja", editVersion: initial.editVersion };
  const request = (form: Record<string, string>) => h.request(path, { as: "version_writer", form });
  const submit = (req: Request) => h.outcome(() => route.action(h.args(req, { id: String(id) })));
  return { author, id, path, initial, input, request, submit, row, load };
}

for (const kind of ["topic", "reply"] as const) {
  it(`${kind}: rejects the old form on native and .data transports and preserves all submitted values`, async () => {
    const w = await world(kind);
    // Both screens opened A. The first screen saves B through the real route.
    expect(await w.submit(w.request({ ...w.input, body: "Body B" }))).toMatchObject({ status: 302 });
    const before = await w.row();
    const history = await h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, w.id));
    const work = await h.db.select().from(jobs);
    const signatures = await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, w.id));
    for (const transport of ["native", "data"]) {
      let req = w.request(w.input);
      if (transport === "data") req = new Request(`${req.url}.data`, { method: "POST", headers: req.headers, body: await req.text() });
      expect(await w.submit(req)).toMatchObject({ status: 409, value: { data: {
        error: "edit_conflict", values: { ...w.input, ...(kind === "reply" ? { stanceTag: "neither" } : {}) }, conflict: { href: w.path },
      } } });
      expect(await w.row()).toEqual(before);
      expect(await h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, w.id))).toEqual(history);
      expect(await h.db.select().from(jobs)).toEqual(work);
      expect(await h.db.select().from(memberSignatures).where(eq(memberSignatures.entryId, w.id))).toEqual(signatures);
    }
  });

  it(`${kind}: accepts A -> B -> A using the original form version, including legacy stored hashes`, async () => {
    const w = await world(kind);
    const before = await w.row();
    await h.db.update(entries).set({ sourceHash: sourceHash(before.title, before.body) }).where(eq(entries.id, w.id));
    expect((await w.load()).editVersion).toBe(w.initial.editVersion);
    expect(await editEntry(h.db, w.author, w.id, { title: "Title B", body: "Body B", lang: "ja", ...(kind === "reply" ? { stanceTag: "disagree" } : {}) })).toMatchObject({ ok: true });
    expect(await editEntry(h.db, w.author, w.id, { title: "Title A", body: "Body A", lang: "en", ...(kind === "reply" ? { stanceTag: "agree" } : {}) })).toMatchObject({ ok: true });
    expect((await w.load()).editVersion).toBe(w.initial.editVersion);
    expect(await w.submit(w.request(w.input))).toMatchObject({ status: 302 });
    expect(await w.row()).toMatchObject({ body: "Body C", lang: "ja" });
  });
}

it.each(["title", "lang", "stanceTag"] as const)("detects an independent change to %s before no-op or label-only submissions", async field => {
  const w = await world(field === "stanceTag" ? "reply" : "topic");
  const before = await w.row();
  const input = { title: before.title, body: before.body, [field]: field === "title" ? "Title B" : field === "lang" ? "ja" : "disagree" };
  expect(await editEntry(h.db, w.author, w.id, input)).toMatchObject({ ok: true });
  const current = await w.row();
  if (field === "stanceTag") expect(current.sourceHash).toBe(before.sourceHash);
  expect(await editEntry(h.db, w.author, w.id, { title: current.title, body: current.body, stanceTag: "neither" }, { expectedVersion: w.initial.editVersion })).toEqual({ ok: false, error: "edit_conflict" });
  expect(await w.row()).toEqual(current);
});

it("opts in even with an empty or malformed version, and keeps unversioned direct edits working", async () => {
  const w = await world("topic");
  for (const editVersion of ["", "invalid"]) {
    expect(await w.submit(w.request({ ...w.input, editVersion }))).toMatchObject({ status: 409, value: { data: { values: { editVersion } } } });
  }
  const { editVersion: _version, ...input } = w.input;
  expect(await w.submit(w.request(input))).toMatchObject({ status: 302 });
  expect(await editEntry(h.db, w.author, w.id, { title: "Direct", body: "Direct B" })).toMatchObject({ ok: true });
  expect(await editEntry(h.db, w.author, w.id, { title: "Direct", body: "Direct C" })).toMatchObject({ ok: true });
  expect(entryEditVersion(await w.row())).not.toBe(w.initial.editVersion);
});
