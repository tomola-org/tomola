import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as aiVisibleText from "~/lib/ai-visible-text.server";
import { drafts, entries, follows, jobs, notifications, postAiMaterials, profiles, rateLimits, villageMembers, villages } from "~/lib/db/schema";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { hitMemberLimit, MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { action as createTopicAction } from "~/routes/topic-new";
import { action as topicAction, loader as topicLoader } from "~/routes/topic";
import { action as aiDraftAction } from "~/routes/ai-draft";
import { setupRouteHarness, type Outcome, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let writer: string;
let thread: number;
const queries: string[] = [];

beforeAll(async () => {
  h = await setupRouteHarness({ logger: { logQuery: query => { queries.push(query); } } });
  writer = await h.signIn("repeat_writer", { homeArea: "en", readLangs: ["en", "ja"] });
  await h.signIn("repeat_reader");
  await h.signIn("repeat_neighbor");
  thread = idOf(await createTopic(h.db, h.ids.repeat_reader, { title: "Discussion", body: "A place for replies.", lang: "en", asksStance: true }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await h.db.delete(rateLimits);
  queries.length = 0;
});
afterAll(() => h.restore());

const kinds = ["topic", "reply"] as const;
const submitTopic = (form: Record<string, string>, path = "/t/new", as = "repeat_writer") =>
  h.outcome(() => createTopicAction(h.args(h.request(path, { as, form }))));
const submitReply = (form: Record<string, string>, threadId = thread, hydrated = false) =>
  h.outcome(() => topicAction(h.args(h.request(`/t/${threadId}${hydrated ? ".data" : ""}`, { as: "repeat_writer", form }), { id: String(threadId) })));
const entryRows = (kind: typeof kinds[number], body: string) =>
  h.db.select().from(entries).where(and(eq(entries.authorId, writer), eq(entries.kind, kind), eq(entries.body, body)));
const noticesFor = (id: number) => h.db.select().from(notifications).where(eq(notifications.entryId, id));
const state = async () => ({
  jobs: await h.db.select().from(jobs).orderBy(jobs.id),
  notices: await h.db.select().from(notifications).orderBy(notifications.id),
  follows: await h.db.select().from(follows).orderBy(follows.threadId, follows.userId),
});

function idOf(result: { ok: true; id: number } | { ok: false; error: string }) {
  if (!result.ok) throw new Error(result.error);
  return result.id;
}

function postedId(outcome: Outcome) {
  expect(outcome.status, JSON.stringify(outcome.value)).toBe(302);
  const id = Number(new URL(outcome.location!, "http://localhost").searchParams.get("posted"));
  expect(id).toBeGreaterThan(0);
  return id;
}

it.each(kinds)("reuses a %s across hydrated and native submission with one set of effects", async kind => {
  const form = { body: `A ${kind} for @repeat_reader`, lang: "en" };
  const first = kind === "topic" ? await submitTopic(form, "/t/new.data") : await submitReply({ ...form, intent: "reply" }, thread, true);
  const id = postedId(first);
  const afterFirst = await state();
  expect(afterFirst.jobs.some(job => job.kind === "translate_entry" && (job.payload as { entryId?: number }).entryId === id)).toBe(true);
  expect(await noticesFor(id)).toEqual([expect.objectContaining({ userId: h.ids.repeat_reader })]);
  if (kind === "reply") expect(first.location).toContain("followed=1");
  const again = await (kind === "topic" ? submitTopic(form) : submitReply(form));
  expect(again).toMatchObject({ status: 302, location: first.location });
  expect(await entryRows(kind, form.body)).toMatchObject([{ id }]);
  expect(await state()).toEqual(afterFirst);
  if (kind === "reply") {
    const [topic] = await h.db.select({ replyCount: entries.replyCount }).from(entries).where(eq(entries.id, thread));
    expect(topic.replyCount).toBe(1);
  }
});

for (const kind of kinds) {
  const submit = kind === "topic" ? submitTopic : submitReply;

  it.each(["different body", "deleted", "edited"] as const)(`creates a new ${kind} with a nonmatching candidate (%s)`, async condition => {
    const form = { body: `${kind} comparison: ${condition}`, lang: "en" };
    const id = postedId(await submit(form));
    if (condition === "deleted") expect(await softDeleteEntry(h.db, id)).toMatchObject({ ok: true });
    if (condition === "edited") expect(await editEntry(h.db, writer, id, { body: "A revised source." })).toMatchObject({ ok: true, changed: true });
    expect(postedId(await submit(condition === "different body" ? { ...form, body: "A different source." } : form))).not.toBe(id);
  });

  it(`matches a ${kind} through the exact ten-minute boundary`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const form = { body: `A ${kind} at the edge of the window.`, lang: "en" };
    const first = await submit(form);
    const id = postedId(first);
    vi.setSystemTime(start + 10 * 60 * 1000);
    expect(await submit(form)).toMatchObject({ status: 302, location: first.location });
    vi.setSystemTime(start + 10 * 60 * 1000 + 1);
    expect(postedId(await submit(form))).not.toBe(id);
  });

  it.each([
    { body: "Ο φίλος μου διαβάζει ένα μεγάλο βιβλίο.", code: "el" },
    { body: "A brief note.", code: null },
  ])(`matches a ${kind} with the same stored language code ($code)`, async ({ body, code }) => {
    const form = { body, lang: "other" };
    const id = postedId(await submit(form));
    expect(await entryRows(kind, body)).toMatchObject([{ id, lang: "other", langCode: code }]);
    await h.db.update(entries).set({ langCode: "hy" }).where(eq(entries.id, id));
    const current = await submit(form);
    expect(postedId(current)).not.toBe(id);
    expect(await submit(form)).toMatchObject({ status: 302, location: current.location });
  });

  it(`opens the existing ${kind} for its author after automatic hiding`, async () => {
    const form = { body: `A hidden ${kind} remains the same entry.`, lang: "en" };
    const first = await submit(form);
    const id = postedId(first);
    await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
    expect(await submit(form)).toMatchObject({ status: 302, location: first.location });
    expect(await entryRows(kind, form.body)).toMatchObject([{ id }]);
    const location = new URL(first.location!, "http://localhost");
    const result = await topicLoader(h.args(h.request(location.pathname + location.search, { as: "repeat_writer" }), { id: String(kind === "topic" ? id : thread) }));
    expect(result).toMatchObject(kind === "topic" ? { topic: { id, placeholder: null } } : { replies: expect.arrayContaining([expect.objectContaining({ id, placeholder: null })]) });
  });

  it(`keeps the success redirect for a ${kind} at the posting limit`, async () => {
    const form = { body: `---\ntype: ${kind}\nlang: en\n---\n\nAn accepted ${kind} at the limit.` };
    for (let count = 1; count < MEMBER_RATE_LIMITS[kind].limit; count++) await hitMemberLimit(h.db, kind, writer);
    const first = await submit(form);
    postedId(first);
    queries.length = 0;
    expect(await submit(form)).toMatchObject({ status: 302, location: first.location });
    expect(queries.some(query => query.includes("nextval("))).toBe(false);
    queries.length = 0;
    const response = await submit({ body: `A different ${kind} mentioning [the question](/t/${thread}).`, lang: "en",
      ...(kind === "topic" ? { altOf: String(thread), title: "Another question", asksStance: "1" } : {}) });
    expect(response).toMatchObject({ status: 429, value: { data: { error: "rate_limited" } } });
    const entryQueries = queries.filter(query => query.includes('"entries"'));
    expect(entryQueries).toEqual([expect.stringMatching(/^select "id" from "entries".*"author_id".*"created_at".*"deleted_at".*"kind".*"body".*limit/)]);
    expect(queries.filter(query => /\bfor (?:no key )?update\b|^begin\b/i.test(query))).toEqual([]);
  });

  it(`opens the published ${kind} on a repeated submission from Write with AI`, async () => {
    const form = { body: `A ${kind} from the writing screen.`, lang: "en" };
    const saved = await aiDraftAction(h.args(h.request("/ai/draft", {
      as: "repeat_writer", form: { ...form, ownerId: writer, kind, ...(kind === "reply" ? { threadId: String(thread) } : {}) },
    })));
    expect(saved.status).toBe(200);
    const draft = await saved.json();
    const linked = { ...form, fromDraft: String(draft.id), fromDraftVersion: "1" };
    const first = await submit(linked);
    const id = postedId(first);
    expect(await h.db.select().from(drafts).where(eq(drafts.id, draft.id))).toEqual([]);
    expect(await submit(linked)).toMatchObject({ status: 302, location: first.location });
    expect(await entryRows(kind, form.body)).toMatchObject([{ id }]);
  });

  it(`publishes a ${kind} from the drafts screen even when matching writing exists`, async () => {
    const form = { body: `A ${kind} for the drafts screen.`, lang: "en" };
    const first = postedId(await submit(form));
    const draftId = idOf(await createDraft(h.db, writer, { ...form, kind, ...(kind === "reply" ? { threadId: thread } : {}) }));
    expect(idOf(await publishDraft(h.db, writer, draftId))).not.toBe(first);
    expect(await publishDraft(h.db, writer, draftId)).toEqual({ ok: false, error: "not_found" });
    expect(await entryRows(kind, form.body)).toHaveLength(2);
  });
}

it("keeps response notifications on the first topic", async () => {
  const other = idOf(await createTopic(h.db, h.ids.repeat_neighbor, { body: "Another discussion.", lang: "en" }));
  const form = { title: "Shared response", body: "The same response text.", lang: "en" };
  const first = await submitTopic(form, `/t/new?respond=${thread}`);
  const id = postedId(first);
  const afterFirst = await state();
  expect(await submitTopic(form, `/t/new?respond=${other}`)).toMatchObject({ status: 302, location: first.location });
  expect(await entryRows("topic", form.body)).toMatchObject([{ id }]);
  expect(await noticesFor(id)).toMatchObject([{ kind: "response_to_topic", userId: h.ids.repeat_reader, threadId: thread }]);
  expect(await state()).toEqual(afterFirst);
});

it("keeps the original introduction and supplement on a repeat", async () => {
  const form = { title: "Introduction", body: "This is my introduction.", lang: "en" };
  const parseStartingAt: number[] = [];
  const parse = aiVisibleText.aiVisibleMarkdown;
  vi.spyOn(aiVisibleText, "aiVisibleMarkdown").mockImplementation((...args) => {
    parseStartingAt.push(queries.length);
    return parse(...args);
  });
  queries.length = 0;
  const first = await submitTopic({ ...form, aiMaterial: "Original supplement." });
  const id = postedId(first);
  expect(parseStartingAt).toHaveLength(1);
  expect(queries.slice(0, parseStartingAt[0]).some(query => /^begin\b/i.test(query))).toBe(false);
  const laterIntro = postedId(await submitTopic({ ...form, intro: "1", body: "My current introduction." }));
  expect(await submitTopic({ ...form, intro: "1", aiMaterial: "Updated supplement." })).toMatchObject({ status: 302, location: first.location });
  expect(await h.db.select().from(postAiMaterials).where(eq(postAiMaterials.topicId, id))).toMatchObject([{ body: "Original supplement.", version: 1 }]);
  expect(await h.db.select({ introEntryId: profiles.introEntryId }).from(profiles).where(eq(profiles.userId, writer))).toEqual([{ introEntryId: laterIntro }]);
});

it("distinguishes topic author, title, language, question setting and alternative framing", async () => {
  const form = { title: "Shared title", body: "Identical words.", lang: "en" };
  const first = postedId(await submitTopic(form));
  const results = [
    postedId(await submitTopic({ ...form, title: "Another title" })),
    postedId(await submitTopic({ ...form, lang: "ja" })),
    postedId(await submitTopic({ ...form, asksStance: "1" })),
    postedId(await submitTopic({ ...form, asksStance: "1", altOf: String(thread) })),
    postedId(await submitTopic(form, "/t/new", "repeat_neighbor")),
  ];
  expect(new Set([first, ...results]).size).toBe(6);
});

it("distinguishes topics in different villages and matches the resolved village", async () => {
  vi.stubEnv("VILLAGES", "1");
  const places = await h.db.insert(villages).values([{ slug: "repeat-east", kind: "open" }, { slug: "repeat-west", kind: "open" }]).returning();
  await h.db.insert(villageMembers).values(places.map(place => ({ villageId: place.id, userId: writer, role: "owner" })));
  const submitIn = (slug: string) => submitTopic({ body: "Shared village announcement.", lang: "en", village: slug, villageExplicit: "1", villageDisplayed: slug });
  const east = await submitIn(places[0].slug!);
  const west = await submitIn(places[1].slug!);
  expect(postedId(west)).not.toBe(postedId(east));
  expect(await submitIn(places[0].slug!)).toMatchObject({ status: 302, location: east.location });
});

it("distinguishes the thread, parent reply and stance tag", async () => {
  const other = idOf(await createTopic(h.db, h.ids.repeat_reader, { body: "Another question.", title: "Question", asksStance: true, lang: "en" }));
  const parent = idOf(await createReply(h.db, h.ids.repeat_reader, thread, { body: "An earlier reply.", lang: "en" }));
  const form = { body: "The same reply text.", lang: "en" };
  const results = [
    postedId(await submitReply(form)),
    postedId(await submitReply(form, other)),
    postedId(await submitReply({ ...form, parentId: String(parent) })),
    postedId(await submitReply({ ...form, stanceTag: "agree" })),
  ];
  expect(new Set(results).size).toBe(4);
});
