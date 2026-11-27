import type { FigureBox } from "./figure-space.server";

export function figurePixelDelta(data: Buffer, a: number, b: number): number {
  let delta = Math.abs(data[a * 4 + 3] - data[b * 4 + 3]);
  if (data[a * 4 + 3] > 16 || data[b * 4 + 3] > 16) {
    for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(data[a * 4 + c] - data[b * 4 + c]));
  }
  return delta;
}

type Slice = { along: number; low: number; high: number; center: number; peak: number };
const shoulder = 5;

function followsPath(slices: Slice[], start: number, end: number, bends: number): boolean {
  const a = slices[start], b = slices[end], slope = (b.center - a.center) / Math.max(1, b.along - a.along);
  let worst = 2.25, split = -1;
  for (let i = start + 1; i < end; i++) {
    const error = Math.abs(slices[i].center - a.center - slope * (slices[i].along - a.along));
    if (error > worst) { worst = error; split = i; }
  }
  return split < 0 || bends > 0 && split - start >= 6 && end - split >= 6 &&
    followsPath(slices, start, split, bends - 1) && followsPath(slices, split, end, bends - 1);
}

// Test a thin ridge perpendicular to the trace, against the ground on both sides.
function ridge(data: Buffer, p: number, step: number): number {
  const a = p - step, b = p + step;
  let contrast = 0;
  for (let c = data[p + 3] <= 16 ? 3 : 0; c < 4; c++) {
    const left = data[p + c] - data[a + c], right = data[p + c] - data[b + c];
    const distance = Math.abs(left - right);
    if (distance > 24) return 0;
    if (left * right > 0 && distance <= 20) contrast = Math.max(contrast, Math.min(Math.abs(left), Math.abs(right)));
  }
  return contrast;
}

export function findFigureGraphics(data: Buffer, width: number, window: FigureBox, characterHeight: number, boxes: FigureBox[], graphics: Set<number>): void {
  const minLength = Math.max(18, Math.min(36, Math.ceil(characterHeight * 1.25)));
  const extension = Math.max(5, Math.min(12, Math.ceil(characterHeight * .4)));
  const relevant = boxes.filter(b => b.left < window.left + window.width && b.left + b.width > window.left &&
    b.top < window.top + window.height && b.top + b.height > window.top);
  for (const transpose of [false, true]) {
    const along = transpose ? window.height : window.width, across = transpose ? window.width : window.height;
    const step = transpose ? 1 : width;
    const at = (u: number, v: number) => (window.top + (transpose ? u : v)) * width + window.left + (transpose ? v : u);
    const tracks: Slice[][] = [], starts: Slice[][][] = Array.from({ length: along }, () => []);
    let previous: (Slice[] | undefined)[] = [];
    for (let u = 0; u < along; u++) {
      const current: (Slice[] | undefined)[] = [];
      for (let v = shoulder; v < across - shoulder;) {
        const low = v;
        let peak = at(u, v), strongest = 0;
        while (v < across - shoulder) {
          const p = at(u, v), contrast = ridge(data, p * 4, step * shoulder * 4);
          if (contrast < 8) break;
          if (contrast > strongest) { strongest = contrast; peak = p; }
          v++;
        }
        if (v === low) { v++; continue; }
        if (v - low > 6) continue;
        const high = v - 1;
        let start = low, end = high;
        const tolerance = Math.max(3, Math.min(24, strongest / 2));
        while (start > 0 && low - start < 7 && figurePixelDelta(data, at(u, start - 1), peak) <= tolerance) start--;
        while (end + 1 < across && end - high < 7 && figurePixelDelta(data, at(u, end + 1), peak) <= tolerance) end++;
        if (end - start + 1 > 6) continue;
        const center = (low + high) / 2, key = Math.round(center);
        const slice = { along: u, low, high, center, peak };
        let track: Slice[] | undefined;
        for (const offset of [0, -1, 1, -2, 2]) {
          const candidate = previous[key + offset], last = candidate?.at(-1);
          if (last && last.along === u - 1 && Math.abs(last.high - last.low - (high - low)) <= 2 &&
              figurePixelDelta(data, last.peak, peak) <= 44) { track = candidate; break; }
        }
        if (!track) { track = []; tracks.push(track); starts[u].push(track); }
        track.push(slice); current[key] = track;
      }
      previous = current;
    }
    const used = new Set<Slice[]>();
    for (const track of tracks) {
      if (used.has(track)) continue;
      const chain = [track], first = track[0];
      // Continue interrupted strokes and regularly spaced dashes or dots.
      while (chain.length < 48) {
        const tail = chain.at(-1)!, last = tail.at(-1)!;
        const before = tail[Math.max(0, tail.length - 8)];
        const slope = (last.center - before.center) / Math.max(1, last.along - before.along);
        let next: Slice[] | undefined;
        for (let gap = 2; gap <= 16 && !next && last.along + gap < along; gap++) {
          next = starts[last.along + gap].find(candidate => {
            const head = candidate[0], prior = chain.at(-2);
            const comparable = tail.length >= minLength / 2 && candidate.length >= minLength / 2 ||
              Math.abs(candidate.length - tail.length) <= Math.max(2, Math.min(candidate.length, tail.length) * .45);
            const direction = tail.length <= 4 && candidate.length <= 4 ? gap + 1 : 2.5;
            return !used.has(candidate) && comparable && figurePixelDelta(data, head.peak, last.peak) <= 36 &&
              Math.abs(head.center - last.center - slope * gap) <= direction &&
              (!prior || Math.abs(gap - (tail[0].along - prior.at(-1)!.along)) <= 3);
          });
        }
        if (!next) break;
        chain.push(next);
      }
      const slices = chain.flat(), last = slices.at(-1)!;
      if (last.along - first.along + 1 < minLength || !followsPath(slices, 0, slices.length - 1, chain.length === 1 ? 2 : 1)) continue;
      const solid = chain.some(segment => segment.length >= minLength);
      if (!solid && chain.length < 3 && !chain.every(segment => segment.length >= minLength / 2)) continue;
      if (!solid && chain.length >= 3) {
        // Repeated crossbars of letters can look like a dashed path. Their
        // side stems leave similarly colored ink off both ends of each dash.
        const sideStem = (slice: Slice, color: number) => {
          const v = Math.round(slice.center);
          for (let du = -3; du <= 3; du++) {
            const u = slice.along + du;
            if (u < 0 || u >= along || v < 7 || v + 7 >= across) continue;
            for (const dv of [-6, 6]) if (figurePixelDelta(data, at(u, v + dv), color) <= 16 &&
              figurePixelDelta(data, at(u, v + dv + Math.sign(dv)), color) <= 16) return true;
          }
          return false;
        };
        if (chain.filter(segment => {
          const color = segment[Math.floor(segment.length / 2)].peak;
          return sideStem(segment[0], color) && sideStem(segment.at(-1)!, color);
        }).length * 3 >= chain.length) continue;
      }
      // A rule needs evidence beyond the lettering. This keeps short bars
      // within an OCR label (including fractions and underlines) with the text.
      const exterior = slices.filter(slice => {
        const p = at(slice.along, Math.round(slice.center)), x = p % width, y = Math.floor(p / width);
        return !relevant.some(b => x >= b.left - 2 && x < b.left + b.width + 2 && y >= b.top - 2 && y < b.top + b.height + 2);
      });
      if (exterior.length < extension) continue;
      for (const segment of chain) used.add(segment);
      for (const slice of slices) {
        for (let v = slice.low - 1; v <= slice.high + 1; v++) {
          const p = at(slice.along, v);
          if (v >= slice.low && v <= slice.high || ridge(data, p * 4, step * shoulder * 4) >= 1) graphics.add(p);
        }
      }
      // Bridge an interruption only where the original raster still carries
      // ink. A join that crosses a glyph will then make that glyph unsafe.
      for (let i = 1; i < slices.length; i++) {
        const a = slices[i - 1], b = slices[i], gap = b.along - a.along;
        if (gap <= 1 || !solid && chain.length >= 3) continue;
        for (let u = a.along + 1; u < b.along; u++) {
          const f = (u - a.along) / gap;
          const low = Math.floor(a.low * (1 - f) + b.low * f), high = Math.ceil(a.high * (1 - f) + b.high * f);
          for (let v = low; v <= high; v++) {
            const p = at(u, v);
            if (figurePixelDelta(data, p, a.peak) <= 44 || figurePixelDelta(data, p, b.peak) <= 44) graphics.add(p);
          }
        }
      }
    }
  }
}
