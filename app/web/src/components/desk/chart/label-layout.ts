/**
 * Where each label goes, so that none is drawn over another.
 *
 * Greedy by priority: the most important label takes its first choice, and
 * every label after it takes the first of its candidate positions that does
 * not overlap anything already placed, or is left out. A trade level therefore
 * always shows, and a candle tag only where there is room -- which is the
 * order a trader reads a chart in.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type LabelRequest = { id: number; priority: number; candidates: Rect[] };

const overlaps = (a: Rect, b: Rect, pad: number) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

export function placeLabels(requests: readonly LabelRequest[], bounds: Rect, reserved: readonly Rect[] = [], pad = 2): Map<number, Rect> {
  const placed: Rect[] = [...reserved];
  const out = new Map<number, Rect>();
  const inside = (r: Rect) => r.x >= bounds.x && r.y >= bounds.y && r.x + r.w <= bounds.x + bounds.w && r.y + r.h <= bounds.y + bounds.h;
  const order = [...requests].sort((a, b) => b.priority - a.priority || a.id - b.id);
  for (const req of order) {
    const spot = req.candidates.find((c) => inside(c) && !placed.some((p) => overlaps(c, p, pad)));
    if (!spot) continue;
    placed.push(spot);
    out.set(req.id, spot);
  }
  return out;
}

/** The first choice and its neighbours up and down, for a label that may slide along its line. */
export function stacked(first: Rect, step: number, tries = 4): Rect[] {
  const out = [first];
  for (let k = 1; k <= tries; k++) {
    out.push({ ...first, y: first.y - k * step });
    out.push({ ...first, y: first.y + k * step });
  }
  return out;
}
