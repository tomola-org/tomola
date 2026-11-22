import type { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { createMarkdownProcessor } from "../markdown-rules";
import { titleBodyContext } from "../translation-terms";

const markerPattern = /TMLINK\d+X\d+Z/gi;
type Span = { start: number; end: number };
type Node = { type: string; data?: { destination?: Span }; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] };

// These outer tokens delimit the raw destination without the optional title.
const saveDestination: NonNullable<ReturnType<typeof gfmAutolinkLiteralFromMarkdown>["exit"]>[string] = function (token) {
  const node = this.stack[this.stack.length - 1] as Node;
  (node.data ??= {}).destination = { start: token.start.offset, end: token.end.offset };
};

const markdown = createMarkdownProcessor().use(function linkDestinationPositions() {
  (this.data().fromMarkdownExtensions ??= []).push({ exit: {
    resourceDestination: saveDestination,
    definitionDestination: saveDestination,
  } });
});

const htmlTag = /^<(\/?)([a-z][\da-z-]*)(?=[\s/>])/i;
const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

function linkSpans(source: string): Span[] {
  // Micromark discards a leading BOM before counting token and node offsets.
  const offset = source.startsWith("\uFEFF") ? 1 : 0;
  const spans: Span[] = [], html: Span[] = [];
  const openTags: Array<{ name: string; end: number }> = [];
  function walk(node: Node) {
    node.children?.forEach(walk);
    const position = node.position;
    if (position?.start.offset === undefined || position.end.offset === undefined) return;
    const start = position.start.offset + offset, end = position.end.offset + offset;
    const destination = node.data?.destination;
    if (destination) {
      const start = destination.start + offset, end = destination.end + offset;
      const angle = source[start] === "<";
      const span = angle ? { start: start + 1, end: end - 1 } : { start, end };
      if (span.start < span.end) spans.push(span);
    } else if (node.type === "link" && source[start] !== "[") {
      // CommonMark autolinks are enclosed in angles. GFM literals use the node's whole span.
      spans.push(source[start] === "<" ? { start: start + 1, end: end - 1 } : { start, end });
    } else if (node.type === "html") {
      // Markdown may parse the contents of paired inline HTML tags as siblings.
      const raw = source.slice(start, end);
      const tag = htmlTag.exec(raw);
      if (!tag) return;
      const name = tag[2].toLowerCase();
      if (tag[1]) {
        if (openTags.at(-1)?.name === name) html.push({ start: openTags.pop()!.end, end: start });
      } else if (!voidTags.has(name) && !raw.endsWith("/>")) openTags.push({ name, end });
    }
  }
  walk(markdown.parse(source) as Node);
  html.sort((a, b) => a.start - b.start);
  let htmlIndex = 0, htmlEnd = 0;
  return spans.sort((a, b) => a.start - b.start).filter(span => {
    while (htmlIndex < html.length && html[htmlIndex].start <= span.start) {
      htmlEnd = Math.max(htmlEnd, html[htmlIndex++].end);
    }
    return span.start >= htmlEnd;
  });
}

export function maskLinkTargets(source: string, namespace = 1) {
  const spans = linkSpans(source);
  const literals = [...source.matchAll(markerPattern)].map(([marker]) => marker);
  while (literals.some(marker => marker.toUpperCase().startsWith(`TMLINK${namespace}X`))) namespace += 2;
  const targets: Record<string, string> = {};
  const parts: string[] = [];
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    const marker = `TMLINK${namespace}X${index + 1}Z`;
    targets[marker] = source.slice(span.start, span.end);
    parts.push(source.slice(cursor, span.start), marker);
    cursor = span.end;
  }
  parts.push(source.slice(cursor));
  return { text: parts.join(""), targets, literals };
}

export function maskLinkContext(...texts: string[]) {
  return texts.map(text => maskLinkTargets(text, 0).text);
}

export function protectedTitleBodyContext(source: string, translated: string | undefined, title: string) {
  const [masked, translatedMasked] = maskLinkContext(source, ...(translated === undefined ? [] : [translated]));
  return titleBodyContext(masked, translatedMasked, title);
}

export function restoreLinkTargets(output: string, targets: Record<string, string>, literals: string[]) {
  const remaining = new Set(Object.keys(targets));
  const originalLiterals = new Map<string, number>();
  for (const literal of literals) originalLiterals.set(literal, (originalLiterals.get(literal) ?? 0) + 1);
  const restored: Span[] = [];
  let valid = true, shift = 0;
  const text = output.replace(markerPattern, (marker: string, offset: number) => {
    const count = originalLiterals.get(marker) ?? 0;
    if (count) {
      originalLiterals.set(marker, count - 1);
      return marker;
    }
    const target = targets[marker] ?? "";
    if (!remaining.delete(marker)) valid = false;
    if (target) restored.push({ start: offset + shift, end: offset + shift + target.length });
    shift += target.length - marker.length;
    return target;
  });
  if (valid && restored.length) {
    const destinations = new Set(linkSpans(text).map(({ start, end }) => `${start}:${end}`));
    valid = restored.every(({ start, end }) => destinations.has(`${start}:${end}`));
  }
  return { text, valid: valid && remaining.size === 0 };
}
