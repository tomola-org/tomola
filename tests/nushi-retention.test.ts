import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { deleteAccount } from "~/lib/account-delete.server";
import type { AiQuestionAnswer, AiQuestionCitation } from "~/lib/ai-questions";
import { appeals, chatMessages, chatMessageTranslations, chatNushiRequests, chatNushiReservations, chatNushiSources, chatSequences, entries, moderationActions, nushiAnswers, nushiReports, nushiRequests, nushiReservations, nushiSources, nushiTranslations, retentionHold, villages } from "~/lib/db/schema";
import { DELETED_MEMBER_HANDLE } from "~/lib/deleted-member";
import { pruneDeletedEntries } from "~/lib/entry-retention.server";
import { softDeleteEntry } from "~/lib/entries.server";
import { nushiCounts, readNushiAnswer } from "~/lib/nushi.server";
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
const RIVER_HANDLE = "@orchard_writer2";

afterEach(() => vi.unstubAllEnvs());

async function fixture(options: { titleOnly?: boolean; sourcePurged?: boolean } = {}) {
  const db = await createTestDb();
  await addMember(db, "orchard", "orchard_writer");
  await addMember(db, "river", RIVER_HANDLE.slice(1));
  const [village] = await db.insert(villages).values({ name: "Orchard village", slug: "orchard-village", kind: "open", createdBy: "river" }).returning();
  const [topic, source, other] = await db.insert(entries).values([
    { kind: "topic", authorId: "river", lang: "en", villageId: village.id, body: "Orchard and river notes." },
    { kind: "topic", authorId: "orchard", lang: "en", villageId: village.id, body: options.titleOnly || options.sourcePurged ? "" : ORIGINAL,
      title: options.titleOnly ? ORIGINAL : null, sourceHash: options.sourcePurged ? null : "orchard-hash", deletedAt: options.sourcePurged ? DELETED : null },
    { kind: "topic", authorId: "river", lang: "en", villageId: village.id, body: OTHER },
  ]).returning();
  const quote = (id: number, author: string, text: string, field: "title" | "body" = "body"): AiQuestionCitation => ({
    sourceId: `e-${id}-${field}`, kind: "post", field, author,
    original: { quote: text, lang: "en", href: `/t/${id}#:~:text=${encodeURIComponent(text)}` },
  });
  const orchardQuote = { ...quote(source.id, "@orchard_writer", ORIGINAL, options.titleOnly ? "title" : "body"), translation: { quote: TRANSLATED, lang: "ja", href: `/t/${source.id}?lang=ja`, stale: false } } as const;
  const riverQuote = quote(other.id, RIVER_HANDLE, OTHER);
  const call = { entryId: topic.id, threadId: topic.id, villageId: village.id, callerId: "river", revision: 0, sourceHash: "call", state: "answered", expiresAt: NOW };
  const [request] = await db.insert(nushiRequests).values(call).returning();
  const answer: AiQuestionAnswer = { status: "answered", readings: [
    { text: "＠ＯＲＣＨＡＲＤ_writer suggests a tentative schedule.", citations: [1] },
    { text: `${RIVER_HANDLE} wants to preserve access.`, citations: [2] },
  ], citations: [orchardQuote, riverQuote] };
  const [saved] = await db.insert(nushiAnswers).values({
    requestId: request.id, answer,
    scope: { posts: 2, from: null, to: null, truncated: false, materialLanguage: "en", answerLangCode: null, materialIndex: answer.citations.map(citation => ({
      id: citation.sourceId, chars: citation.original.quote.length, translation: { chars: 20, hash: `${citation.sourceId}-translation` },
    })) },
    lang: "en", engine: "fake", model: "fake", promptVersion: "fixture",
  }).returning();
  await db.insert(nushiSources).values([source, other].map((entry, index) => ({
    answerId: saved.id, entryId: entry.id, authorId: entry.authorId, author: answer.citations[index].author,
    sourceHash: "fixture", textHash: "fixture-text", createdAt: entry.createdAt, revision: 0,
  })));
  return { db, topic, source, other, village, call, request, saved, quote, orchardQuote, riverQuote };
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
  expect(after.answer).toEqual({ status: "answered", citations: [f.riverQuote], readings: [{ text: f.saved.answer.readings[1].text, citations: [1] }] });
  expect(after.scope.materialIndex).toEqual([{ id: f.orchardQuote.sourceId, chars: ORIGINAL.length }, f.saved.scope.materialIndex[1]]);
  const links = await f.db.select().from(nushiSources);
  expect(links).toEqual(expect.arrayContaining([
    expect.objectContaining({ entryId: f.source.id, author: "", textHash: null, sourceHash: "" }),
    expect.objectContaining({ entryId: f.other.id, author: RIVER_HANDLE, textHash: "fixture-text", sourceHash: "fixture" }),
  ]));
  expect(await f.db.select().from(nushiTranslations)).toEqual([]);
  expect((await f.db.select().from(entries).where(eq(entries.id, f.source.id)))[0].body).toBe("");
});

it("renumbers successive erasures including a title-only source", async () => {
  const f = await fixture({ titleOnly: true });
  const retained = f.quote(f.topic.id, RIVER_HANDLE, f.topic.body);
  const reading = { text: "The topic summarizes the discussion.", citations: [3] };
  await f.db.update(nushiAnswers).set({ answer: { ...f.saved.answer,
    citations: [...f.saved.answer.citations, retained], readings: [...f.saved.answer.readings, reading],
  } }).where(eq(nushiAnswers.id, f.saved.id));
  await f.db.insert(nushiSources).values({ answerId: f.saved.id, entryId: f.topic.id, authorId: "river", author: RIVER_HANDLE, sourceHash: "fixture", createdAt: f.topic.createdAt, revision: 0 });
  await softDeleteEntry(f.db, f.source.id, { now: DELETED });
  await pruneDeletedEntries(f.db, NOW);
  expect((await f.db.select().from(nushiAnswers))[0].answer).toMatchObject({ citations: [f.riverQuote, retained], readings: [{ ...f.saved.answer.readings[1], citations: [1] }, { ...reading, citations: [2] }] });

  await softDeleteEntry(f.db, f.other.id, { now: NOW });
  await pruneDeletedEntries(f.db, new Date("2030-05-01T00:00:00Z"));
  expect((await f.db.select().from(nushiAnswers))[0].answer).toEqual({ status: "answered", citations: [retained], readings: [{ ...reading, citations: [1] }] });
});

it("clears a remaining translation fingerprint and records the source withdrawal", async () => {
  vi.stubEnv("VILLAGE_NUSHI", "1");
  vi.stubEnv("VILLAGES", "1");
  vi.stubEnv("PUBLIC_READING", "1");
  const f = await fixture({ sourcePurged: true });
  await f.db.update(nushiSources).set({ author: "", sourceHash: "", textHash: null }).where(eq(nushiSources.entryId, f.source.id));
  expect(await readNushiAnswer(f.db, f.saved.id)).toMatchObject({ hidden: true, reason: "source_changed" });
  expect(await nushiCounts(f.db, [f.topic.id])).toEqual(new Map([[f.topic.id, 1]]));
  const results: RetentionResults = {};
  await pruneDeletedEntries(f.db, NOW, results);
  expect((await f.db.select().from(nushiAnswers))[0]).toMatchObject({
    hiddenAt: NOW, hiddenReason: "source_changed", scope: { materialIndex: [{ id: f.orchardQuote.sourceId, chars: ORIGINAL.length }, f.saved.scope.materialIndex[1]] },
  });
  expect(results.entry_content).toMatchObject({ removed: 2, remaining: 0 });
  expect(await nushiCounts(f.db, [f.topic.id])).toEqual(new Map());
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

async function chatCopies(f: Awaited<ReturnType<typeof fixture>>, hiddenAt: Date | null = DELETED) {
  const [call, answer] = await f.db.insert(chatMessages).values([
    { body: "Orchard update?", villageId: f.village.id, authorId: "river", lang: "en", createdSeq: 1, changedSeq: 1 },
    { body: `@orchard_writer: ${ORIGINAL}`, villageId: f.village.id, authorKind: "nushi", lang: "en", createdSeq: 2, changedSeq: 2, hiddenAt },
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
  expect(results.entry_content).toMatchObject({ removed: 5, remaining: 0, stop: "complete" });
  expect((await f.db.select().from(nushiAnswers))[0].answer).toEqual({ status: "not_confirmed", readings: [], citations: [] });
  expect((await f.db.select().from(chatMessages).where(eq(chatMessages.id, chat.answer.id)))[0]).toMatchObject({ body: "", hiddenAt: DELETED });
  expect(await f.db.select().from(chatMessageTranslations)).toEqual([]);
  expect(await f.db.select().from(chatNushiSources)).toMatchObject([{ entryId: f.source.id, sourceHash: "" }]);
  await pruneDeletedEntries(f.db, NOW, results);
  expect(results.entry_content).toMatchObject({ removed: 0, remaining: 0, stop: "complete" });
});

it("leaves visible chat withdrawals to the source trigger and drains their remaining fingerprint", async () => {
  const f = await fixture();
  const chat = await chatCopies(f, null);
  await f.db.insert(chatSequences).values({ villageId: f.village.id, seq: 2 });
  await f.db.insert(chatNushiSources).values({ requestId: chat.request.id, entryId: f.source.id, authorId: "orchard", revision: 0, sourceHash: "fixture" });
  await f.db.insert(chatMessageTranslations).values({ messageId: chat.answer.id, lang: "ja", sourceHash: chatSourceHash(chat.answer.body), text: TRANSLATED, state: "ready" });
  await softDeleteEntry(f.db, f.source.id, { now: DELETED });
  const chatAnswer = () => f.db.select().from(chatMessages).where(eq(chatMessages.id, chat.answer.id));
  expect(await chatAnswer()).toMatchObject([{ body: "", hiddenAt: expect.any(Date), changedSeq: 3 }]);
  expect(await f.db.select().from(chatMessageTranslations)).toEqual([]);
  await pruneDeletedEntries(f.db, NOW);
  expect(await chatAnswer()).toMatchObject([{ body: "", changedSeq: 3 }]);
  expect(await f.db.select().from(chatSequences)).toMatchObject([{ seq: 3 }]);
});

it("drains a chat source fingerprint while leaving visible chat rows to withdrawal", async () => {
  const f = await fixture({ sourcePurged: true });
  await pruneDeletedEntries(f.db, NOW);
  const chat = await chatCopies(f, null);
  await f.db.insert(chatSequences).values({ villageId: f.village.id, seq: 2 });
  await f.db.insert(chatNushiSources).values({ requestId: chat.request.id, entryId: f.source.id, revision: 0, sourceHash: "fixture" });
  const results: RetentionResults = {};
  expect((await pruneDeletedEntries(f.db, NOW, results)).entries).toBe(0);
  expect(results.entry_content).toMatchObject({ removed: 1, remaining: 0, stop: "complete" });
  expect(await f.db.select().from(chatNushiSources)).toMatchObject([{ entryId: f.source.id, sourceHash: "" }]);
  expect(await f.db.select().from(chatMessages).where(eq(chatMessages.id, chat.answer.id))).toMatchObject([{ body: chat.answer.body, hiddenAt: null, changedSeq: 2 }]);
  expect(await f.db.select().from(chatSequences)).toMatchObject([{ seq: 2 }]);
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
  await f.db.insert(chatNushiSources).values({ requestId: chat.request.id, entryId: f.source.id, authorId: "orchard", revision: 0, sourceHash: "fixture" });
  await f.db.insert(chatMessageTranslations).values({ messageId: chat.answer.id, lang: "ja", sourceHash: chatSourceHash(chat.answer.body), text: TRANSLATED, state: "ready" });
  const materials = f.saved.answer.citations.map(citation => ({ id: citation.sourceId, original: citation.original.quote, author: citation.author }));
  await f.db.insert(nushiReports).values({ answerId: f.saved.id, kind: "error", reason: "wrong_post", reporterId: "river",
    evidence: { question: f.topic.body, materials, answer: f.saved.answer },
  });
  for (const [table, requestId] of [[nushiReservations, f.request.id], [chatNushiReservations, chat.request.id]] as const) {
    await f.db.insert(table).values(["member:orchard", "author:orchard", "member:river"].map(key => ({ requestId, key, day: "2030-03-01" })));
  }
  await deleteAccount(f.db, "orchard", { confirmation: "orchard_writer", posts }, { now: DELETED });
  const [after] = await f.db.select().from(nushiAnswers);
  expect(after.answer.citations).toEqual([{ ...f.orchardQuote, author: DELETED_MEMBER_HANDLE }, f.riverQuote]);
  expect(after.answer.readings[0].text).toBe(`${DELETED_MEMBER_HANDLE} suggests a tentative schedule.`);
  expect(after.answer.readings[1]).toEqual(f.saved.answer.readings[1]);
  expect((await f.db.select().from(nushiReports))[0].evidence).toEqual({ question: f.topic.body, answer: after.answer,
    materials: [{ ...materials[0], author: DELETED_MEMBER_HANDLE }, materials[1]],
  });
  expect(await f.db.select().from(chatMessages).where(eq(chatMessages.id, chat.answer.id))).toMatchObject([{ body: "", hiddenAt: DELETED, changedSeq: 2 }]);
  expect(await f.db.select().from(chatMessageTranslations)).toEqual([]);
  expect((await f.db.select().from(nushiSources).where(eq(nushiSources.entryId, f.source.id)))[0].author).toBe(DELETED_MEMBER_HANDLE);
  for (const table of [nushiReservations, chatNushiReservations]) expect(await f.db.select({ key: table.key }).from(table)).toEqual([{ key: "member:river" }]);
  await pruneDeletedEntries(f.db, NOW);
  expect((await f.db.select().from(nushiAnswers))[0].answer.citations).toEqual(posts === "keep" ? after.answer.citations : [f.riverQuote]);
});

it("retains the current and preceding UTC days in both quota tables", async () => {
  const f = await fixture();
  const chat = await chatCopies(f);
  for (const [table, requestId] of [[nushiReservations, f.request.id], [chatNushiReservations, chat.request.id]] as const) {
    await f.db.insert(table).values([{ requestId, key: "member:expired", day: "2030-03-29" }, { requestId, key: "member:orchard", day: "2030-03-30" }, { requestId, key: "member:river", day: "2030-03-31" }]);
  }
  const result = await runRetentionCleanup(f.db, NOW);
  for (const category of ["nushi_reservations", "chat_nushi_reservations"]) expect(result[category]).toMatchObject({ removed: 1, remaining: 0 });
  for (const table of [nushiReservations, chatNushiReservations]) expect(await f.db.select({ day: table.day }).from(table).orderBy(table.day)).toEqual([{ day: "2030-03-30" }, { day: "2030-03-31" }]);
  expect(await f.db.select().from(nushiRequests)).toHaveLength(1);
  expect(await f.db.select().from(chatNushiRequests)).toHaveLength(1);
});
