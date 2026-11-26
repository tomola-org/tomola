import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client.server";
import { entries, youtubeVideos } from "../db/schema";
import { MarkdownBudgetError, markdownTask, withMarkdownPersistedRead } from "../markdown-budget.server";
import { rebuildVideoRenders } from "../render-cache.server";
import { entriesReferencingVideo, syncYoutubeReferences } from "../video-card-references.server";
import { videoCardSource, videoCardsEnabled } from "../video-cards-config.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "../visibility.server";
import { loadYoutubeArtwork } from "../youtube-fetch.server";
import { dateOf, ensureDailyJob } from "./daily.server";
import { DeferJob, defineJobHandlers, enqueue, type TypedJobHandler } from "./queue.server";

const DAY = 24 * 60 * 60 * 1000;
const SCAN_BATCH = 40;
const RENDER_BATCH = 20;
const REQUEST_INTERVAL_MS = 1000;
const schedule = { kind: "scan_youtube_videos", keyPrefix: "youtube:scan", hourUtc: 4 } as const;

async function queueScan(db: Db, date: string, after?: number) {
  return enqueue(db, schedule.kind, { date, after }, { dedupeKey: `${schedule.keyPrefix}:${date}${after === undefined ? "" : `:${after}`}` });
}

export async function scheduleYoutubeScan(db: Db, now = new Date()) {
  if (!videoCardsEnabled()) return;
  // The startup scan must leave the upcoming daily slot free, even when it
  // runs earlier on the same date.
  const date = dateOf(now);
  await enqueue(db, schedule.kind, { date }, { runAt: now, dedupeKey: `youtube:scan-startup:${date}` });
  await ensureDailyJob(db, schedule, now);
}

export async function scanYoutubeEntries(db: Db, after: number, now: Date): Promise<number | null> {
  if (!videoCardsEnabled()) return null;
  const candidates = await db.select({ id: entries.id, body: entries.body })
    .from(entries).innerJoin(rootTopic, rootTopicOn()).where(and(
      gt(entries.id, after), visibleWithTopic(), sql`${entries.body} ~* '(youtube(-nocookie)?[.]com|youtu[.]be)'`,
    )).orderBy(entries.id).limit(SCAN_BATCH);
  await withMarkdownPersistedRead(async () => {
    for (const row of candidates) {
      let ids: string[];
      try {
        ids = await markdownTask("youtubeIdsInMarkdown", [row.body]);
      } catch (error) {
        if (error instanceof MarkdownBudgetError) continue;
        throw error;
      }
      if (!ids.length) continue;
      await db.transaction(async tx => {
        const [current] = await tx.select({ id: entries.id }).from(entries)
          .where(and(eq(entries.id, row.id), eq(entries.body, row.body))).for("no key update");
        if (current) await syncYoutubeReferences(tx, row.id, ids, now);
      });
    }
  });
  return candidates.length === SCAN_BATCH ? candidates.at(-1)!.id : null;
}

async function queueRenders(db: Db, id: string, after?: number) {
  return enqueue(db, "render_youtube_video", { id, after }, { dedupeKey: `youtube:render:${id}:${after ?? 0}` });
}

export function createVideoCardHandlers(options: { load?: typeof loadYoutubeArtwork; intervalMs?: number } = {}) {
  const fetchVideo: TypedJobHandler<"fetch_youtube_video"> = async ({ payload: { id } }, ctx) => {
    if (!videoCardsEnabled()) return;
    const clock = ctx.clock ?? (() => ctx.now);
    await ctx.db.transaction(async tx => {
      // Across workers and processes, leave a gap even when the previous
      // request failed. Hold no entry row locks while contacting YouTube.
      const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(732108, 2) as locked`) as { rows: { locked: boolean }[] };
      if (!lock.rows[0]?.locked) throw new DeferJob(new Date(+clock() + REQUEST_INTERVAL_MS), "video fetch slot busy");
      const [cached] = await tx.select({ refreshAfter: youtubeVideos.refreshAfter }).from(youtubeVideos).where(eq(youtubeVideos.id, id));
      if (cached && cached.refreshAfter > clock()) return;
      await delay(options.intervalMs ?? REQUEST_INTERVAL_MS, undefined, { signal: ctx.signal });
      if (!(await entriesReferencingVideo(tx, id, 0, 1)).length) return;
      const image = await (options.load ?? loadYoutubeArtwork)(id, videoCardSource(), ctx.signal);
      ctx.signal?.throwIfAborted();
      const refreshAfter = new Date(+clock() + (image ? 30 : 7) * DAY);
      const values = { title: null, channel: null, width: null, height: null, bytes: null, ...image, refreshAfter };
      await tx.insert(youtubeVideos).values({ id, ...values }).onConflictDoUpdate({ target: youtubeVideos.id, set: values });
      await queueRenders(tx, id);
    });
  };

  const scan: TypedJobHandler<"scan_youtube_videos"> = async ({ payload }, ctx) => {
    if (!videoCardsEnabled()) return;
    await ensureDailyJob(ctx.db, schedule, ctx.now);
    const next = await scanYoutubeEntries(ctx.db, payload.after ?? 0, ctx.now);
    if (next !== null) await queueScan(ctx.db, payload.date, next);
  };

  const render: TypedJobHandler<"render_youtube_video"> = async ({ payload: { id, after } }, ctx) => {
    if (!videoCardsEnabled()) return;
    const refs = await entriesReferencingVideo(ctx.db, id, after, RENDER_BATCH);
    await rebuildVideoRenders(ctx.db, refs.map(row => row.id));
    if (refs.length === RENDER_BATCH) await queueRenders(ctx.db, id, refs.at(-1)!.id);
  };
  return defineJobHandlers({ fetch_youtube_video: fetchVideo, scan_youtube_videos: scan, render_youtube_video: render });
}
