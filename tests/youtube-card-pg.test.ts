import fs from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrationsFolder } from "~/lib/db/client.server";
import { entries, entryRevisions, entryYoutubeVideos, jobs, translations, youtubeVideos } from "~/lib/db/schema";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { createReply, createTopic, editEntry, getThread } from "~/lib/entries.server";
import { createVideoCardHandlers, scanYoutubeEntries, scheduleYoutubeScan } from "~/lib/jobs/video-card-jobs.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { readVideoThumbnail } from "~/lib/video-cards.server";
import { loadYoutubeArtwork } from "~/lib/youtube-fetch.server";
import { addMember, createTestDb } from "./helpers/db";
import { quietLogger as logger } from "./helpers/logger";
import { migrationsBefore } from "./helpers/migrations";
import { createScratchDb, REAL_PG_URL } from "./helpers/pg-real";
import { PG_MODE } from "./helpers/pg-test";

const id = "A1b2C3d4_-E";
const missingId = "Unavailable";
const body = `録画です。\n\nhttps://youtu.be/${id}?t=24`;
const fetchJobs = eq(jobs.kind, "fetch_youtube_video");

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!REAL_PG_URL)("additive YouTube video migration", { tags: ["postgres"] }, () => {
  it("preserves existing rows and accepts the same post writes on both schemas", { timeout: 60_000 }, async () => {
    const before = migrationsBefore("youtube_cards");
    const scratch = await createScratchDb({ migrate: false });
    try {
      const admin = await scratch.admin();
      const database = drizzle(admin);
      await migrate(database, { migrationsFolder: before });
      const db = await scratch.open();
      await addMember(db, "migration_writer", "migration_writer");
      vi.stubEnv("VIDEO_CARDS", "");
      const input = { lang: "ja", title: "動画", body };
      const written = await createTopic(db, "migration_writer", input);
      expect(written.ok).toBe(true);
      const projected = () => db.select().from(entries).orderBy(entries.id);
      const legacy = await projected();
      const work = await db.select().from(jobs).orderBy(jobs.id);
      await migrate(database, { migrationsFolder: migrationsFolder() });
      expect(await projected()).toEqual(legacy);
      expect(await db.select().from(jobs).orderBy(jobs.id)).toEqual(work);
      expect(await createTopic(db, "migration_writer", { ...input, title: "別の動画" })).toMatchObject({ ok: true });
      expect(await db.select().from(entryYoutubeVideos)).toEqual([]);
      expect(await db.select().from(youtubeVideos)).toEqual([]);
    } finally {
      await scratch.drop();
      fs.rmSync(before, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!PG_MODE)("YouTube job lifecycle in PostgreSQL", { tags: ["postgres"] }, () => {
  it("keeps the daily scan scheduled after an early startup scan", async () => {
    const db = await createTestDb();
    vi.stubEnv("VIDEO_CARDS", "1");
    const now = new Date("2026-01-02T01:00:00Z");
    const today = new Date("2026-01-02T04:00:00Z");
    const tomorrow = new Date("2026-01-03T04:00:00Z");
    const { scan_youtube_videos } = createVideoCardHandlers();
    const scans = () => db.select({ status: jobs.status, runAt: jobs.runAt }).from(jobs)
      .where(eq(jobs.kind, "scan_youtube_videos")).orderBy(jobs.runAt);
    const run = (time: Date) => runDueJobs(db, { scan_youtube_videos }, { now: time, logger });

    await scheduleYoutubeScan(db, now);
    await scheduleYoutubeScan(db, now);
    await run(now);
    expect(await scans()).toEqual([{ status: "done", runAt: now }, { status: "queued", runAt: today }]);
    await run(today);
    expect((await scans()).at(-1)).toEqual({ status: "queued", runAt: tomorrow });
  });

  it("scans historical posts idempotently, retries transient failures, and refreshes saved HTML only", { timeout: 45_000 }, async () => {
    const db = await createTestDb();
    await addMember(db, "video_writer", "video_writer");
    vi.stubEnv("VIDEO_CARDS", "");
    vi.stubEnv("VIDEO_CARD_SOURCE", "fake");
    const topic = await createTopic(db, "video_writer", { lang: "ja", title: "動画", body });
    if (!topic.ok) throw new Error(topic.error);
    expect(await db.select().from(jobs).where(fetchJobs)).toEqual([]);
    const [source] = await db.select().from(entries).where(eq(entries.id, topic.id));
    await db.update(entries).set({ html: '<p>old HTML</p>', htmlVersion: 15 }).where(eq(entries.id, topic.id));
    await db.insert(translations).values(["primary", "human"].map(kind => ({
      entryId: topic.id, lang: "en", field: "body", kind, sourceHash: source.sourceHash, mentionRevision: source.mentionRevision,
      text: `The recording.\n\nhttps://youtu.be/${id}?t=24`, html: "<p>old translation HTML</p>", htmlVersion: 15,
    })));
    const snapshot = await db.select().from(translations).orderBy(translations.id);
    const translationJobs = () => db.select().from(jobs).where(inArray(jobs.kind, ["translate_entry", "translate_title"])).orderBy(jobs.id);
    const priorRevisions = await db.select().from(entryRevisions);
    const replyBody = `https://youtu.be/${id}\n\nhttps://youtu.be/${missingId}`;
    const hidden = await createReply(db, "video_writer", topic.id, { lang: "en", body: `https://youtu.be/HiddenPost1` });
    if (!hidden.ok) throw new Error(hidden.error);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden.id));
    const open = await createReply(db, "video_writer", topic.id, { lang: "en", body: replyBody });
    if (!open.ok) throw new Error(open.error);
    const beforeJobs = await translationJobs();

    vi.stubEnv("VIDEO_CARDS", "1");
    const now = new Date(Date.now() + 1000);
    expect(await scanYoutubeEntries(db, 0, now)).toBeNull();
    const refs = () => db.select().from(entryYoutubeVideos).orderBy(entryYoutubeVideos.entryId, entryYoutubeVideos.videoId);
    const initial = await refs();
    expect(initial).toHaveLength(3);
    expect(await scanYoutubeEntries(db, 0, now)).toBeNull();
    expect(await refs()).toEqual(initial);
    expect(await db.select().from(jobs).where(fetchJobs)).toHaveLength(2);
    const load = vi.fn<typeof loadYoutubeArtwork>()
      .mockRejectedValueOnce(new Error("temporary video failure"))
      .mockImplementation((video, kind, signal) => video === missingId ? Promise.resolve(null) : loadYoutubeArtwork(video, kind, signal));
    const handlers = createVideoCardHandlers({ load, intervalMs: 0 });
    const run = (time: Date) => runDueJobs(db, handlers, { now: time, logger });
    await run(now);
    const [retried] = await db.select().from(jobs).where(and(fetchJobs, sql`${jobs.payload}->>'id' = ${id}`));
    expect(retried).toMatchObject({ attempts: 1, status: "queued", lastError: expect.stringContaining("temporary video failure") });
    const retryTime = new Date(+now + 60_000);
    await run(retryTime);
    await run(retryTime);
    expect(load.mock.calls.map(([video]) => video)).toEqual([id, missingId, id]);
    expect(await db.select({ id: youtubeVideos.id, title: youtubeVideos.title }).from(youtubeVideos).orderBy(youtubeVideos.id))
      .toEqual([{ id, title: "Example video" }, { id: missingId, title: null }]);
    const [post] = await db.select().from(entries).where(eq(entries.id, topic.id));
    expect(post.html).toContain('class="video-card"');
    expect(post).toMatchObject({ body, sourceHash: source.sourceHash, updatedAt: source.updatedAt });
    const versions = await db.select().from(translations).orderBy(translations.id);
    for (const [index, row] of versions.entries()) {
      expect(row.html).toContain('class="video-card-note"');
      expect(row).toMatchObject({ text: snapshot[index].text, updatedAt: snapshot[index].updatedAt });
    }
    expect(await translationJobs()).toEqual(beforeJobs);
    expect(await db.select().from(entryRevisions)).toEqual(priorRevisions);
    const thread = await getThread(db, topic.id);
    expect(thread?.topic.html).toContain('class="video-card"');
    expect(thread?.replies.find(row => row.id === open.id)?.html).toContain(`href="https://youtu.be/${missingId}"`);
    const loadDisplay = async () => (await loadEntryDisplays(db, [{ id: topic.id, kind: "topic", lang: "ja", sourceHash: source.sourceHash }], {
      displayLang: "en", readLangs: ["en"],
    })).get(topic.id)?.translation?.html;
    expect(await loadDisplay()).toContain('class="video-card-note"');

    // The source-language worker can revise metadata without changing the body.
    await db.update(entries).set({ lang: "en", mentionRevision: source.mentionRevision + 1 }).where(eq(entries.id, topic.id));
    expect((await getThread(db, topic.id))?.topic.html).toContain('class="video-card"');

    expect(await editEntry(db, "video_writer", open.id, { body: `https://youtu.be/${id}?start=3` }, { kind: "reply" })).toMatchObject({ ok: true });
    await scanYoutubeEntries(db, 0, retryTime);
    await enqueue(db, "fetch_youtube_video", { id });
    await run(retryTime);
    expect(load).toHaveBeenCalledTimes(3);
    vi.stubEnv("VIDEO_CARDS", "");
    expect((await getThread(db, topic.id))?.topic.html).not.toContain("video-card");
    expect(await loadDisplay()).not.toContain("video-card");
    expect(await editEntry(db, "video_writer", open.id, { body: "The link was removed." }, { kind: "reply" })).toMatchObject({ ok: true });
    expect(await editEntry(db, "video_writer", topic.id, { body: "The link was removed." }, { kind: "topic" })).toMatchObject({ ok: true });
    vi.stubEnv("VIDEO_CARDS", "1");
    expect(await readVideoThumbnail(db, id)).toBeNull();
  });

  it("serializes different video IDs across concurrent queue runners", async () => {
    const db = await createTestDb();
    await addMember(db, "video_slots", "video_slots");
    vi.stubEnv("VIDEO_CARDS", "1");
    vi.stubEnv("VIDEO_CARD_SOURCE", "fake");
    const post = await createTopic(db, "video_slots", { lang: "en", body: `https://youtu.be/${id}\n\nhttps://youtu.be/${missingId}` });
    expect(post.ok).toBe(true);
    expect(await db.select().from(jobs).where(fetchJobs)).toHaveLength(2);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const load = vi.fn<typeof loadYoutubeArtwork>().mockImplementationOnce(async () => {
      entered();
      await blocked;
      return null;
    }).mockResolvedValue(null);
    const { fetch_youtube_video } = createVideoCardHandlers({ load, intervalMs: 0 });
    const now = new Date(Date.now() + 1000);
    const run = (time: Date) => runDueJobs(db, { fetch_youtube_video }, { now: time, limit: 1, logger });
    const first = run(now);
    try {
      await Promise.race([inFlight, first]);
      expect(load).toHaveBeenCalledTimes(1);
      await run(now);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
    await run(new Date(+now + 2000));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
