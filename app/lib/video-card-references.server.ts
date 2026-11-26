import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db, Tx } from "./db/client.server";
import { entries, entryYoutubeVideos, youtubeVideos } from "./db/schema";
import { enqueue } from "./jobs/queue.server";
import { videoCardsEnabled } from "./video-cards-config.server";
import { videoReferenceBodyHash, visibleVideoReferences } from "./video-cards.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "./visibility.server";

async function queueDueVideos(db: Db, ids: readonly string[], now: Date): Promise<void> {
  if (!ids.length) return;
  const cached = await db.select({ id: youtubeVideos.id, refreshAfter: youtubeVideos.refreshAfter })
    .from(youtubeVideos).where(inArray(youtubeVideos.id, [...ids]));
  const fresh = new Set(cached.filter(row => row.refreshAfter > now).map(row => row.id));
  for (const id of ids) {
    if (!fresh.has(id)) await enqueue(db, "fetch_youtube_video", { id }, { dedupeKey: `youtube:fetch:${id}` });
  }
}

// The caller's source row lock serializes reference changes with edits. The
// body hash also fences edits made with the feature off or older code.
export async function syncYoutubeReferences(db: Tx, entryId: number, ids: readonly string[], now: Date) {
  if (!videoCardsEnabled()) return;
  const [source] = await db.select({ bodyHash: videoReferenceBodyHash }).from(entries).innerJoin(rootTopic, rootTopicOn())
    .where(and(eq(entries.id, entryId), visibleWithTopic()));
  const found = source ? [...new Set(ids)].sort() : [];
  if (!source || !found.length) {
    await db.delete(entryYoutubeVideos).where(eq(entryYoutubeVideos.entryId, entryId));
    return;
  }
  await db.delete(entryYoutubeVideos).where(and(eq(entryYoutubeVideos.entryId, entryId), notInArray(entryYoutubeVideos.videoId, found)));
  await db.insert(entryYoutubeVideos).values(found.map(videoId => ({ entryId, videoId, bodyHash: source.bodyHash })))
    .onConflictDoUpdate({
      target: [entryYoutubeVideos.entryId, entryYoutubeVideos.videoId],
      set: { bodyHash: source.bodyHash },
      setWhere: sql`${entryYoutubeVideos.bodyHash} <> ${source.bodyHash}`,
    });
  await queueDueVideos(db, found, now);
}

export async function hasYoutubeReference(db: Db, id: string): Promise<boolean> {
  const refs = visibleVideoReferences(db).as("youtube_source_refs");
  const [ref] = await db.select({ id: refs.entryId }).from(refs).where(eq(refs.videoId, id)).limit(1);
  return ref !== undefined;
}
