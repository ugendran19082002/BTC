import { rows } from '../db/pool.js';

/**
 * The derivatives history the research methods read, once a minute (owner,
 * 1 Oct 2026: "all live"). Everything here is what the desk already records --
 * `perp_snapshots` each minute (mark, index, funding, OI, book imbalance) and
 * `option_snapshots` every five minutes (per strike: IV, gamma, OI, volume) --
 * read back over the last hours. A detector needs hours, not years: the years
 * were for testing, and these began in September 2026.
 *
 * Best-effort: a table not there yet, or a failed read, is `null`, and every
 * method that needs it says nothing.
 */

export type PerpPoint = { at: number; mark: number | null; index: number | null; funding: number | null; oi: number | null; imbalance: number | null };
export type StrikePoint = { at: number; expiry: string; strike: number; cp: 'C' | 'P'; iv: number | null; gamma: number | null; oi: number | null; volume: number | null; delta: number | null };
export type IvPoint = { at: number; front: number | null; next: number | null };
export type DerivHistory = {
  /** The perpetual, each minute, oldest first. */
  perp: PerpPoint[];
  /** The option board now (`now`) and about an hour before (`before`): the two nearest expiries, every strike. */
  board: { now: StrikePoint[]; before: StrikePoint[] };
  /** At-the-money IV of the front and next expiries, each capture, oldest first. */
  iv: IvPoint[];
  /** The two nearest expiries, front first. */
  expiries: string[];
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/** Delta's expiry code DDMMYY, as a sortable YYMMDD. */
const sortable = (code: string) => `${code.slice(4, 6)}${code.slice(2, 4)}${code.slice(0, 2)}`;

/** Read at most once a minute: both tables are written every five, and every timeframe's reads share it. */
let held: { at: number; value: Promise<DerivHistory | null> } | null = null;
export function derivHistory(now = Date.now(), hours = 6): Promise<DerivHistory | null> {
  if (held && now - held.at < 60_000) return held.value;
  held = { at: now, value: readDerivHistory(now, hours) };
  return held.value;
}

async function readDerivHistory(now: number, hours: number): Promise<DerivHistory | null> {
  try {
    const since = Math.floor(now - hours * 3_600_000);
    const [perp, atm] = await Promise.all([
      rows<Record<string, unknown>>(
        `SELECT at, mark, spot, funding_rate, oi_contracts, imbalance FROM perp_snapshots WHERE at >= $1 AND at <= $2 ORDER BY at`, [since, Math.floor(now)],
      ),
      // Each capture's at-the-money IV per expiry (the strike nearest the index then) -- which also lists the captures.
      rows<Record<string, unknown>>(
        `SELECT DISTINCT ON (at, expiry) at, expiry, mark_iv FROM option_snapshots
          WHERE at >= $1 AND at <= $2 AND mark_iv IS NOT NULL AND spot IS NOT NULL
          ORDER BY at, expiry, abs(strike - spot)`, [since, Math.floor(now)],
      ),
    ]);
    const caps = [...new Set(atm.map((r) => Number(r.at)))].sort((x, y) => x - y);
    const atNow = caps.length ? caps[caps.length - 1]! : null;
    const atBefore = atNow === null ? null : [...caps].reverse().find((t) => t <= atNow - 55 * 60_000) ?? null;
    const strikesAt = async (at: number | null) => (at === null ? [] : (await rows<Record<string, unknown>>(
      `SELECT at, expiry, strike, cp, mark_iv, gamma, oi, volume, delta FROM option_snapshots WHERE at = $1`, [at],
    )).map<StrikePoint>((r) => ({
      at: Number(r.at), expiry: String(r.expiry), strike: Number(r.strike), cp: r.cp === 'P' ? 'P' : 'C',
      iv: num(r.mark_iv), gamma: num(r.gamma), oi: num(r.oi), volume: num(r.volume), delta: num(r.delta),
    })));
    const [boardNow, boardBefore] = await Promise.all([strikesAt(atNow), strikesAt(atBefore)]);
    const expiries = [...new Set(boardNow.map((s) => s.expiry))].sort((x, y) => sortable(x).localeCompare(sortable(y))).slice(0, 2);
    const byAt = new Map<number, IvPoint>();
    for (const r of atm) {
      const at = Number(r.at), e = String(r.expiry);
      const p = byAt.get(at) ?? { at, front: null, next: null };
      if (e === expiries[0]) p.front = num(r.mark_iv);
      else if (e === expiries[1]) p.next = num(r.mark_iv);
      byAt.set(at, p);
    }
    return {
      perp: perp.map((r) => ({ at: Number(r.at), mark: num(r.mark), index: num(r.spot), funding: num(r.funding_rate), oi: num(r.oi_contracts), imbalance: num(r.imbalance) })),
      board: { now: boardNow, before: boardBefore },
      iv: [...byAt.values()].sort((a, b) => a.at - b.at),
      expiries,
    };
  } catch {
    return null;
  }
}

/** For tests: forget the held read. */
export const resetDerivHistory = () => { held = null; };

