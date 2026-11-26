import { createMarkdownProcessor } from "./markdown-parser.core.server";
import type { MarkdownNode } from "./markdown-details";
import { MAX_VIDEO_CARDS, parseYoutubeUrl } from "./youtube-url";

function youtubeParagraphs(tree: MarkdownNode) {
  const found: { paragraph: MarkdownNode; id: string; href: string }[] = [];
  for (const paragraph of tree.children ?? []) {
    if (paragraph.type !== "paragraph" || paragraph.children?.length !== 1) continue;
    const [link] = paragraph.children;
    if (link.type !== "link" || !link.url || link.title != null || link.children?.length !== 1) continue;
    const [text] = link.children;
    if (text.type !== "text" || text.value !== link.url) continue;
    const video = parseYoutubeUrl(link.url);
    if (!video) continue;
    found.push({ paragraph, ...video });
    if (found.length === MAX_VIDEO_CARDS) break;
  }
  return found;
}

export function tagYoutubeParagraphs(tree: MarkdownNode) {
  for (const { paragraph, id, href } of youtubeParagraphs(tree)) {
    paragraph.data = { ...paragraph.data, hProperties: { dataYoutubeId: id, dataYoutubeHref: href } };
  }
}

export function youtubeIdsInMarkdown(body: string): string[] {
  const tree = createMarkdownProcessor().parse(body) as MarkdownNode;
  return [...new Set(youtubeParagraphs(tree).map(video => video.id))].sort();
}
