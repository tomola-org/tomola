export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
export const MAX_VIDEO_CARDS = 10;

const youtubeHosts = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

export const youtubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export function parseYoutubeUrl(value: string): { id: string; href: string } | null {
  const written = /^https?:\/\/[a-z.-]+(\/[^?#]*)/i.exec(value);
  if (!written || /[\s\\<>"\p{Cc}]/u.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.port) return null;
  const youtube = youtubeHosts.has(url.hostname);
  const noCookie = url.hostname === "www.youtube-nocookie.com";
  const shortHost = url.hostname === "youtu.be";
  if (!youtube && !noCookie && !shortHost) return null;

  const [mode, pathId, extra] = written[1].slice(1).split("/");
  if (extra !== undefined) return null;
  const embed = mode === "embed" && !shortHost;
  const id = shortHost ? (pathId === undefined ? mode : "")
    : embed || (youtube && (mode === "shorts" || mode === "live")) ? pathId
      : youtube && mode === "watch" && pathId === undefined ? url.searchParams.get("v") : null;
  if (!id || !YOUTUBE_ID.test(id)) return null;
  if (!embed) return { id, href: value.replace(/^http:/i, "https:") };

  const watch = new URL(youtubeWatchUrl(id));
  const hasTime = url.searchParams.has("t");
  for (const [key, param] of url.searchParams) {
    if (key === "t" || key === "list") watch.searchParams.append(key, param);
    if (key === "start" && !hasTime && !watch.searchParams.has("t")) watch.searchParams.set("t", param);
  }
  return { id, href: watch.href };
}
