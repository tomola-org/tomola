import { m } from "~/paraglide/messages.js";
import { baseLocale, isLocale } from "~/paraglide/runtime.js";
import { escapeHtml } from "./site-export-format.core.server";

export type VideoCard = { title: string; channel: string; width: number; height: number };

// Only the Markdown renderer can add these attributes. Save the original
// link with a cached card so exports and flag-off reads can restore it exactly.
const paragraphs = /<p data-youtube-id="([A-Za-z0-9_-]{11})" data-youtube-href="([^"]+)"(?: data-youtube-fallback="([A-Za-z0-9_-]+)")?>(.*?)<\/p>/gs;

export function videoIdsInHtml(html: string): string[] {
  return [...html.matchAll(paragraphs)].map(match => match[1]);
}

const youtubeThumbnailPath = (id: string) => `/media/youtube-${id}.webp`;

export function videoCardHtml(html: string, cards?: ReadonlyMap<string, VideoCard>, lang?: string, translated = false, persist = false): string {
  const locale = lang && isLocale(lang) ? lang : baseLocale;
  return html.replace(paragraphs, (_paragraph, id: string, href: string, saved: string | undefined, content: string) => {
    const link = saved ? Buffer.from(saved, "base64url").toString("utf8") : content;
    const video = cards?.get(id);
    const marker = persist ? ` data-youtube-id="${id}" data-youtube-href="${href}"` : "";
    if (!video) return `<p${marker}>${link}</p>`;
    const fallback = persist ? ` data-youtube-fallback="${Buffer.from(link).toString("base64url")}"` : "";
    const note = translated ? `<span class="video-card-note">${escapeHtml(m.md_video_original({}, { locale }))}</span>` : "";
    return `<p${marker}${fallback}><a class="video-card" href="${href}" rel="nofollow noopener noreferrer">`
      + `<span class="video-card-picture"><img src="${youtubeThumbnailPath(id)}" alt="" width="${video.width}" height="${video.height}" loading="lazy" decoding="async"><span class="video-card-play" aria-hidden="true">▶</span></span>`
      + `<span class="video-card-labels"><bdi class="video-card-title">${escapeHtml(video.title)}</bdi><bdi>${escapeHtml(video.channel)}</bdi>`
      + `<span>${escapeHtml(m.md_video_youtube({}, { locale }))}</span>${note}</span></a></p>`;
  });
}
