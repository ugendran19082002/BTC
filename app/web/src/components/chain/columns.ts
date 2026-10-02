/**
 * The board's columns, as data.
 *
 * They were two presets — "key" and "all" — and a `perSide` number written by
 * hand to match whichever was showing. The count and the cells were two
 * statements of the same fact, and when they disagreed the table reserved width
 * for columns that were not there and pushed the calls bid off the left edge of
 * a phone. Deriving the count from this list makes that impossible.
 *
 * The order here is the calls side, read outward to inward. The puts side is
 * this reversed, which is how an option board is laid out everywhere.
 */
export const CHAIN_COLUMNS = [
  { key: 'oi', short: 'OI', label: 'Open interest', why: 'Contracts open at this strike.' },
  { key: 'volume', short: 'Vol', label: 'Traded today', why: 'Contracts that changed hands.' },
  { key: 'oiChange', short: 'ΔOI', label: 'Open interest, change', why: 'Against about an hour ago. Blank until the desk has been up long enough to have something to compare against.' },
  { key: 'volumeToOi', short: 'V/OI', label: 'Traded ÷ open', why: 'How busy the strike is against what is open on it — how easily you get back out.' },
  { key: 'delta', short: 'Δ', label: 'Delta', why: 'How much the premium moves per dollar of BTC.' },
  { key: 'iv', short: 'IV', label: 'Implied volatility', why: 'What this strike is priced at, against the money.' },
  { key: 'otm', short: 'OTM', label: 'Distance from price', why: 'How far the strike sits from spot, as a percentage.' },
  { key: 'emBuffer', short: 'EM×', label: 'Expected moves away', why: 'How far the strike is in expected moves. 1.0 means today’s expected move reaches it exactly — the same statement on a quiet day and a violent one, which “$1,400 away” is not.' },
  { key: 'breakeven', short: 'B/E', label: 'Break even', why: 'Where the short stops making money.' },
  { key: 'score', short: 'Score', label: 'Score', why: 'How this strike ranks against the rest of this board, 0–100.' },
  { key: 'signal', short: 'Signal', label: 'Signal', why: 'Strong, candidate, watch or avoid. Tap one for every rule it passes or fails.' },
  { key: 'ev', short: 'EV', label: 'Expected value', why: 'The credit less the average payout, after charges.' },
  { key: 'zero', short: '→ 0', label: 'Chance it expires worthless', why: 'The maths, corrected by 733 days of real settlements.' },
  { key: 'model', short: 'Model', label: 'The maths alone', why: 'N(d2), before the history correction.' },
  { key: 'touch', short: 'Touch', label: 'Chance it touches the strike', why: 'Whether BTC reaches this strike at any point before settlement — not whether it finishes there. A strike can be 97% to expire worthless and still be touched one day in four: that is the drawdown you have to sit through, not a loss.' },
  { key: 'nearZero', short: '≈0', label: 'Chance the premium collapses', why: 'Whether this option’s own price falls to about ten cents before settlement — the target filling. Simulated, and only for strikes worth simulating: out of the money and still worth something.' },
  { key: 'ask', short: 'Ask', label: 'Ask', why: 'What it costs to buy.' },
  { key: 'mark', short: 'Mark', label: 'Mark', why: 'The exchange’s own price. Not what you get.' },
  { key: 'bid', short: 'Bid', label: 'Bid', why: 'What you receive when you sell.' },
] as const;

export type ColumnKey = (typeof CHAIN_COLUMNS)[number]['key'];

export type ColumnState = Record<ColumnKey, boolean>;

/**
 * What a board opens on: the eight a decision is actually read from.
 *
 * Everything else is reference — worth having, not worth 27 columns of
 * sideways scrolling before you have decided anything.
 *
 * ΔOI is in the opening set even though it reads as a dash for the first few
 * minutes after a deploy. It is the only column on the board that says whether
 * positions are being *taken* rather than what they are worth, and a column
 * nobody can find is a column nobody uses — the dash is explained in the
 * picker and on the heading.
 */
export const DEFAULT_COLUMNS: ColumnState = {
  oi: false,
  volume: false,
  oiChange: true,
  volumeToOi: false,
  delta: false,
  iv: false,
  otm: false,
  emBuffer: true,
  breakeven: false,
  score: true,
  signal: true,
  ev: true,
  zero: true,
  model: true,
  // Touch is on by default: it is the one number that says what the trade
  // feels like on the way, and every other probability on the board is about
  // where it ends. Near-zero is off -- it is null for most strikes, and a
  // column of dots earns nothing.
  touch: true,
  nearZero: false,
  ask: true,
  mark: false,
  bid: true,
};

/** The bid is what a seller receives, so a board without it cannot be acted on. */
export const REQUIRED_COLUMNS: readonly ColumnKey[] = ['bid'];

/** A stored choice from an older build may not name every column this one has. */
export function normalise(stored: Partial<ColumnState> | null | undefined): ColumnState {
  const out = { ...DEFAULT_COLUMNS };
  for (const c of CHAIN_COLUMNS) {
    const v = stored?.[c.key];
    if (typeof v === 'boolean') out[c.key] = v;
  }
  for (const k of REQUIRED_COLUMNS) out[k] = true;
  return out;
}

export const shownCount = (state: ColumnState): number =>
  CHAIN_COLUMNS.reduce((n, c) => n + (state[c.key] ? 1 : 0), 0);

// ------------------------------------------------------------------- order

export type ColumnOrder = readonly ColumnKey[];

/** The order this file declares: the one the board was designed around. */
export const DEFAULT_ORDER: ColumnKey[] = CHAIN_COLUMNS.map((c) => c.key);

/**
 * A stored order, made safe to draw from.
 *
 * Anything that is not a column of this build is dropped, anything named twice
 * is kept once, and any column the stored order never heard of is appended in
 * its default place. That last rule is the one that matters: a column added
 * after somebody saved their arrangement must still appear, or the release
 * that introduces it makes it invisible to everyone who had ever touched this
 * panel.
 */
export function normaliseOrder(stored: unknown): ColumnKey[] {
  const known = new Set<string>(DEFAULT_ORDER);
  const out: ColumnKey[] = [];
  if (Array.isArray(stored)) {
    for (const k of stored) {
      if (typeof k === 'string' && known.has(k) && !out.includes(k as ColumnKey)) out.push(k as ColumnKey);
    }
  }
  // Whatever the stored order did not mention, in the order this file declares.
  for (const k of DEFAULT_ORDER) if (!out.includes(k)) out.push(k);
  return out;
}

/**
 * `key` moved to sit at index `to`, the rest closing up behind it.
 *
 * Pure, and the single place a reorder happens: the drag, the keyboard and the
 * arrow buttons all end here, so they cannot disagree about what "move it up"
 * means. An index outside the list clamps rather than throwing — a drop past
 * the last row means "put it last", which is what it looks like.
 */
export function moveColumn(order: ColumnOrder, key: ColumnKey, to: number): ColumnKey[] {
  const from = order.indexOf(key);
  if (from === -1) return [...order];
  const rest = order.filter((k) => k !== key);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** The columns as data, in the order they are to be drawn. */
export function columnsInOrder(order: ColumnOrder = DEFAULT_ORDER): typeof CHAIN_COLUMNS[number][] {
  const by = new Map(CHAIN_COLUMNS.map((c) => [c.key, c] as const));
  return normaliseOrder([...order]).map((k) => by.get(k)!);
}
