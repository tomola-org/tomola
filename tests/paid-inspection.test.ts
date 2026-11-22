import { enqueueFixture } from "./helpers/enqueue-fixture";
import { afterEach, expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { chatMessages, chatMessageTranslations, entries, jobs, llmUsage, translations, villages } from "~/lib/db/schema";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { hasSavedTranslation, translate, type TranslationOutcome, type TranslationEngine } from "~/lib/llm/index.server";
import * as markdown from "~/lib/markdown-budget.server";
import { translationCallKey, withPaidTranslationCalls } from "~/lib/jobs/paid-translation.server";
import { getBudgetState } from "~/lib/llm/usage.server";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each([
  ["primary", "stopped", 1_000_000],
  ["secondary", "degraded", 900_000],
] as const)("replays a legacy paid %s translation while the budget is %s", async (role, state, costUsdMicro) => {
  const db = await createTestDb();
  const now = new Date("2026-10-17T00:00:00Z");
  const env = { LLM_MONTHLY_BUDGET_USD: "1" };
  await db.insert(llmUsage).values({ engine: "claude", model: "claude-haiku-4-5", purpose: "translate", costUsdMicro, createdAt: now });
  expect(await getBudgetState(db, now, env)).toBe(state);
  const call = vi.fn<TranslationEngine["translate"]>();
  const engine: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: call };
  const destination = "https://docs.example.test/paid";
  const req = { text: `A clear [original](${destination}).`, from: "en", to: "ja" } as const;
  const result = { text: `明快な[原文](${destination})です。`, model: engine.model, promptVersion: "translate-v14", inputTokens: 10, outputTokens: 2 };
  const saved = { paidTranslationCalls: { [translationCallKey(engine, req, "translate", role)]: { result, costUsdMicro: 20 } } };
  const save = vi.fn();
  const opts = { now, env, engines: { primary: engine, secondary: engine, judge: null } };
  const out = await withPaidTranslationCalls(saved, save, async () => {
    expect(await hasSavedTranslation(role, req, opts)).toBe(true);
    return translate(db, role, req, opts);
  });
  expect(out).toMatchObject({ text: result.text, promptVersion: "translate-v14", costUsdMicro: 20, inputTokens: 10, attempts: 1, flags: [] });
  expect(call).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(await db.select().from(llmUsage)).toHaveLength(1);
});
it.each([1, 2])("resumes inspection after paid call %i without repeating either provider call", async busyAt => {
  const db = await createTestDb();
  let calls = 0;
  const translateCall = vi.fn(async () => ({ text: busyAt === 2 && ++calls === 1 ? "bad" : "翻訳結果", model: "claude-haiku-4-5", promptVersion: "fixture", inputTokens: 10, outputTokens: 2 }));
  const engine: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: translateCall };
  let blocked = false;
  const task = markdown.markdownTask;
  vi.spyOn(markdown, "markdownTask").mockImplementation(async (...call) => {
    const [operation, args] = call;
    if (operation !== "inspectTranslation") return task(...call);
    if (args[1] === "bad") return { flags: ["structure_mismatch"], notes: ["Preserve the structure"] };
    if (!blocked) { blocked = true; throw new markdown.MarkdownBusyError(); }
    return { flags: [], notes: [] };
  });
  let result: TranslationOutcome | undefined;
  const now = new Date("2026-10-17T00:00:00Z");
  const handlers = { paid_fixture: async () => { result = await translate(db, "primary", { text: "A clear original.", from: "en", to: "ja" }, { engines: { primary: engine, secondary: null, judge: null }, now }); } };
  await enqueueFixture(db, "paid_fixture", { retained: "original payload" }, { runAt: now });
  expect(await runDueJobs(db, handlers, { now, limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ retried: 1 });
  expect(translateCall).toHaveBeenCalledTimes(busyAt);
  const [stored] = await db.select().from(jobs);
  expect(stored.payload).toMatchObject({ retained: "original payload", paidTranslationCalls: expect.any(Object) });
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 31_000), limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ done: 1 });
  expect(translateCall).toHaveBeenCalledTimes(busyAt);
  expect(await db.select().from(llmUsage)).toHaveLength(busyAt);
  expect(result).toMatchObject({ text: "翻訳結果", attempts: busyAt, inputTokens: busyAt * 10, costUsdMicro: expect.any(Number) });
  expect(result!.costUsdMicro).toBeGreaterThan(0);
  expect((await db.select().from(jobs))[0].payload).toEqual({ retained: "original payload" });
});

it("replays both legacy calls using the original title context and retry note", async () => {
  const db = await createTestDb();
  const translateCall = vi.fn<TranslationEngine["translate"]>();
  const engine: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: translateCall };
  const destination = "https://docs.example.test/paid";
  const req = { text: "A title", field: "title", from: "en", to: "ja", titleBodyContext: `[Guide](${destination})` } as const;
  const protectedContext = { titleBodyContext: "[Guide](TMLINK0X1Z)" };
  const retryNote = "Preserve the structure";
  const result = { text: "題名", model: engine.model, promptVersion: "translate-v14", inputTokens: 10, outputTokens: 2 };
  const saved = { paidTranslationCalls: {
    [translationCallKey(engine, req, "translate", "primary")]: { result: { ...result, text: "bad" }, costUsdMicro: 20 },
    [translationCallKey(engine, { ...req, retryNote }, "translate", "primary")]: { result, costUsdMicro: 25 },
  } };
  const task = markdown.markdownTask;
  vi.spyOn(markdown, "markdownTask").mockImplementation(async (...call) => {
    if (call[0] !== "inspectTranslation") return task(...call);
    return call[1][1] === "bad" ? { flags: ["structure_mismatch"], notes: [retryNote] } : { flags: [], notes: [] };
  });
  const save = vi.fn();
  const out = await withPaidTranslationCalls(saved, save, () => translate(db, "primary", { ...req, protectedContext }, { engines: { primary: engine, secondary: null, judge: null } }));
  expect(out).toMatchObject({ text: result.text, attempts: 2, inputTokens: 20, costUsdMicro: 45, flags: [] });
  expect(translateCall).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(await db.select().from(llmUsage)).toHaveLength(0);
});

it("resumes a paid fallback without calling the refused primary again", async () => {
  const { createTranslationHandlers } = await import("~/lib/jobs/translation-jobs.server");
  const { LlmError } = await import("~/lib/llm/errors.server");
  const db = await createTestDb();
  await addMember(db, "author", "author");
  const [entry] = await db.insert(entries).values({ authorId: "author", kind: "topic", body: "A clear original.", lang: "en", sourceHash: "h" }).returning();
  const primaryCall = vi.fn(async () => { throw new LlmError("refusal", "refused", { inputTokens: 10, outputTokens: 2 }); });
  const secondaryCall = vi.fn(async () => ({ text: "翻訳結果", model: "claude-haiku-4-5", promptVersion: "fixture", inputTokens: 10, outputTokens: 2 }));
  const primary: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: primaryCall };
  const secondary: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: secondaryCall };
  const task = markdown.markdownTask;
  let blocked = false;
  vi.spyOn(markdown, "markdownTask").mockImplementation(async (...call) => {
    if (call[0] !== "inspectTranslation") return task(...call);
    if (!blocked) { blocked = true; throw new markdown.MarkdownBusyError(); }
    return { flags: [], notes: [] };
  });
  const now = new Date("2026-10-17T00:00:00Z");
  const handlers = createTranslationHandlers({ llm: { engines: { primary, secondary, judge: null }, now } });
  await enqueue(db, "translate_entry", { entryId: entry.id, lang: "ja", sourceHash: "h" }, { runAt: now });
  expect(await runDueJobs(db, handlers, { now, limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ retried: 1 });
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 31_000), limit: 1, logger: { warn() {}, error() {} } })).toMatchObject({ done: 1 });
  expect(primaryCall).toHaveBeenCalledTimes(1);
  expect(secondaryCall).toHaveBeenCalledTimes(1);
  expect(await db.select().from(llmUsage)).toHaveLength(2);
  expect(await db.select().from(translations)).toMatchObject([{ text: "翻訳結果", fallback: true }]);
});

it("resumes actual chat inspection with its strict handler payload and clears the checkpoint", async () => {
  const { createChatTranslationHandlers } = await import("~/lib/jobs/chat-translation-jobs.server");
  const { chatSourceHash } = await import("~/lib/village-chat-translations.server");
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  await addMember(db, "author", "author");
  const [village] = await db.insert(villages).values({ kind: "open", slug: "paid-chat" }).returning();
  const [message] = await db.insert(chatMessages).values({ villageId: village.id, authorId: "author", lang: "ja", body: "こんにちは。", createdSeq: 1, changedSeq: 1 }).returning();
  const translateCall = vi.fn(async () => ({ text: "Hello there.", model: "claude-haiku-4-5", promptVersion: "fixture", inputTokens: 10, outputTokens: 2 }));
  const engine: TranslationEngine = { id: "claude", model: "claude-haiku-4-5", translate: translateCall };
  let blocked = false;
  vi.spyOn(markdown, "markdownTask").mockImplementation(async () => {
    if (!blocked) { blocked = true; throw new markdown.MarkdownBusyError(); }
    return { flags: [], notes: [] };
  });
  const now = new Date();
  const handlers = createChatTranslationHandlers({ engines: { primary: engine, secondary: null, judge: null, chat: engine }, now });
  await enqueue(db, "translate_chat", { messageId: message.id, lang: "en", sourceHash: chatSourceHash(message.body) }, { runAt: now });
  expect(await runDueJobs(db, handlers, { now, logger: { warn() {}, error() {} } })).toMatchObject({ retried: 1 });
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 31_000), logger: { warn() {}, error() {} } })).toMatchObject({ done: 1 });
  expect(await db.select().from(chatMessageTranslations)).toMatchObject([{ state: "ready", text: "Hello there." }]);
  expect(translateCall).toHaveBeenCalledTimes(1);
  expect(await db.select().from(llmUsage)).toHaveLength(1);
  expect((await db.select().from(jobs))[0].payload).not.toHaveProperty("paidTranslationCalls");
});
