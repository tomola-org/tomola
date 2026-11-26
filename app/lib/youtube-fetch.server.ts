import { processUploadedMedia } from "./media-processing.server";
import { YOUTUBE_ID, youtubeWatchUrl } from "./youtube-url";

export const VIDEO_FETCH_LIMITS = { ms: 5_000, oembed: 64 * 1024, image: 2 * 1024 * 1024 } as const;
const unavailable = new Set([401, 403, 404]);
const thumbnailHost = "i.ytimg.com";
const thumbnail = (id: string) => `https://${thumbnailHost}/vi/${id}/hqdefault.jpg`;

async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("YouTube returned an empty response");
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("YouTube response exceeds its size limit");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) throw new Error("YouTube response exceeds its size limit");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
  }
}

function cardText(value: unknown, limit: number): string {
  return typeof value === "string" ? Array.from(value.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "").trim()).slice(0, limit).join("") : "";
}

function checkThumbnail(value: unknown, id: string): void {
  if (value === undefined) return;
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (!url || url.origin !== `https://${thumbnailHost}` || url.username || url.password || !url.pathname.startsWith(`/vi/${id}/`)) {
    throw new Error("YouTube returned an unexpected thumbnail URL");
  }
}

type FetchOptions = { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number };
export async function fetchYoutubeCard(id: string, opts: FetchOptions = {}) {
  if (!YOUTUBE_ID.test(id)) throw new Error("Invalid YouTube video ID");
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? VIDEO_FETCH_LIMITS.ms);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const get = async (url: string, limit: number) => {
    signal.throwIfAborted();
    const response = await (opts.fetch ?? fetch)(url, { redirect: "error", signal, credentials: "omit" });
    if (response.status !== 200 || response.redirected) {
      void response.body?.cancel().catch(() => {});
      if (unavailable.has(response.status) && !response.redirected) return null;
      throw new Error(`YouTube returned HTTP ${response.status}`);
    }
    return boundedBody(response, limit, signal);
  };
  const oembed = new URL("https://www.youtube.com/oembed");
  oembed.search = new URLSearchParams({ format: "json", url: youtubeWatchUrl(id) }).toString();
  const json = await get(oembed.href, VIDEO_FETCH_LIMITS.oembed);
  if (!json) return null;
  const data = JSON.parse(json.toString("utf8")) as Record<string, unknown> | null;
  const title = cardText(data?.title, 300);
  const channel = cardText(data?.author_name, 100);
  if (!title || !channel) throw new Error("YouTube did not return a title and channel");
  checkThumbnail(data?.thumbnail_url, id);
  const bytes = await get(thumbnail(id), VIDEO_FETCH_LIMITS.image);
  return bytes ? { title, channel, bytes } : null;
}

export type YoutubeArtwork = { title: string; channel: string; bytes: Buffer; width: number; height: number };

export async function loadYoutubeArtwork(id: string, source: "fake" | "youtube", signal?: AbortSignal): Promise<YoutubeArtwork | null> {
  const data = source === "fake" ? {
    title: "Example video",
    channel: "Example channel",
    bytes: Buffer.from("UklGRiQAAABXRUJQVlA4TBcAAAAvn0AWAAdQqrZ0r/9hABLC//9KRP9TgwA=", "base64"),
  } : await fetchYoutubeCard(id, { signal });
  if (!data) return null;
  const image = await processUploadedMedia(data.bytes);
  if (image.frames !== undefined) throw new Error("Expected a still YouTube thumbnail");
  return { title: data.title, channel: data.channel, bytes: image.bytes, width: image.width, height: image.height };
}
