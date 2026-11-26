import { m } from "~/paraglide/messages.js";
import { baseLocale, isLocale } from "~/paraglide/runtime.js";
import { escapeHtml } from "./html-attribute";

export type VideoCard = { title: string; channel: string; width: number; height: number };

// Only the Markdown renderer can add these attributes to an ordinary link paragraph.
const paragraphs = /<p data-youtube-id="([A-Za-z0-9_-]{11})" data-youtube-href="([^"]+)">(.*?)<\/p>/gs;

export function videoIdsInHtml(html: string): string[] {
  return [...html.matchAll(paragraphs)].map(match => match[1]);
}

const youtubeThumbnailPath = (id: string) => `/media/youtube-${id}.webp`;

export function videoCardHtml(html: string, cards?: ReadonlyMap<string, VideoCard>, lang?: string, translated = false): string {
  const locale = lang && isLocale(lang) ? lang : baseLocale;
  return html.replace(paragraphs, (_paragraph, id: string, href: string, link: string) => {
    const video = cards?.get(id);
    if (!video) return `<p>${link}</p>`;
    const note = translated ? `<span class="video-card-note">${escapeHtml(m.md_video_original({}, { locale }))}</span>` : "";
    return `<p><a class="video-card" href="${href}" rel="nofollow noopener noreferrer">`
      + `<span class="video-card-picture"><img src="${youtubeThumbnailPath(id)}" alt="" width="${video.width}" height="${video.height}" loading="lazy" decoding="async"><span class="video-card-play" aria-hidden="true">▶</span></span>`
      + `<span class="video-card-labels"><bdi class="video-card-title" translate="no">${escapeHtml(video.title)}</bdi><bdi translate="no">${escapeHtml(video.channel)}</bdi>`
      + `<span>${escapeHtml(m.md_video_youtube({}, { locale }))}</span>${note}</span></a></p>`;
  });
}
