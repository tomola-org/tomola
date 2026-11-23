import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { deleteAccount } from "~/lib/account-delete.server";
import type { AiQuestionAnswer, AiQuestionCitation } from "~/lib/ai-questions";
import { appeals, chatMessages, chatMessageTranslations, chatNushiRequests, chatNushiReservations, chatNushiSources, entries, moderationActions, nushiAnswers, nushiRequests, nushiReservations, nushiSources, nushiTranslations, retentionHold, villages } from "~/lib/db/schema";
import { DELETED_MEMBER_HANDLE } from "~/lib/deleted-member";
import { pruneDeletedEntries } from "~/lib/entry-retention.server";
import { softDeleteEntry } from "~/lib/entries.server";
import type { RetentionResults } from "~/lib/retention-batch.server";
import { runRetentionCleanup } from "~/lib/retention.server";
import { addMember, createTestDb } from "./helpers/db";
import { chatSourceHash } from "~/lib/village-chat-translations.server";
import { auditRetentionTransactions, expectBoundedTransactions } from "./helpers/retention";

const NOW = new Date("2030-03-31T00:00:01Z");
const DELETED = new Date("2030-03-01T00:00:00Z");
const ORIGINAL = "The spring orchard schedule is tentative.";
const TRANSLATED = "春の果樹園の日程は仮のものです。";
const OTHER = "Keep the path along the river open.";

async function fixture() {
  const db = await createTestDb();
  await addMember(db, "orchard", "orchard_writer");
  await addMember(db, "river", "river_writer");
  const [village] = await db.insert(villages).values({ name: "Orchard village", slug: "orchard-village", kind: "open", createdBy: "river" }).returning();
  const [topic, source, other] = await db.insert(entries).values([
    { kind: "topic", authorId: "river", lang: "en", villageId: village.id, body: "Orchard and river notes." },
    { kind: "topic", authorId: "orchard", lang: "en", villageId: village.id, body: ORIGINAL, sourceHash: "orchard-hash" },
    { kind: "topic", authorId: "river", lang: "en", villageId: village.id, body: OTHER },
  ]).returning();
  const quote = (id: number, author: string, text: string): AiQuestionCitation => ({
    sourceId: `e-${id}-body`, kind: "post", field: "body", author,
    original: { quote: text, lang: "en", href: `/t/${id}#:~:text=${encodeURIComponent(text)}` },
  });
  const orchardQuote = { ...quote(source.id, "@orchard_writer", ORIGINAL), translation: { quote: TRANSLATED, lang: "ja", href: `/t/${source.id}?lang=ja`, stale: false } } as const;
  const riverQuote = quote(other.id, "@river_writer", OTHER);
  const call = { entryId: topic.id, threadId: topic.id, villageId: village.id, callerId: "river", revision: 0, sourceHash: "call", state: "answered", expiresAt: NOW };
  const [request] = await db.insert(nushiRequests).values(call).returning();
  const answer: AiQuestionAnswer = { status: "answered", readings: [
    { text: "＠ＯＲＣＨＡＲＤ_writer suggests a tentative schedule.", citations: [1] },
    { text: "@river_writer wants to preserve access.", citations: [2] },
  ], citations: [orchardQuote, riverQuote] };
  const [saved] = await db.insert(nushiAnswers).values({
    requestId: request.id, answer,
    scope: { posts: 2, from: null, to: null, truncated: false, materialLanguage: "en", answerLangCode: null, materialIndex: [] },
    lang: "en", engine: "fake", model: "fake", promptVersion: "fixture",
  }).returning();
  await db.insert(nushiSources).values([source, other].map((entry, index) => ({
    answerId: saved.id, entryId: entry.id, authorId: entry.authorId, author: answer.citations[index].author,
    sourceHash: "fixture", createdAt: entry.createdAt, revision: 0,
  })));
  return { db, source, other, village, call, request, saved, orchardQuote, riverQuote };
}

it("erases one source's original, translation, author and readings after the cutoff", async () => {
  const f = await fixture();
  const [replacement] = await f.db.insert(nushiRequests).values({ ...f.call, replacesAnswerId: f.saved.id }).returning();
  const [successor] = await f.db.insert(nushiAnswers).values({
    requestId: replacement.id, answer: { status: "not_confirmed", readings: [], citations: [] }, scope: f.saved.scope,
    lang: "en", engine: "fake", model: "fake", promptVersion: "fixture",
  }).returning();
  await f.db.update(nushiAnswers).set({ hiddenAt: DELETED, hiddenReason: "superseded", supersededById: successor.id }).where(eq(nushiAnswers.id, f.saved.id));
  await softDeleteEntry(f.db, f.source.id, { now: DELETED });
  await f.db.insert(nushiTranslations).values({ answerId: f.saved.id, lang: "ja", readings: [TRANSLATED], engine: "fake", model: "fake" });
  await pruneDeletedEntries(f.db, new Date(NOW.getTime() - 1000));
  expect((await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.id, f.saved.id)))[0].answer).toEqual(f.saved.answer);
  await pruneDeletedEntries(f.db, NOW);
  const [after] = await f.db.select().from(nushiAnswers).where(eq(nushiAnswers.id, f.saved.id));
  expect(after).toMatchObject({ id: f.saved.id, requestId: f.request.id, hiddenAt: DELETED, hiddenReason: "superseded", supersededById: successor.id });
  expect(after.answer).toEqual({ status: "answered", citations: [f.riverQuote], readings: [{ text: "@river_writer wants to preserve access.", citations: [1] }] });
  const links = await f.db.select().from(nushiSources);
  expect(links).toEqual(expect.arrayContaining([expect.objectContaining({ entryId: f.source.id, author: "" }), expect.objectContaining({ entryId: f.other.id, author: "@river_writer" })]));
  expect(await f.db.select().from(nushiTranslations)).toEqual([]);
  expect((await f.db.select().from(entries).where(eq(entries.id, f.source.id)))[0].body).toBe("");
});

it.each(["hold", "appeal", "operator deletion"])("keeps Nushi copies under %s", async protectedBy => {
  const f = await fixture();
  await softDeleteEntry(f.db, f.source.id, { now: DELETED });
  if (protectedBy === "hold") await f.db.update(retentionHold).set({ active: true });
  else {
    const [action] = await f.db.insert(moderationActions).values({ targetEntryId: f.source.id, action: protectedBy === "appeal" ? "hide" : "delete", actorId: "river", reason: "other" }).returning();
    if (protectedBy === "appeal") await f.db.insert(appeals).values({ actionId: action.id, appellantId: "orchard", text: "Please review." });
    else await f.db.update(entries).set({ moderationActionId: action.id }).where(eq(entries.id, f.source.id));
  }
  await pruneDeletedEntries(f.db, NOW);
  expect((await f.db.select().from(nushiAnswers))[0].answer).toEqual(f.saved.answer);
  expect((await f.db.select().from(nushiSources).where(eq(nushiSources.entryId, f.source.id)))[0].author).toBe("@orchard_writer");
});

async function chatCopies(f: Awaited<ReturnType<typeof fixture>>) {
  const [call, answer] = await f.db.insert(chatMessages).values([
    { body: "Orchard update?", villageId: f.village.id, authorId: "river", lang: "en", createdSeq: 1, changedSeq: 1 },
    { body: ORIGINAL, villageId: f.village.id, authorKind: "nushi", lang: "en", createdSeq: 2, changedSeq: 2, hiddenAt: DELETED },
  ]).returning();
  const [request] = await f.db.insert(chatNushiRequests).values({ villageId: f.village.id, callerId: "river", messageId: call.id, answerMessageId: answer.id, expiresAt: NOW, state: "answered" }).returning();
  return { request, answer };
}

it("drains legacy answer, chat and translation copies for an already empty post", async () => {
  const f = await fixture();
  await f.db.update(entries).set({ body: "", sourceHash: null, deletedAt: DELETED }).where(eq(entries.id, f.source.id));
  await f.db.update(nushiAnswers).set({ answer: { status: "answered", citations: [f.orchardQuote], readings: [f.saved.answer.readings[0]] } }).where(eq(nushiAnswers.id, f.saved.id));
  const chat = await chatCopies(f);
  await f.db.insert(chatNushiSources).values({ requestId: chat.request.id, entryId: f.source.id, revision: 0, sourceHash: "fixture" });
  await f.db.insert(chatMessageTranslations).values({ messageId: chat.answer.id, lang: "ja", sourceHash: chatSourceHash(chat.answer.body), text: TRANSLATED, state: "ready" });
  const results: RetentionResults = {};
  expect((await pruneDeletedEntries(f.db, NOW, results)).entries).toBe(0);
  expect(results.entry_content).toMatchObject({ removed: 4, remaining: 0, stop: "complete" });
  expect((await f.db.select().from(nushiAnswers))[0].answer).toEqual({ status: "not_confirmed", readings: [], citations: [] });
  expect((await f.db.select().from(chatMessages).where(eq(chatMessages.id, chat.answer.id)))[0]).toMatchObject({ body: "", hiddenAt: DELETED });
  expect(await f.db.select().from(chatMessageTranslations)).toEqual([]);
  await pruneDeletedEntries(f.db, NOW, results);
  expect(results.entry_content).toMatchObject({ removed: 0, remaining: 0, stop: "complete" });
});

it("drains source copies across bounded transactions", async () => {
  const f = await fixture();
  const requests = await f.db.insert(nushiRequests).values(Array.from({ length: 50 }, () => f.call)).returning();
  const answers = await f.db.insert(nushiAnswers).values(requests.map(request => ({
    requestId: request.id, answer: f.saved.answer, scope: f.saved.scope,
    lang: f.saved.lang, engine: f.saved.engine, model: f.saved.model, promptVersion: f.saved.promptVersion,
  }))).returning();
  await f.db.insert(nushiSources).values(answers.map(answer => ({
    answerId: answer.id, entryId: f.source.id, author: "@orchard_writer", authorId: "orchard", createdAt: f.source.createdAt, sourceHash: "fixture", revision: 0,
  })));
  await softDeleteEntry(f.db, f.source.id, { now: DELETED });
  await auditRetentionTransactions(f.db, [entries, nushiAnswers, nushiSources]);
  await pruneDeletedEntries(f.db, NOW);
  expect((await f.db.select().from(nushiSources).where(eq(nushiSources.entryId, f.source.id))).every(source => source.author === "")).toBe(true);
  await expectBoundedTransactions(f.db, 103);
});

it.each(["keep", "delete"] as const)("anonymizes saved Nushi attribution when departing with posts set to %s", async posts => {
  const f = await fixture();
  const chat = await chatCopies(f);
  for (const [table, requestId] of [[nushiReservations, f.request.id], [chatNushiReservations, chat.request.id]] as const) {
    await f.db.insert(table).values(["member:orchard", "author:orchard", "member:river"].map(key => ({ requestId, key, day: "2030-03-01" })));
  }
  await deleteAccount(f.db, "orchard", { confirmation: "orchard_writer", posts }, { now: DELETED });
  const [after] = await f.db.select().from(nushiAnswers);
  expect(after.answer.citations).toEqual([{ ...f.orchardQuote, author: DELETED_MEMBER_HANDLE }, f.riverQuote]);
  expect(after.answer.readings[0].text).toBe(`${DELETED_MEMBER_HANDLE} suggests a tentative schedule.`);
  expect((await f.db.select().from(nushiSources).where(eq(nushiSources.entryId, f.source.id)))[0].author).toBe(DELETED_MEMBER_HANDLE);
  for (const table of [nushiReservations, chatNushiReservations]) expect(await f.db.select({ key: table.key }).from(table)).toEqual([{ key: "member:river" }]);
  await pruneDeletedEntries(f.db, NOW);
  expect((await f.db.select().from(nushiAnswers))[0].answer.citations).toEqual(posts === "keep" ? after.answer.citations : [f.riverQuote]);
});

it("prunes expired UTC days from both quota tables while retaining today's reservations", async () => {
  const f = await fixture();
  const chat = await chatCopies(f);
  for (const [table, requestId] of [[nushiReservations, f.request.id], [chatNushiReservations, chat.request.id]] as const) {
    await f.db.insert(table).values([{ requestId, key: "member:orchard", day: "2030-03-30" }, { requestId, key: "member:river", day: "2030-03-31" }]);
  }
  const result = await runRetentionCleanup(f.db, NOW);
  for (const category of ["nushi_reservations", "chat_nushi_reservations"]) expect(result[category]).toMatchObject({ removed: 1, remaining: 0 });
  for (const table of [nushiReservations, chatNushiReservations]) expect(await f.db.select({ key: table.key }).from(table)).toEqual([{ key: "member:river" }]);
  expect(await f.db.select().from(nushiRequests)).toHaveLength(1);
  expect(await f.db.select().from(chatNushiRequests)).toHaveLength(1);
});
