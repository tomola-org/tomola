import { and, eq, exists, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, entryYoutubeVideos, youtubeVideos } from "./db/schema";
import { rootTopic, rootTopicOn, visibleWithTopic } from "./visibility.server";
import { videoCardsEnabled } from "./video-cards-config.server";
import { videoCardHtml, videoIdsInHtml, type VideoCard } from "./video-card-html.server";

// A language correction can change the entry revision without changing its URLs.
export const videoReferenceBodyHash = sql<string>`encode(sha256(convert_to(${entries.body}, 'UTF8')), 'hex')`;

export function visibleVideoReferences(db: Db) {
  return db.select({ entryId: entries.id, videoId: entryYoutubeVideos.videoId }).from(entryYoutubeVideos)
    .innerJoin(entries, and(eq(entries.id, entryYoutubeVideos.entryId), eq(videoReferenceBodyHash, entryYoutubeVideos.bodyHash)))
    .innerJoin(rootTopic, rootTopicOn()).where(visibleWithTopic());
}

function hasVisibleVideoReference(db: Db) {
  const refs = visibleVideoReferences(db).as("visible_video_refs");
  return exists(db.select({ entryId: refs.entryId }).from(refs).where(eq(refs.videoId, youtubeVideos.id)));
}

export async function readVideoCards(db: Db, ids: readonly string[]): Promise<ReadonlyMap<string, VideoCard>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: youtubeVideos.id, title: youtubeVideos.title, channel: youtubeVideos.channel, width: youtubeVideos.width, height: youtubeVideos.height })
    .from(youtubeVideos).where(and(inArray(youtubeVideos.id, [...ids]), isNotNull(youtubeVideos.title), hasVisibleVideoReference(db)));
  return new Map(rows.map(({ id, title, channel, width, height }) => [id, { title: title!, channel: channel!, width: width!, height: height! }]));
}

export async function readVideoThumbnail(db: Db, id: string) {
  const [row] = await db.select({ bytes: youtubeVideos.bytes }).from(youtubeVideos)
    .where(and(eq(youtubeVideos.id, id), isNotNull(youtubeVideos.bytes), hasVisibleVideoReference(db)));
  return row?.bytes ?? null;
}

export async function prepareVideoCardDisplay(db: Db, html: readonly string[]) {
  const cards = videoCardsEnabled() ? await readVideoCards(db, [...new Set(html.flatMap(videoIdsInHtml))]) : undefined;
  return (body: string, lang?: string, translated = false) => videoCardHtml(body, cards, lang, translated);
}
