import type { FigureReading, FigureRegion } from "./figure";
import { FIGURE_GRAPHICS, figurePixelDelta, findFigureGraphics } from "./figure-graphics.server";

export type FigureBox = { left: number; top: number; width: number; height: number };
export const FIGURE_SPACE = { adjacentDelta: 6, backgroundNoise: 16, faintLineContrast: 32, faintLineWidth: 3, faintLineLength: 24, contrast: 40, glyphFringe: 4, guard: 2, maxSpeckPixels: 9, maxSpeckDiameter: 3, maxWindowWidth: 2048, maxWindowHeight: 512, maxWindowPixels: 1048576, horizontalMargin: 192, verticalMargin: 96 } as const;
export const inside = (b: FigureBox, x: number, y: number) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
export const boxArea = (b: FigureBox) => b.width * b.height;
export function figureBox(region: Pick<FigureRegion, "x" | "y" | "width" | "height">, width: number, height: number): FigureBox {
  const left = Math.floor(region.x * width), top = Math.floor(region.y * height);
  return { left, top, width: Math.min(width, Math.ceil((region.x + region.width) * width)) - left, height: Math.min(height, Math.ceil((region.y + region.height) * height)) - top };
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const luminance = (color: ArrayLike<number>) => color[0] * .299 + color[1] * .587 + color[2] * .114;
export function background(data: Buffer, width: number, height: number, box: FigureBox, graphics?: ReadonlySet<number>): number[] {
  const samples: number[][] = [[], [], [], []];
  for (let y = Math.max(0, box.top - 2); y < Math.min(height, box.top + box.height + 2); y++) for (let x = Math.max(0, box.left - 2); x < Math.min(width, box.left + box.width + 2); x++) {
    const p = y * width + x;
    if (!inside(box, x, y) && !graphics?.has(p)) for (let c = 0; c < 4; c++) samples[c].push(data[p * 4 + c]);
  }
  if (!samples[0].length && graphics?.size) return background(data, width, height, box);
  return samples.map((values, c) => values.length ? median(values) : data[c]);
}
const padded = (box: FigureBox, amount: number, width: number, height: number): FigureBox => ({
  left: Math.max(0, box.left - amount), top: Math.max(0, box.top - amount),
  width: Math.min(width, box.left + box.width + amount) - Math.max(0, box.left - amount),
  height: Math.min(height, box.top + box.height + amount) - Math.max(0, box.top - amount),
});
export type FigureInk = { box: FigureBox; points: number[]; protectedPoints?: number[]; graphics?: ReadonlySet<number>; graphicsWindow?: FigureBox; fringe?: number[]; keepOut?: FigureBox; unsafe?: boolean; lineCount: number; lineHeights: number[]; uncertain: boolean; original?: FigureInk };
type InkComponent = { box: FigureBox; points: number[]; touches: boolean };
const maxInkPadding = 64, maxLetterGap = 6;

function extendInkLine(chosen: InkComponent[], eligible: InkComponent[], box: FigureBox, search: FigureBox, characterHeight: number, matchesColor?: (c: InkComponent) => boolean): void {
  // Use a fraction of the glyph height to cross letter spacing in tight OCR
  // boxes. Cap the gap so larger text does not bridge to nearby diagram marks.
  const maxGap = Math.min(maxLetterGap, Math.ceil(characterHeight / 3));
  const sameLine = (a: FigureBox, b: FigureBox) =>
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) >= Math.max(a.height, b.height) * .5;
  const seeds = chosen.filter(c => c.box.height >= characterHeight * .5);
  const measured = new Set(chosen);
  for (const direction of [-1, 1]) {
    const start = (b: FigureBox) => direction === 1 ? b.left : -(b.left + b.width);
    const candidates = eligible.filter(c => {
      const b = c.box;
      return !measured.has(c) && (!matchesColor || matchesColor(c)) && start(b) >= start(box) + box.width &&
        b.left > search.left && b.left + b.width < search.left + search.width &&
        b.width <= characterHeight * 1.5 && b.height >= characterHeight * .5 && b.height <= characterHeight * 1.5 &&
        seeds.some(s => sameLine(s.box, b));
    });
    for (const c of candidates.sort((a, b) => start(a.box) - start(b.box))) {
      if (chosen.some(p => {
        const gap = start(c.box) - start(p.box) - p.box.width;
        return gap >= 0 && gap <= maxGap && sameLine(p.box, c.box);
      })) chosen.push(c);
    }
  }
}

// Pango's raster has only glyphs. Keep its measurement independent of artwork.
export function measureGlyphInk(data: Buffer, width: number, height: number, box: FigureBox): FigureInk {
  return measureInk(data, width, height, box, [], FIGURE_SPACE.contrast);
}

function inkComponents(data: Buffer, width: number, box: FigureBox, search: FigureBox, others: FigureBox[], color: number[], threshold: number, graphics?: ReadonlySet<number>) {
  const light = luminance(color) > 128, ground = luminance(color);
  const n = boxArea(search), mask = new Uint8Array(n), seen = new Uint8Array(n);
  for (let y = 0; y < search.height; y++) for (let x = 0; x < search.width; x++) {
    const gx = x + search.left, gy = y + search.top, pixel = gy * width + gx, p = pixel * 4;
    if (graphics?.has(pixel) || others.some(b => inside(b, gx, gy))) continue;
    const contrast = color[3] <= 16 ? data[p + 3] - color[3] : (light ? 1 : -1) * (ground - (data[p] * .299 + data[p + 1] * .587 + data[p + 2] * .114));
    if (contrast > threshold) mask[y * search.width + x] = 1;
  }
  const components: InkComponent[] = [], tinyPoints = new Set<number>();
  for (let p = 0; p < n; p++) {
    if (!mask[p] || seen[p]) continue;
    const queue = [p]; seen[p] = 1;
    let left = search.width, right = 0, top = search.height, bottom = 0, touches = false;
    for (let k = 0; k < queue.length; k++) {
      const at = queue[k], x = at % search.width, y = Math.floor(at / search.width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      touches ||= inside(box, x + search.left, y + search.top);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, q = ny * search.width + nx;
        if (nx >= 0 && nx < search.width && ny >= 0 && ny < search.height && mask[q] && !seen[q]) { seen[q] = 1; queue.push(q); }
      }
    }
    const b = { left: left + search.left, top: top + search.top, width: right - left + 1, height: bottom - top + 1 };
    const points = queue.map(at => (Math.floor(at / search.width) + search.top) * width + at % search.width + search.left);
    if (points.length < 4) for (const at of points) tinyPoints.add(at);
    else components.push({ box: b, points, touches });
  }
  return { components, tinyPoints, mask };
}

function measureInk(data: Buffer, width: number, height: number, box: FigureBox, others: FigureBox[], threshold: number, original?: FigureInk, graphics?: ReadonlySet<number>): FigureInk {
  const color = background(data, width, height, box, graphics), light = luminance(color) > 128;
  let final: FigureInk = original ?? { box, points: [], lineCount: 0, lineHeights: [], uncertain: false, graphics };
  for (let padding = 8; padding <= maxInkPadding; padding *= 2) {
    const local = padded(box, padding, width, height);
    const wide = original ? padded(box, maxInkPadding, width, height) : local;
    const search = { ...local, left: wide.left, width: wide.width };
    if (graphics && (search.width > FIGURE_SPACE.maxWindowWidth || search.height > FIGURE_SPACE.maxWindowHeight)) return { ...final, uncertain: true };
    const { components: found, tinyPoints, mask } = inkComponents(data, width, box, search, others, color, threshold, graphics);
    const components = found.filter(({ box: b }) => {
      const narrowUpright = b.height > box.height * .8 && b.width <= 2;
      const atSide = b.left <= box.left || b.left + b.width >= box.left + box.width;
      const outsideRow = b.top < box.top || b.top + b.height > box.top + box.height;
      if (graphics) {
        // A narrow upright such as an I or a numeral can protrude a pixel
        // beyond the OCR row. Exclude a possible rule at the side or running
        // substantially beyond the row after the artwork pass.
        return !narrowUpright || !atSide && b.height <= box.height + 4;
      }
      return !(b.width > box.width * .8 && b.height <= 3) && !(narrowUpright && (atSide || outsideRow));
    });
    const recovery = padded(box, 8, width, height);
    const eligible = components.filter(c => {
      const b = c.box;
      let encloses = b.left < box.left && b.top < box.top && b.left + b.width > box.left + box.width && b.top + b.height > box.top + box.height;
      if (!encloses && components.some(other => other !== c && other.box.left >= b.left + 4 && other.box.top >= b.top + 4 && other.box.left + other.box.width <= b.left + b.width - 4 && other.box.top + other.box.height <= b.top + b.height - 4)) {
        const edges = [0, 0, 0, 0];
        for (const p of c.points) {
          const x = p % width, y = Math.floor(p / width);
          if (x === b.left) edges[0]++; if (x === b.left + b.width - 1) edges[1]++;
          if (y === b.top) edges[2]++; if (y === b.top + b.height - 1) edges[3]++;
        }
        encloses = edges[0] >= b.height * .65 && edges[1] >= b.height * .65 && edges[2] >= b.width * .65 && edges[3] >= b.width * .65;
      }
      const oversized = b.width > box.width + 16 || b.height > box.height + 16;
      return !encloses && !oversized;
    });
    // A brightening background can join white glyphs into a huge component.
    // Retry its segmentation at half the strong foreground contrast; retain
    // enclosures and the existing erasure fringe rather than swallowing fills.
    if (!light && threshold === FIGURE_SPACE.contrast && components.some(c => c.touches && !eligible.includes(c) && (!(c.box.left < box.left && c.box.top < box.top && c.box.left + c.box.width > box.left + box.width && c.box.top + c.box.height > box.top + box.height) || figureBacking(data, width, height, { ...final, box })))) {
      const contrasts: number[] = [];
      for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
        const p = (y * width + x) * 4;
        contrasts.push(color[3] <= 16 ? data[p + 3] - color[3] : (light ? 1 : -1) * (luminance(color) - luminance(data.subarray(p, p + 3))));
      }
      contrasts.sort((a, b) => a - b);
      const stronger = (contrasts[Math.floor(contrasts.length * .95)] ?? 0) * .5;
      if (stronger > FIGURE_SPACE.contrast) return measureInk(data, width, height, box, others, stronger, original, graphics);
    }
    const primary = eligible.filter(c => c.touches);
    const letters = graphics ? primary.filter(c => c.box.height >= 4 && c.box.width <= c.box.height * 3) : primary;
    const characterHeight = letters.length ? median(letters.map(c => c.box.height)) : box.height;
    const matchesColor = graphics && letters.length >= 2 ? sourceColorMatcher(data, letters.map(c => c.points), color) : undefined;
    // OCR can enclose a colored status icon along with several same-color
    // glyphs. Keep the label intact when its colored shape may carry meaning.
    const distinctMark = matchesColor && letters.filter(c => matchesColor(c.points)).length >= 2 &&
      primary.some(c => hasDistinctMark(data, c, characterHeight, matchesColor));
    const chosen = eligible.filter(c => c.touches ||
      c.box.left >= recovery.left && c.box.top >= recovery.top && c.box.left + c.box.width <= recovery.left + recovery.width && c.box.top + c.box.height <= recovery.top + recovery.height &&
      c.box.width <= characterHeight * 1.5 && c.box.height <= characterHeight * 1.5 &&
      primary.some(p => c.box.top < p.box.top + p.box.height && p.box.top < c.box.top + c.box.height));
    if (!chosen.length) return final;
    if (original) {
      // Widening the raster can join strokes to artwork. Keep the original
      // measurement unless the wider raster adds a continuation to the same ink.
      const core = chosen.flatMap(c => c.points), originalPoints = new Set(original.points);
      if (core.length !== original.points.length || core.some(p => !originalPoints.has(p))) return original;
      const count = chosen.length;
      extendInkLine(chosen, eligible, box, search, characterHeight, matchesColor && (c => matchesColor(c.points)));
      if (chosen.length === count) return original;
    }
    const points = chosen.flatMap(c => c.points), rows = new Uint32Array(height);
    let left = width, right = 0, top = height, bottom = 0;
    for (const p of points) { const x = p % width, y = Math.floor(p / width); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); rows[y]++; }
    const lineHeights: number[] = []; let start = -1, end = -1;
    for (let y = top; y <= bottom + 3; y++) {
      if ((rows[y] ?? 0) >= 2) { if (start < 0) start = y; end = y; }
      else if (start >= 0 && y - end >= 3) { lineHeights.push(end - start + 1); start = -1; }
    }
    // Closely set lines may have fewer than three empty raster rows. Cluster
    // substantial character components by vertical centre as a second signal;
    // small dots and radicals cannot create extra lines on their own.
    const substantial = chosen.filter(c => c.box.height >= Math.max(...chosen.map(c => c.box.height)) * .5);
    const groups: { centre: number; count: number; top: number; bottom: number }[] = [];
    const typicalHeight = median(substantial.map(c => c.box.height));
    for (const c of substantial.sort((a, b) => a.box.top + a.box.height / 2 - b.box.top - b.box.height / 2)) {
      const centre = c.box.top + c.box.height / 2, previous = groups.at(-1);
      if (previous && centre - previous.centre <= typicalHeight * .65) {
        previous.centre = (previous.centre * previous.count + centre) / ++previous.count;
        previous.top = Math.min(previous.top, c.box.top); previous.bottom = Math.max(previous.bottom, c.box.top + c.box.height);
      } else groups.push({ centre, count: 1, top: c.box.top, bottom: c.box.top + c.box.height });
    }
    const measuredLines = groups.length > lineHeights.length ? groups.map(g => g.bottom - g.top) : lineHeights;
    const tight = { left, top, width: right - left + 1, height: bottom - top + 1 };
    const clipped = left === search.left && left > 0 || top === search.top && top > 0 || right + 1 === search.left + search.width && right + 1 < width || bottom + 1 === search.top + search.height && bottom + 1 < height;
    const own = new Set(points), protectedPoints: number[] = [], protection = padded(tight, FIGURE_SPACE.glyphFringe, width, height);
    for (let p = 0; p < mask.length; p++) if (mask[p]) {
      const x = p % search.width + search.left, y = Math.floor(p / search.width) + search.top;
      if (!inside(local, x, y) && !inside(protection, x, y)) continue;
      const global = y * width + x;
      if (own.has(global)) continue;
      // Tiny disconnected antialias fragments inside the OCR label belong to
      // its erasure fringe. Substantial components and exterior marks do not.
      let fringe = false;
      if (tinyPoints.has(global) && inside(box, global % width, Math.floor(global / width))) {
        for (let dy = -FIGURE_SPACE.glyphFringe; dy <= FIGURE_SPACE.glyphFringe && !fringe; dy++) for (let dx = -FIGURE_SPACE.glyphFringe; dx <= FIGURE_SPACE.glyphFringe; dx++) {
          const x = global % width + dx;
          if (x >= 0 && x < width && own.has(global + dy * width + dx)) { fringe = true; break; }
        }
      }
      if (!fringe) protectedPoints.push(global);
    }
    final = { box: tight, points, protectedPoints, graphics, lineCount: measuredLines.length, lineHeights: measuredLines,
      uncertain: clipped, unsafe: distinctMark || original?.unsafe, ...(original && { original }) };
    if (!clipped) break;
  }
  const right = box.left + box.width, inkRight = final.box.left + final.box.width;
  const nearSide = box.left >= 8 && final.box.left - box.left <= maxLetterGap ||
    width - right >= 8 && right - inkRight <= maxLetterGap;
  return !original && !final.uncertain && nearSide
    ? measureInk(data, width, height, box, others, threshold, final, graphics) : final;
}

function sourceColorMatcher(data: Buffer, components: number[][], ground: number[]) {
  const samples = components.map(points => {
    let peak = points[0], contrast = 0;
    for (const p of points) {
      const delta = Math.abs(luminance(data.subarray(p * 4, p * 4 + 3)) - luminance(ground));
      if (delta > contrast) { contrast = delta; peak = p; }
    }
    return peak * 4;
  });
  const color = [0, 1, 2, 3].map(c => median(samples.map(p => data[p + c])));
  return (points: number[]) => points.some(p => {
    const q = p * 4;
    if (ground[3] <= 16) return data[q + 3] >= Math.max(40, color[3] - 64);
    return color.slice(0, 3).every((c, channel) => Math.abs(data[q + channel] - c) <= FIGURE_GRAPHICS.sourceColorDelta);
  });
}

function hasDistinctMark(data: Buffer, component: InkComponent, characterHeight: number, matchesColor: (points: number[]) => boolean): boolean {
  const { width, height } = component.box, short = Math.min(width, height), long = Math.max(width, height);
  const { minSize, maxAspectRatio, minSaturation } = FIGURE_GRAPHICS.mark;
  if (short < Math.max(minSize, characterHeight * .5) || long > short * maxAspectRatio || matchesColor(component.points)) return false;
  let saturated = 0;
  for (const p of component.points) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) >= minSaturation && ++saturated >= long) return true;
  }
  return false;
}

function boundsOf(points: readonly number[], width: number): FigureBox {
  let left = width, right = 0, top = Infinity, bottom = 0;
  for (const p of points) {
    const x = p % width, y = Math.floor(p / width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function enclosingBox(a: FigureBox, b: FigureBox): FigureBox {
  const left = Math.min(a.left, b.left), top = Math.min(a.top, b.top);
  return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top };
}

function recoverFigureRows(data: Buffer, width: number, height: number, box: FigureBox, others: FigureBox[], ink: FigureInk) {
  const original = ink.original ?? ink, ground = background(data, width, height, box, ink.graphics);
  const characterHeight = median(ink.lineHeights.slice()) || Math.min(32, ink.box.height);
  const distance = Math.min(48, Math.max(12, Math.ceil(characterHeight * 2.5)));
  const near = padded(ink.box, distance, width, height), across = padded(ink.box, 8, width, height);
  const search = { ...near, left: across.left, width: across.width };
  if (boxArea(search) > FIGURE_SPACE.maxWindowPixels || search.height > FIGURE_SPACE.maxWindowHeight || search.width > FIGURE_SPACE.maxWindowWidth) return { ...ink, unsafe: true };
  const { components } = inkComponents(data, width, ink.box, search, others, ground, FIGURE_SPACE.contrast, ink.graphics);
  const own = new Set(ink.points);
  const letter = (c: InkComponent) => c.box.height >= Math.max(4, characterHeight * .45) &&
    c.box.height <= characterHeight * 1.6 && c.box.width <= characterHeight * 2.5;
  const primary = components.filter(c => letter(c) && c.points.some(p => own.has(p)));
  if (primary.length < 2) return ink;
  const sameColor = sourceColorMatcher(data, primary.map(c => c.points), ground);
  const bottom = (b: FigureBox) => b.top + b.height;
  // Leave vertical continuation to the bounded row search even when the
  // initial OCR window never clipped any of the measured glyphs.
  const candidates = components.filter(c => letter(c) && !c.touches &&
    (bottom(c.box) <= ink.box.top || c.box.top >= bottom(ink.box)) && sameColor(c.points));
  const consumed = new Set<InkComponent>();
  const rows: InkComponent[][] = [];
  for (const seed of candidates) {
    if (consumed.has(seed)) continue;
    const centre = seed.box.top + seed.box.height / 2;
    const row = candidates.filter(c => !consumed.has(c) && Math.abs(c.box.top + c.box.height / 2 - centre) <= characterHeight * .38)
      .sort((a, b) => a.box.left - b.box.left);
    for (const c of row) consumed.add(c);
    let word: InkComponent[] = [];
    for (const c of row) {
      const previous = word.at(-1)?.box;
      if (previous && c.box.left - previous.left - previous.width > characterHeight * .85) {
        if (word.length >= 2) rows.push(word);
        word = [];
      }
      word.push(c);
    }
    if (word.length >= 2) rows.push(word);
  }
  const rowsWithBounds = rows.map(row => ({ row, box: boundsOf(row.flatMap(c => c.points), width) }));
  const selected: typeof rowsWithBounds = [];
  let unsafe = false;
  for (const side of [-1, 1]) {
    let anchor = ink.box;
    const adjacent = rowsWithBounds.filter(r => side === 1 ? r.box.top >= bottom(ink.box) : bottom(r.box) <= ink.box.top)
      .sort((a, b) => side * (a.box.top - b.box.top));
    for (const entry of adjacent) {
      const b = entry.box, gap = side === 1 ? b.top - bottom(anchor) : anchor.top - bottom(b);
      const right = b.left + b.width, anchorRight = anchor.left + anchor.width;
      const overlap = Math.min(right, anchorRight) - Math.max(b.left, anchor.left);
      const align = Math.min(Math.abs(b.left - anchor.left), Math.abs(right - anchorRight),
        Math.abs(b.left + right - anchor.left - anchorRight) / 2);
      if (gap < -characterHeight * .5 || gap > Math.max(4, characterHeight * .85) ||
          overlap < Math.min(b.width, anchor.width) * .62 || align > Math.max(5, characterHeight * .8)) continue;
      const competingBox = padded(b, 2, width, height);
      unsafe ||= gap < 0 || selected.length >= 2 ||
        b.top <= search.top + 1 || bottom(b) >= bottom(search) - 1 ||
        b.left <= search.left && search.left > 0 || right >= search.left + search.width && right < width ||
        others.some(o => o.left < competingBox.left + competingBox.width && competingBox.left < o.left + o.width &&
          o.top < bottom(competingBox) && competingBox.top < bottom(o));
      selected.push(entry);
      anchor = b;
      if (unsafe) break;
    }
  }
  if (!selected.length) return ink;
  const recovered = selected.flatMap(({ row, box: b }) => {
    const line = padded(b, 3, width, height);
    return components.filter(c => row.includes(c) || !c.touches && c.box.height <= characterHeight * .55 &&
      inside(line, c.box.left, c.box.top) && inside(line, c.box.left + c.box.width - 1, bottom(c.box) - 1) && sameColor(c.points))
      .flatMap(c => c.points);
  });
  const points = [...new Set([...ink.points, ...recovered])], tight = boundsOf(points, width);
  const extra = new Set(recovered), protectedPoints = ink.protectedPoints?.filter(p => !extra.has(p));
  const lineHeights = [...selected.filter(r => r.box.top < ink.box.top).reverse().map(r => r.box.height),
    ...ink.lineHeights, ...selected.filter(r => r.box.top >= ink.box.top).map(r => r.box.height)];
  return { ...ink, box: tight, points, protectedPoints, lineCount: lineHeights.length, lineHeights, keepOut: tight, original, unsafe };
}

function figureSourceFringe(data: Buffer, width: number, height: number, ink: FigureInk, others: FigureBox[], source: FigureBox): number[] {
  const { points, graphics, protectedPoints } = ink;
  const radius = FIGURE_SPACE.glyphFringe - 1;
  const ground = background(data, width, height, source, graphics);
  const excluded = new Set(protectedPoints), core = new Set(points), fringe = new Set<number>();
  for (const p of points) {
    const x = p % width, y = Math.floor(p / width);
    if (x > 0 && x + 1 < width && core.has(p - 1) && core.has(p + 1) && core.has(p - width) && core.has(p + width)) continue;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const sx = x + dx, sy = y + dy, q = sy * width + sx;
      if (sx < 0 || sx >= width || sy < 0 || sy >= height || core.has(q) || fringe.has(q) ||
          graphics?.has(q) || excluded.has(q) || others.some(b => inside(b, sx, sy))) continue;
      const rx = sx + Math.sign(dx) * radius, ry = sy + Math.sign(dy) * radius;
      if (rx >= 0 && rx < width && ry >= 0 && ry < height && figurePixelDelta(data, q, ry * width + rx) < 4) continue;
      const ref = [];
      for (const offset of [-1, 0, 1]) {
        const tx = rx + Math.sign(dy) * offset, ty = ry - Math.sign(dx) * offset, at = ty * width + tx;
        if (tx >= 0 && tx < width && ty >= 0 && ty < height && !core.has(at) && !graphics?.has(at) && !excluded.has(at)) ref.push(at * 4);
      }
      if (ref.length < 2) continue;
      const alpha = ground[3] <= 16;
      let dot = 0, sourceLength = 0, length = 0, contrast = 0, texture = 0;
      for (let c = alpha ? 3 : 0; c < (alpha ? 4 : 3); c++) {
        const samples = ref.map(at => data[at + c]).sort((a, b) => a - b), color = samples[Math.floor(samples.length / 2)];
        const a = data[p * 4 + c] - color, b = data[q * 4 + c] - color;
        dot += a * b; sourceLength += a * a; length += b * b; contrast = Math.max(contrast, Math.abs(b));
        texture = Math.max(texture, samples.at(-1)! - samples[0]);
      }
      if (sourceLength <= 0 || contrast < 8 + texture || dot <= 0 || dot > sourceLength * 1.1) continue;
      const error = Math.sqrt(Math.max(0, length - dot * dot / sourceLength));
      if (error <= Math.max(5, contrast * .16)) fringe.add(q);
    }
  }
  return [...fringe];
}

// Two aligned pieces of a rule can stay visible between glyphs even when
// the stroke search cannot follow the rule through the whole word.
function figureInkCrossesRule(data: Buffer, width: number, height: number, ink: FigureInk): boolean {
  const { box, graphics } = ink;
  if (!graphics?.size) return false;
  const { maxSpan, endpointSearch, continuation, endpointColorDelta, visibleColorDelta } = FIGURE_GRAPHICS.crossing;
  for (const vertical of [false, true]) {
    const start = vertical ? box.top : box.left, length = vertical ? box.height : box.width;
    if (length > maxSpan) continue;
    const end = start + length, limit = vertical ? height : width;
    const first = Math.max(0, start - endpointSearch), last = Math.min(limit, end + endpointSearch);
    const across = vertical ? box.left : box.top, rows = vertical ? box.width : box.height;
    const pixel = (u: number, v: number) => vertical ? u * width + v : v * width + u;
    for (let v = across; v < across + rows; v++) {
      let before = start - 1, after = end;
      while (before >= first && !graphics.has(pixel(before, v))) before--;
      while (after < last && !graphics.has(pixel(after, v))) after++;
      if (before < first || after >= last) continue;
      // Side walls of a frame can leave two dots in the same row. Each
      // endpoint must continue in the direction of the proposed rule.
      if (before < continuation || after + continuation >= limit ||
          !graphics.has(pixel(before - continuation, v)) || !graphics.has(pixel(after + continuation, v))) continue;
      const a = pixel(before, v), b = pixel(after, v);
      if (figurePixelDelta(data, a, b) > endpointColorDelta) continue;
      let visible = 0;
      for (let u = start; u < end; u++) {
        const p = pixel(u, v);
        if (figurePixelDelta(data, p, a) <= visibleColorDelta && figurePixelDelta(data, p, b) <= visibleColorDelta) visible++;
      }
      if (visible * 3 >= length && ink.points.some(p => (vertical ? p % width : Math.floor(p / width)) === v)) return true;
    }
  }
  return false;
}

export function measureFigureInk(data: Buffer, width: number, height: number, box: FigureBox, others: FigureBox[], graphics = figureGraphics(data, width, height, [box, ...others])): FigureInk {
  const ink = measureInk(data, width, height, box, others, FIGURE_SPACE.contrast, undefined, graphics);
  const graphicsWindow = figureSpaceWindow(box, width, height);
  if (!ink.points.length) {
    // A clear OCR box still supplies an anchor. If the raster contains
    // unclassified foreground there, keep the source for an external note.
    const ground = background(data, width, height, box, graphics);
    let unsafe = ink.uncertain;
    for (let y = box.top; !unsafe && y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
      const p = y * width + x, q = p * 4;
      if (graphics.has(p) || Math.abs(data[q + 3] - ground[3]) > 8 ||
          ground[3] > 16 && ground.slice(0, 3).some((value, c) => Math.abs(value - data[q + c]) > 12)) { unsafe = true; break; }
    }
    return { ...ink, graphicsWindow, keepOut: box, unsafe };
  }
  const recovered = recoverFigureRows(data, width, height, box, others, ink);
  let unsafe = ink.unsafe || recovered.unsafe || recovered.uncertain || figureInkCrossesRule(data, width, height, recovered);
  // A solid connection at the cut between source ink and a path cannot be
  // erased as text alone. Check both color and adjacency on the original raster.
  for (const p of recovered.points) {
    if (unsafe || !graphics.size) break;
    const x = p % width;
    for (const q of [p - width, p + width, ...(x ? [p - 1] : []), ...(x + 1 < width ? [p + 1] : [])]) {
      if (graphics.has(q) && figurePixelDelta(data, p, q) <= FIGURE_GRAPHICS.joinedStrokeColorDelta) { unsafe = true; break; }
    }
  }
  const fringe = figureSourceFringe(data, width, height, recovered, others, box);
  const tight = boundsOf([...recovered.points, ...fringe], width);
  // The layout can still use the unexpanded measurement. Both layouts carry
  // the safety decision and the complete source extent for neighbouring labels.
  const keepOut = unsafe ? enclosingBox(tight, box) : tight;
  return { ...recovered, graphicsWindow, unsafe, fringe, keepOut, ...(recovered.original && {
    original: { ...recovered.original, graphicsWindow, unsafe, keepOut },
  }) };
}

export function figureGraphics(data: Buffer, width: number, height: number, boxes: FigureBox[]): Set<number> {
  const graphics = new Set<number>(), windows = new Map<string, { window: FigureBox; characterHeight: number }>();
  const sourceExtents = boxes.map(box => {
    const search = padded(box, 8, width, height), window = figureSpaceWindow(box, width, height);
    let characterHeight = box.height, extent = box;
    if (search.width <= FIGURE_SPACE.maxWindowWidth && search.height <= FIGURE_SPACE.maxWindowHeight) {
      const color = background(data, width, height, box);
      const { components } = inkComponents(data, width, box, search, [], color, FIGURE_SPACE.contrast);
      const glyph = (c: InkComponent) => c.box.height >= 4 && c.box.height <= box.height && c.box.width <= 2.5 * c.box.height;
      const core = components.filter(c => c.touches && glyph(c));
      if (core.length >= 2) {
        characterHeight = median(core.map(c => c.box.height));
        extendInkLine(core, components.filter(glyph), box, search, characterHeight);
        extent = enclosingBox(box, boundsOf(core.flatMap(c => c.points), width));
      }
    }
    const key = [window.left, window.top, window.width, window.height].join(":");
    const prior = windows.get(key);
    if (!prior || prior.characterHeight > characterHeight) windows.set(key, { window, characterHeight });
    return extent;
  });
  // Coalesce overlapping search windows if their union stays within the
  // layout budget. Adjacent labels then share the same stroke search.
  const searches: { window: FigureBox; characterHeight: number }[] = [];
  for (const search of windows.values()) {
    let { window, characterHeight } = search;
    for (let i = searches.length - 1; i >= 0; i--) {
      const previous = searches[i], bounds = enclosingBox(window, previous.window);
      if (bounds.width <= FIGURE_SPACE.maxWindowWidth && bounds.height <= FIGURE_SPACE.maxWindowHeight &&
          boxArea(bounds) <= FIGURE_SPACE.maxWindowPixels && boxArea(bounds) < boxArea(window) + boxArea(previous.window)) {
        window = bounds;
        characterHeight = Math.min(characterHeight, previous.characterHeight);
        searches.splice(i, 1);
      }
    }
    searches.push({ window, characterHeight });
  }
  for (const { window, characterHeight } of searches) findFigureGraphics(data, width, window, characterHeight, sourceExtents, graphics);
  return graphics;
}

export function measureFigure(data: Buffer, width: number, height: number, reading: FigureReading): FigureInk[] {
  const boxes = reading.regions.map(r => figureBox(r, width, height));
  const retained = (reading.protectedBoxes ?? []).map(b => figureBox(b, width, height));
  const graphics = figureGraphics(data, width, height, [...boxes, ...retained]);
  return boxes.map((box, i) => measureFigureInk(data, width, height, box, [...boxes.filter((_, j) => i !== j), ...retained], graphics));
}

// Exact maximal rectangles containing the complete anchor, in O(width*height).
// Keep a range of aspect ratios; a smaller rectangle may fit words better.
export function figureRectangles(mask: Uint8Array, width: number, height: number, anchor: FigureBox): FigureBox[] {
  const heights = new Int32Array(width), stack = new Int32Array(width + 1), candidates = new Map<number, FigureBox>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) heights[x] = mask[y * width + x] ? heights[x] + 1 : 0;
    let size = 0;
    for (let x = 0; x <= width; x++) {
      const h = x === width ? 0 : heights[x];
      while (size && heights[stack[size - 1]] > h) {
        const rh = heights[stack[--size]], left = size ? stack[size - 1] + 1 : 0;
        const b = { left, top: y + 1 - rh, width: x - left, height: rh };
        if (left > anchor.left || b.top > anchor.top || x < anchor.left + anchor.width || y + 1 < anchor.top + anchor.height) continue;
        const bucket = Math.round(Math.log2(b.width / b.height) * 4), previous = candidates.get(bucket);
        if (!previous || boxArea(b) > boxArea(previous)) candidates.set(bucket, b);
      }
      stack[size++] = x;
    }
  }
  return [...candidates.values()].sort((a, b) => boxArea(b) - boxArea(a));
}

// Restore a local color field rather than painting a single median color. Ring
// medians reject isolated ink; opposite edges preserve linear color gradients.
export function figureBackgroundPatch(data: Buffer, width: number, height: number, box: FigureBox, ink?: FigureInk, surface?: FigureBackground, requireSurfaceMatch = false): Buffer {
  if (surface?.backing && ink) {
    const out = Buffer.alloc(boxArea(box) * 4);
    for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) out.set(surfaceColor(surface, box.left + x, box.top + y), (y * box.width + x) * 4);
    return out;
  }
  if (surface && ink) {
    // Fit geometry with the smooth model, but erase using nearby real colors.
    // The nearest agreeing pair preserves curved gradients and fill edges.
    const out = Buffer.alloc(boxArea(box) * 4), search = padded(box, 32, width, height), n = boxArea(search), excluded = new Uint8Array(n);
    for (const p of figureGraphicsInBox(ink.graphics, width, search)) excluded[(Math.floor(p / width) - search.top) * search.width + p % width - search.left] = 1;
    for (const p of [...ink.points, ...ink.protectedPoints ?? []]) for (let dy = -FIGURE_SPACE.glyphFringe; dy <= FIGURE_SPACE.glyphFringe; dy++) for (let dx = -FIGURE_SPACE.glyphFringe; dx <= FIGURE_SPACE.glyphFringe; dx++) {
      const x = p % width + dx, y = Math.floor(p / width) + dy;
      if (inside(search, x, y)) excluded[(y - search.top) * search.width + x - search.left] = 1;
    }
    if (requireSurfaceMatch) for (let y = 0; y < search.height; y++) for (let x = 0; x < search.width; x++) {
      const p = y * search.width + x, gx = search.left + x, gy = search.top + y;
      if (!excluded[p] && !surfaceMatches(surface, data, gx, gy, (gy * width + gx) * 4)) excluded[p] = 1;
    }
    const nearest = Array.from({ length: 4 }, () => new Int32Array(n).fill(-1));
    for (let p = 0; p < n; p++) {
      const x = p % search.width;
      nearest[0][p] = x ? !excluded[p - 1] ? p - 1 : nearest[0][p - 1] : -1;
      nearest[2][p] = p >= search.width ? !excluded[p - search.width] ? p - search.width : nearest[2][p - search.width] : -1;
    }
    for (let p = n - 1; p >= 0; p--) {
      const x = p % search.width;
      nearest[1][p] = x + 1 < search.width ? !excluded[p + 1] ? p + 1 : nearest[1][p + 1] : -1;
      nearest[3][p] = p + search.width < n ? !excluded[p + search.width] ? p + search.width : nearest[3][p + search.width] : -1;
    }
    const global = (p: number) => ((Math.floor(p / search.width) + search.top) * width + p % search.width + search.left);
    for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
      const p = (box.top + y - search.top) * search.width + box.left + x - search.left;
      let best = Infinity, a = -1, b = -1, fraction = .5;
      for (let axis = 0; axis < 4; axis += 2) {
        const l = nearest[axis][p], r = nearest[axis + 1][p]; if (l < 0 || r < 0) continue;
        const span = (r - l) / (axis ? search.width : 1), delta = figurePixelDelta(data, global(l), global(r));
        const score = span + (delta > FIGURE_SPACE.backgroundNoise ? 64 : 0);
        if (score < best) { best = score; a = global(l); b = global(r); fraction = (p - l) / (r - l); }
      }
      const fallback = surfaceColor(surface, box.left + x, box.top + y);
      for (let c = 0; c < 4; c++) out[(y * box.width + x) * 4 + c] = a < 0 ? fallback[c] : Math.round(data[a * 4 + c] * (1 - fraction) + data[b * 4 + c] * fraction);
    }
    return out;
  }
  const out = Buffer.alloc(boxArea(box) * 4), fallback = background(data, width, height, ink?.box ?? box, ink?.graphics);
  // Close outlines can cover the sampling edges around the erasure fringe.
  // Reject protected marks and color outliers before interpolating the field.
  const protectedPoints = new Set(ink?.protectedPoints);
  const sample = (x: number, y: number, horizontal: boolean) => {
    const values: number[][] = [[], [], [], []];
    for (let d = -2; d <= 2; d++) {
      const sx = horizontal ? x : x + d, sy = horizontal ? y + d : y;
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
      const p = sy * width + sx, q = p * 4;
      if (protectedPoints.has(p) || ink?.graphics?.has(p) || Math.abs(data[q + 3] - fallback[3]) > FIGURE_SPACE.backgroundNoise) continue;
      if ((fallback[3] > 16 || data[q + 3] > 16) && Math.max(Math.abs(data[q] - fallback[0]), Math.abs(data[q + 1] - fallback[1]), Math.abs(data[q + 2] - fallback[2])) > FIGURE_SPACE.backgroundNoise) continue;
      for (let c = 0; c < 4; c++) values[c].push(data[q + c]);
    }
    return values.map((channel, c) => channel.length ? median(channel) : fallback[c]);
  };
  const horizontal = box.left > 0 && box.left + box.width < width;
  const vertical = box.top > 0 && box.top + box.height < height;
  const edges = [new Uint8Array(box.height * 4), new Uint8Array(box.height * 4), new Uint8Array(box.width * 4), new Uint8Array(box.width * 4)];
  for (let y = 0; y < box.height; y++) {
    edges[0].set(sample(box.left - 1, box.top + y, true), y * 4);
    edges[1].set(sample(box.left + box.width, box.top + y, true), y * 4);
  }
  for (let x = 0; x < box.width; x++) {
    edges[2].set(sample(box.left + x, box.top - 1, false), x * 4);
    edges[3].set(sample(box.left + x, box.top + box.height, false), x * 4);
  }
  for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
    const a = (x + 1) / (box.width + 1), b = (y + 1) / (box.height + 1);
    for (let c = 0; c < 4; c++) {
      const h = edges[0][y * 4 + c] * (1 - a) + edges[1][y * 4 + c] * a;
      const v = edges[2][x * 4 + c] * (1 - b) + edges[3][x * 4 + c] * b;
      out[(y * box.width + x) * 4 + c] = Math.round(horizontal && vertical ? (h + v) / 2 : horizontal ? h : vertical ? v : fallback[c]);
    }
  }
  return out;
}

export function restoreFigureBackground(data: Buffer, width: number, height: number, box: FigureBox): Buffer {
  const out = Buffer.from(data), patch = figureBackgroundPatch(data, width, height, box);
  for (let y = 0; y < box.height; y++) patch.copy(out, ((box.top + y) * width + box.left) * 4, y * box.width * 4, (y + 1) * box.width * 4);
  return out;
}

// A smooth placement model must also describe the actual colors restored at
// every source glyph. Otherwise erasing text across a fill edge is uncertain.
export function figureBackgroundPatchAgrees(patch: Buffer, box: FigureBox, width: number, ink: FigureInk, surface: FigureBackground): boolean {
  return ink.points.every(p => {
    const x = p % width, y = Math.floor(p / width), q = ((y - box.top) * box.width + x - box.left) * 4;
    return surfaceMatches(surface, patch.subarray(q, q + 4), x, y);
  });
}

// A fallback model is used only after the original placement has failed.
export type FigureBackground = { box: FigureBox; channels: number[][]; bounds?: FigureBox; backing?: { box: FigureBox; top: number[][]; bottom: number[][] } };
// Paired dark edges across nearly the complete text width certify a shallow
// backing. Search stays between those edges and within the glyph fringe at
// either end; color changes beneath a translucent backing do not enlarge it.
function figureBacking(data: Buffer, width: number, height: number, ink: FigureInk): FigureBackground | undefined {
  const box = ink.box;
  if (box.height > 32 || box.width > FIGURE_SPACE.maxWindowWidth || luminance(background(data, width, height, box, ink.graphics)) > 128) return;
  const sample = (x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x + 1) * 4));
  const edges: number[] = [];
  for (const side of [-1, 1]) {
    let best = 0, edge = -1;
    for (let d = 3; d <= 12; d++) {
      const y = side < 0 ? box.top - d : box.top + box.height - 1 + d;
      if (y < 2 || y + 2 >= height) continue;
      const deltas: number[] = [];
      for (let x = box.left + 3; x < box.left + box.width - 3; x++) {
        if (ink.graphics?.has((y + side * 2) * width + x) || ink.graphics?.has((y - side * 2) * width + x)) continue;
        deltas.push(luminance(sample(x, y + side * 2)) - luminance(sample(x, y - side * 2)));
      }
      const score = median(deltas);
      if (deltas.filter(d => d > FIGURE_SPACE.adjacentDelta).length >= deltas.length * .85 && score > FIGURE_SPACE.backgroundNoise && score > best) { best = score; edge = y - side * 2; }
    }
    if (edge < 0) return;
    edges.push(edge);
  }
  const bounds = { left: Math.max(0, box.left - 4), top: edges[0], width: Math.min(width, box.left + box.width + 4) - Math.max(0, box.left - 4), height: edges[1] - edges[0] + 1 };
  if (bounds.top > box.top || bounds.top + bounds.height < box.top + box.height) return;
  const colors = (y: number) => Array.from({ length: bounds.width }, (_, dx) => {
    const at = (d: number) => Math.max(0, Math.min(width - 1, bounds.left + dx + d));
    const xs = [-1, 0, 1].map(at);
    const unobstructed = (x: number) => !ink.graphics?.has(y * width + x);
    const clear = xs.every(unobstructed) ? xs : [-2, -1, 0, 1, 2].map(at).filter(unobstructed);
    return clear.length ? [0, 1, 2, 3].map(c => median(clear.map(x => sample(x, y)[c]))) : [];
  });
  // Preserve established small-backing models. Wide banners sample inside the
  // existing clearance to avoid edge ringing, without enlarging the backing.
  const inset = box.width > 256 ? FIGURE_SPACE.guard : 0;
  const top = colors(Math.min(bounds.top + inset, box.top - 1));
  const bottom = colors(Math.max(bounds.top + bounds.height - 1 - inset, box.top + box.height));
  if (top.some(c => !c.length) || bottom.some(c => !c.length)) return;
  return { box, channels: [], bounds, backing: { box: bounds, top, bottom } };
}
function surfaceMatches(surface: FigureBackground, color: ArrayLike<number>, x: number, y: number, offset = 0): boolean {
  const backing = surface.backing;
  if (backing) {
    if (!inside(backing.box, x, y)) return false;
    const dx = x - backing.box.left, top = backing.top[dx], bottom = backing.bottom[dx];
    for (let c = 0; c < 4; c++) if (color[offset + c] < Math.min(top[c], bottom[c]) - FIGURE_SPACE.backgroundNoise || color[offset + c] > Math.max(top[c], bottom[c]) + FIGURE_SPACE.backgroundNoise) return false;
    return true;
  }
  for (let c = 0; c < 4; c++) {
    const channel = surface.channels[c];
    const expected = Math.max(0, Math.min(255, Math.round(channel[0] + channel[1] * (x - surface.box.left) / surface.box.width + channel[2] * (y - surface.box.top) / surface.box.height)));
    if (Math.abs(color[offset + c] - expected) > FIGURE_SPACE.backgroundNoise) return false;
  }
  return true;
}
export function surfaceColor(surface: FigureBackground, x: number, y: number): number[] {
  const backing = surface.backing;
  if (backing) {
    const dx = Math.max(0, Math.min(backing.box.width - 1, x - backing.box.left)), fraction = Math.max(0, Math.min(1, (y - backing.box.top) / Math.max(1, backing.box.height - 1)));
    return backing.top[dx].map((v, c) => Math.round(v * (1 - fraction) + backing.bottom[dx][c] * fraction));
  }
  return surface.channels.map(c => Math.max(0, Math.min(255, Math.round(c[0] + c[1] * (x - surface.box.left) / surface.box.width + c[2] * (y - surface.box.top) / surface.box.height))));
}
// Robust spatial samples follow smooth color changes without raising the
// per-pixel noise allowance. Reject models with weak support or steep slopes.
function figureBackgroundSurface(data: Buffer, width: number, height: number, ink: FigureInk): FigureBackground | undefined {
  if (!ink.points.length) return;
  const backing = figureBacking(data, width, height, ink);
  if (backing) return backing;
  const box = ink.box, excluded = new Set<number>([...ink.points, ...ink.fringe ?? [], ...ink.protectedPoints ?? []]);

  const samples: { x: number; y: number; color: number[] }[] = [], step = Math.max(4, Math.ceil(Math.sqrt(boxArea(box) / 3000)));
  const reference = luminance(background(data, width, height, box, ink.graphics)), light = reference > 128;
  for (let y = box.top; y < box.top + box.height; y += step) for (let x = box.left; x < box.left + box.width; x += step) {
    const pixels: number[][] = [];
    for (let sy = y; sy < Math.min(y + step, box.top + box.height); sy++) for (let sx = x; sx < Math.min(x + step, box.left + box.width); sx++) {
      const p = sy * width + sx;
      const color = Array.from(data.subarray(p * 4, p * 4 + 4));
      if (!excluded.has(p) && !ink.graphics?.has(p) && (box.height > 32 || (light ? reference - luminance(color) : luminance(color) - reference) <= FIGURE_SPACE.contrast)) pixels.push(color);
    }
    if (!pixels.length) continue;
    pixels.sort((a, b) => luminance(a) - luminance(b));
    const middle = pixels.slice(Math.floor(pixels.length / 4), Math.max(1, Math.ceil(pixels.length * .75)));
    samples.push({ x: (x + (Math.min(step, box.left + box.width - x) - 1) / 2 - box.left) / box.width,
      y: (y + (Math.min(step, box.top + box.height - y) - 1) / 2 - box.top) / box.height,
      color: [0, 1, 2, 3].map(c => middle.reduce((sum, p) => sum + p[c], 0) / middle.length) });
  }
  let kept = samples, channels: number[][] = [];
  for (let iteration = 0; iteration < 4; iteration++) {
    if (kept.length < 12 || kept.length < samples.length * .6) return;
    const matrix = Array.from({ length: 3 }, () => Array(7).fill(0));
    for (const s of kept) {
      const v = [1, s.x, s.y];
      for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) matrix[r][c] += v[r] * v[c]; for (let c = 0; c < 4; c++) matrix[r][c + 3] += v[r] * s.color[c]; }
    }
    for (let r = 0; r < 3; r++) {
      if (Math.abs(matrix[r][r]) < 1e-6) return;
      const d = matrix[r][r]; for (let c = r; c < 7; c++) matrix[r][c] /= d;
      for (let k = 0; k < 3; k++) if (k !== r) { const f = matrix[k][r]; for (let c = r; c < 7; c++) matrix[k][c] -= f * matrix[r][c]; }
    }
    channels = Array.from({ length: 4 }, (_, c) => matrix.map(row => row[c + 3]));
    kept = samples.filter(s => s.color.every((v, c) => Math.abs(v - channels[c][0] - channels[c][1] * s.x - channels[c][2] * s.y) <= FIGURE_SPACE.backgroundNoise));
  }
  if (kept.length < 12 || kept.length < samples.length * .6 || channels.some(c => Math.abs(c[1]) / box.width > FIGURE_SPACE.adjacentDelta || Math.abs(c[2]) / box.height > FIGURE_SPACE.adjacentDelta)) return;

  // Without verified edges, keep small dark labels inside their existing ink.
  return { box, channels, bounds: !light && box.height <= 32 && box.width <= 256 ? box : undefined };
}

export type FigureSpaceContext = { obstacles: FigureBox[]; speckGuards: FigureBox[]; bounds?: (FigureBox | undefined)[]; surfaces?: (FigureBackground | undefined)[] };
export function prepareFigureSpace(width: number, height: number, measured: FigureInk[], data?: Buffer): FigureSpaceContext {
  const surfaces: (FigureBackground | undefined)[] = [];
  const bounds = data ? measured.map(ink => {
    const box = ink.box, color = background(data, width, height, box, ink.graphics);
    if (box.height > 32 || box.width > 256 || luminance(color) > 128) { surfaces.push(undefined); return; }
    const surface = figureBackgroundSurface(data, width, height, ink);
    surfaces.push(surface);
    if (surface?.backing) return surface.bounds;
    // Ordinary placement must respect ambiguous backings too. A smooth field
    // that also explains the surrounding ring can still use the open canvas.
    const reference = surface ?? { box, channels: color.map(v => [v, 0, 0]) }, ring = padded(box, 16, width, height);
    let samples = 0, matches = 0;
    for (let y = ring.top; y < ring.top + ring.height; y += 2) for (let x = ring.left; x < ring.left + ring.width; x += 2) {
      if (inside(box, x, y) || ink.graphics?.has(y * width + x) || measured.some(other => other !== ink && inside(other.box, x, y))) continue;
      samples++;
      if (surfaceMatches(reference, data.subarray((y * width + x) * 4, (y * width + x + 1) * 4), x, y)) matches++;
    }
    return samples && matches >= samples * .85 ? undefined : box;
  }) : undefined;
  return { obstacles: measured.map(m => padded(m.keepOut ?? m.box, 2, width, height)), speckGuards: measured.map(m => padded(m.keepOut ?? m.box, 4, width, height)), bounds, surfaces };
}

// Bound all per-label raster work. A label larger than the window is left intact.
export function figureSpaceWindow(anchor: FigureBox, width: number, height: number): FigureBox {
  const w = Math.min(width, FIGURE_SPACE.maxWindowWidth, anchor.width + FIGURE_SPACE.horizontalMargin * 2);
  const h = Math.min(height, FIGURE_SPACE.maxWindowHeight, anchor.height + FIGURE_SPACE.verticalMargin * 2, Math.floor(FIGURE_SPACE.maxWindowPixels / w));
  return { left: Math.max(0, Math.min(width - w, anchor.left - Math.floor((w - anchor.width) / 2))),
    top: Math.max(0, Math.min(height - h, anchor.top - Math.floor((h - anchor.height) / 2))), width: w, height: h };
}

// Recovered text can move the layout window. Keep placement inside the artwork search.
export function figurePlacementWindow(ink: FigureInk, width: number, height: number): FigureBox {
  const window = figureSpaceWindow(ink.box, width, height), searched = ink.graphicsWindow;
  if (!searched) return window;
  const left = Math.max(window.left, searched.left), top = Math.max(window.top, searched.top);
  return { left, top, width: Math.max(0, Math.min(window.left + window.width, searched.left + searched.width) - left),
    height: Math.max(0, Math.min(window.top + window.height, searched.top + searched.height) - top) };
}

// Only narrow, straight, low-contrast rules may join the background. Check
// matching background on both sides so edges of broad fills remain obstacles.
function allowFaintFigureLines(data: Buffer, width: number, height: number, nearBackground: Uint8Array, blocked: Uint8Array, color: number[]): void {
  const faint = new Uint8Array(width * height), allowed = new Uint8Array(width * height);
  for (let p = 0; p < faint.length; p++) {
    let delta = Math.abs(data[p * 4 + 3] - color[3]);
    if (color[3] > 16 || data[p * 4 + 3] > 16) for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(data[p * 4 + c] - color[c]));
    if (blocked[p]) nearBackground[p] = 0;
    faint[p] = !blocked[p] && delta <= FIGURE_SPACE.faintLineContrast ? 1 : 0;
  }
  for (const vertical of [true, false]) {
    const across = vertical ? width : height, along = vertical ? height : width;
    const at = (x: number, y: number) => vertical ? y * width + x : x * width + y;
    const thin = new Uint8Array(width * height);
    for (let y = 0; y < along; y++) for (let x = 0; x < across;) {
      if (nearBackground[at(x, y)]) { x++; continue; }
      const start = x;
      let lowContrast = true;
      while (x < across && !nearBackground[at(x, y)]) { lowContrast &&= Boolean(faint[at(x, y)]); x++; }
      // Sample beyond the immediate antialias fringe as well as checking that
      // both adjacent pixels already belong to the background tolerance.
      const before = start - 2, after = x + 1;
      if (!lowContrast || before < 0 || after >= across || x - start > FIGURE_SPACE.faintLineWidth ||
        !nearBackground[at(before, y)] || !nearBackground[at(after, y)] ||
        blocked[at(before, y)] || blocked[at(after, y)] || figurePixelDelta(data, at(before, y), at(after, y)) > FIGURE_SPACE.adjacentDelta) continue;
      for (let k = start; k < x; k++) thin[at(k, y)] = 1;
    }
    for (let x = 0; x < across; x++) for (let y = 0; y < along;) {
      const start = y;
      let run = 0, longest = 0;
      // Erased glyphs can interrupt a rule with background pixels. Continue
      // along its fixed raster coordinate, stopping at ink or label keep-outs.
      while (y < along && !blocked[at(x, y)] && (thin[at(x, y)] || nearBackground[at(x, y)])) {
        run = thin[at(x, y)] ? run + 1 : 0;
        longest = Math.max(longest, run); y++;
      }
      if (longest >= FIGURE_SPACE.faintLineLength) for (let k = start; k < y; k++) if (thin[at(x, k)]) allowed[at(x, k)] = 1;
      y++;
    }
  }
  for (let p = 0; p < allowed.length; p++) if (allowed[p]) nearBackground[p] = 1;
}

export function figureSpace(data: Buffer, width: number, height: number, index: number, measured: FigureInk[], occupied: FigureBox[] = [], context = prepareFigureSpace(width, height, measured), guard: number = FIGURE_SPACE.guard, surface?: FigureBackground): { anchor: FigureBox; erase: FigureBox; window: FigureBox; mask: Uint8Array; rectangles: FigureBox[]; seed: number; surface?: FigureBackground; eraseBounds?: FigureBox } {
  const anchor = measured[index].box, erase = figureErasureBox(anchor, width, height);
  const window = figurePlacementWindow(measured[index], width, height), w = window.width, h = window.height, count = w * h;
  const localAnchor = { ...anchor, left: anchor.left - window.left, top: anchor.top - window.top };
  if (!inside(window, anchor.left, anchor.top) || !inside(window, anchor.left + anchor.width - 1, anchor.top + anchor.height - 1)) {
    return { anchor, erase, window, mask: new Uint8Array(count), rectangles: [] as FigureBox[], seed: -1 };
  }
  const virtual = Buffer.alloc(count * 4);
  for (let y = 0; y < h; y++) data.copy(virtual, y * w * 4, ((window.top + y) * width + window.left) * 4, ((window.top + y) * width + window.left + w) * 4);
  const bounds = context.bounds?.[index] ?? surface?.bounds;
  // An uncertain backing can limit placement to the source box, but its
  // measured glyph box is no evidence of a physical edge at that pixel.
  const eraseBounds = context.surfaces?.[index]?.backing?.box ?? surface?.backing?.box;
  const removable = figureEraseMask(width, height, index, measured, window, eraseBounds, FIGURE_SPACE.guard, occupied);
  const restored = surface ? Buffer.alloc(boxArea(erase) * 4) : figureBackgroundPatch(data, width, height, erase, measured[index]);
  if (surface) for (let y = 0; y < erase.height; y++) for (let x = 0; x < erase.width; x++) restored.set(surfaceColor(surface, erase.left + x, erase.top + y), (y * erase.width + x) * 4);
  for (let y = 0; y < erase.height; y++) for (let x = 0; x < erase.width; x++) {
    const lx = erase.left + x - window.left, ly = erase.top + y - window.top;
    if (lx >= 0 && lx < w && ly >= 0 && ly < h && removable[ly * w + lx]) restored.copy(virtual, (ly * w + lx) * 4, (y * erase.width + x) * 4, (y * erase.width + x + 1) * 4);
  }
  const blocked = new Uint8Array(count);
  const obstacles = [...context.obstacles.filter((_, i) => i !== index), ...occupied.map(b => padded(b, 2, width, height))];
  for (const b of obstacles) for (let y = Math.max(0, b.top - window.top); y < Math.min(h, b.top + b.height - window.top); y++) {
    const left = Math.max(0, b.left - window.left), right = Math.min(w, b.left + b.width - window.left);
    if (left < right) blocked.fill(1, y * w + left, y * w + right);
  }
  for (const p of figureGraphicsInBox(measured[index].graphics, width, window)) blocked[(Math.floor(p / width) - window.top) * w + p % width - window.left] = 1;
  const reached = new Uint8Array(count), queue = new Int32Array(count), nearBackground = new Uint8Array(count);
  let head = 0, tail = 0, seed = -1, best = Infinity;
  const color = background(data, width, height, anchor, measured[index].graphics), ring = padded(localAnchor, 3, w, h);
  for (let p = 0; p < count; p++) {
    const q = p * 4;
    nearBackground[p] = surface ? (surfaceMatches(surface, virtual, p % w + window.left, Math.floor(p / w) + window.top, q) ? 1 : 0) : Math.abs(virtual[q + 3] - color[3]) <= FIGURE_SPACE.backgroundNoise &&
      (color[3] <= 16 && virtual[q + 3] <= 16 || Math.max(Math.abs(virtual[q] - color[0]), Math.abs(virtual[q + 1] - color[1]), Math.abs(virtual[q + 2] - color[2])) <= FIGURE_SPACE.backgroundNoise) ? 1 : 0;
  }
  allowFaintFigureLines(virtual, w, h, nearBackground, blocked, color);
  for (let y = ring.top; y < ring.top + ring.height; y++) for (let x = ring.left; x < ring.left + ring.width; x++) {
    const p = y * w + x;
    if (inside(localAnchor, x, y) || blocked[p]) continue;
    const expected = surface ? surfaceColor(surface, x + window.left, y + window.top) : color;
    let d = Math.abs(expected[3] - virtual[p * 4 + 3]);
    if (expected[3] > 16) for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(expected[c] - virtual[p * 4 + c]));
    if (d < best) { seed = p; best = d; }
  }
  const visit = (p: number, q: number) => {
    // A soft edge can connect a broad fill to the background by tiny steps.
    // Fallback surfaces require agreement with the model at every new pixel.
    if (!reached[q] && !blocked[q] && (surface ? nearBackground[q] : nearBackground[p] && nearBackground[q] || figurePixelDelta(virtual, p, q) <= FIGURE_SPACE.adjacentDelta)) { reached[q] = 1; queue[tail++] = q; }
  };
  if (seed >= 0) { reached[seed] = 1; queue[tail++] = seed; }
  while (head < tail) {
    const p = queue[head++], x = p % w;
    if (x) visit(p, p - 1); if (x + 1 < w) visit(p, p + 1);
    if (p >= w) visit(p, p - w); if (p + w < count) visit(p, p + w);
  }
  // Preserve the small isolated-texture policy, including its label keep-out.
  const checked = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    if (reached[p] || blocked[p] || checked[p]) continue;
    let size = 1; queue[0] = p; checked[p] = 1;
    let l = p % w, r = l, t = Math.floor(p / w), b = t;
    for (let k = 0; k < size; k++) {
      const q = queue[k], x = q % w, y = Math.floor(q / w);
      l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * w + nx;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !reached[next] && !blocked[next] && !checked[next]) { checked[next] = 1; queue[size++] = next; }
      }
    }
    if (l > 0 && t > 0 && r + 1 < w && b + 1 < h && size <= FIGURE_SPACE.maxSpeckPixels && r - l < FIGURE_SPACE.maxSpeckDiameter && b - t < FIGURE_SPACE.maxSpeckDiameter && Math.max(r - l + 1, b - t + 1) <= 2 * Math.min(r - l + 1, b - t + 1) && !context.speckGuards.some(g => inside(g, l + window.left, t + window.top))) for (let k = 0; k < size; k++) reached[queue[k]] = 1;
  }
  const safe = new Uint8Array(count), distance = new Uint32Array(count);
  for (let p = 0; p < count; p++) distance[p] = reached[p] ? guard + 1 : 0;
  for (let p = 0; p < count; p++) {
    const x = p % w;
    if (x) distance[p] = Math.min(distance[p], distance[p - 1] + 1);
    if (p >= w) { distance[p] = Math.min(distance[p], distance[p - w] + 1); if (x) distance[p] = Math.min(distance[p], distance[p - w - 1] + 1); if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p - w + 1] + 1); }
  }
  for (let p = count - 1; p >= 0; p--) {
    const x = p % w;
    if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p + 1] + 1);
    if (p + w < count) { distance[p] = Math.min(distance[p], distance[p + w] + 1); if (x) distance[p] = Math.min(distance[p], distance[p + w - 1] + 1); if (x + 1 < w) distance[p] = Math.min(distance[p], distance[p + w + 1] + 1); }
    safe[p] = distance[p] > guard ? 1 : 0;
  }
  const limit = bounds ? { ...bounds, left: bounds.left - window.left, top: bounds.top - window.top } : undefined;
  if (limit) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!inside(limit, x, y)) safe[y * w + x] = 0;
  let candidates = figureRectangles(safe, w, h, localAnchor);
  const centre = { left: Math.floor(localAnchor.left + localAnchor.width / 2), top: Math.floor(localAnchor.top + localAnchor.height / 2), width: 1, height: 1 };
  if (!candidates.length && guard > FIGURE_SPACE.guard) candidates = figureRectangles(safe, w, h, centre);
  // A shorter translation can use a taller central rectangle even when the
  // complete source box fits only a shallow strip. fitLabel still checks all ink.
  if (surface) candidates = [...candidates, ...figureRectangles(safe, w, h, centre)].sort((a, b) => boxArea(b) - boxArea(a));
  const rectangles = candidates.map(b => ({ ...b, left: b.left + window.left, top: b.top + window.top }));
  return { anchor, erase, window, mask: safe, rectangles, seed, surface, eraseBounds };
}

export function figureSurfaceSpace(data: Buffer, width: number, height: number, index: number, measured: FigureInk[], occupied: FigureBox[], context: FigureSpaceContext) {
  const anchor = measured[index].box, window = figureSpaceWindow(anchor, width, height);
  if (anchor.width > window.width || anchor.height > window.height) return;
  const model = context.surfaces?.[index] ?? figureBackgroundSurface(data, width, height, measured[index]);
  return model ? figureSpace(data, width, height, index, measured, occupied, context, FIGURE_SPACE.guard, model) : undefined;
}

export function* figureGraphicsInBox(graphics: ReadonlySet<number> | undefined, width: number, box: FigureBox): Iterable<number> {
  if (!graphics?.size) return;
  if (graphics.size < boxArea(box)) {
    for (const p of graphics) if (inside(box, p % width, Math.floor(p / width))) yield p;
    return;
  }
  for (let y = box.top; y < box.top + box.height; y++) for (let x = box.left; x < box.left + box.width; x++) {
    const p = y * width + x;
    if (graphics.has(p)) yield p;
  }
}

export function figureErasureBox(box: FigureBox, width: number, height: number): FigureBox {
  return padded(box, FIGURE_SPACE.glyphFringe, width, height);
}

export function figureEraseMask(width: number, height: number, index: number, measured: FigureInk[], window: FigureBox = { left: 0, top: 0, width, height }, backing?: FigureBox, protectedGuard = 2, occupied: FigureBox[] = []): Uint8Array {
  const ink = measured[index], mask = new Uint8Array(boxArea(window));
  const obstacles = [...measured.flatMap((m, j) => j === index ? [] : [m.keepOut ?? m.box]), ...occupied];
  for (const p of ink.points) for (let dy = -FIGURE_SPACE.glyphFringe; dy <= FIGURE_SPACE.glyphFringe; dy++) for (let dx = -FIGURE_SPACE.glyphFringe; dx <= FIGURE_SPACE.glyphFringe; dx++) {
    const x = p % width + dx, y = Math.floor(p / width) + dy;
    if (inside(window, x, y) && (!backing || inside(backing, x, y))) mask[(y - window.top) * window.width + x - window.left] = 1;
  }
  for (const box of obstacles) {
    const left = Math.max(box.left, window.left) - window.left;
    const right = Math.min(box.left + box.width, window.left + window.width) - window.left;
    if (left >= right) continue;
    for (let y = Math.max(box.top, window.top) - window.top; y < Math.min(box.top + box.height, window.top + window.height) - window.top; y++) {
      mask.fill(0, y * window.width + left, y * window.width + right);
    }
  }
  for (const p of ink.protectedPoints ?? []) for (let dy = -protectedGuard; dy <= protectedGuard; dy++) for (let dx = -protectedGuard; dx <= protectedGuard; dx++) {
    const x = p % width + dx, y = Math.floor(p / width) + dy;
    if (inside(window, x, y)) mask[(y - window.top) * window.width + x - window.left] = 0;
  }
  for (const p of figureGraphicsInBox(ink.graphics, width, window)) mask[(Math.floor(p / width) - window.top) * window.width + p % width - window.left] = 0;
  return mask;
}

export function figureInkIsRemovable(ink: FigureInk, width: number, mask: Uint8Array, window: FigureBox): boolean {
  const erased = (p: number) => {
    const x = p % width, y = Math.floor(p / width);
    return inside(window, x, y) && mask[(y - window.top) * window.width + x - window.left] !== 0;
  };
  return !ink.unsafe && ink.points.every(erased) && (ink.fringe?.every(erased) ?? true);
}

// A glyph-shaped mask over an uneven fill can cut the fill into strips.
// Reject long seams introduced across previously smooth neighboring pixels.
export function figureErasureBreaksBackground(data: Buffer, patch: Buffer, width: number, height: number, box: FigureBox, mask: Uint8Array): boolean {
  for (const vertical of [false, true]) {
    const along = vertical ? box.height : box.width, across = vertical ? box.width : box.height;
    const step = vertical ? 1 : width, localStep = vertical ? 1 : box.width;
    const start = vertical ? box.left : box.top, limit = vertical ? width : height;
    let seams = 0;
    for (let v = Math.max(0, 1 - start); v <= across && start + v < limit; v++) {
      let run = 0;
      for (let u = 0; u < along; u++) {
        const x = box.left + (vertical ? v : u), y = box.top + (vertical ? u : v);
        const p = y * width + x, q = (y - box.top) * box.width + x - box.left;
        const before = v > 0 && mask[q - localStep], after = v < across && mask[q];
        if (Boolean(before) === Boolean(after) || figurePixelDelta(data, p - step, p) > FIGURE_SPACE.adjacentDelta) {
          run = 0;
          continue;
        }
        const painted = before ? q - localStep : q, unchanged = before ? p : p - step;
        let delta = Math.abs(patch[painted * 4 + 3] - data[unchanged * 4 + 3]);
        if (patch[painted * 4 + 3] > 16 || data[unchanged * 4 + 3] > 16) {
          for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(patch[painted * 4 + c] - data[unchanged * 4 + c]));
        }
        run = delta >= FIGURE_SPACE.backgroundNoise ? run + 1 : 0;
        if (run >= FIGURE_GRAPHICS.seam.minLength) {
          if (++seams >= FIGURE_GRAPHICS.seam.minCount) return true;
          break;
        }
      }
    }
  }
  return false;
}

// Verify the patch at the source itself, before translated text can cover it.
export function figureErasureHasResidue(data: Buffer, patch: Buffer, width: number, height: number, erase: FigureBox, ink: FigureInk, surface?: FigureBackground): boolean {
  const ground = background(data, width, height, ink.box, ink.graphics);
  const points = [...ink.points, ...ink.fringe ?? []];
  for (const p of points) {
    const x = p % width, y = Math.floor(p / width);
    const q = ((y - erase.top) * erase.width + x - erase.left) * 4;
    const expected = surface ? surfaceColor(surface, x, y) : ground;
    let dot = 0, length = 0, residue = 0, contrast = 0;
    const alpha = expected[3] <= 16;
    for (let c = alpha ? 3 : 0; c < (alpha ? 4 : 3); c++) {
      const source = data[p * 4 + c] - expected[c], after = patch[q + c] - expected[c];
      dot += source * after; length += source * source; residue += after * after;
      contrast = Math.max(contrast, Math.abs(after));
    }
    if (contrast >= (surface ? FIGURE_SPACE.backgroundNoise + 1 : 12) && dot >= length * .32 && dot * dot >= length * residue * .9 && length >= 64) return true;
  }
  return false;
}
