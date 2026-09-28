/**
 * The vocabulary of the price-action / SMC engine (lib/smc/engine.ts).
 *
 * Every object carries two bar indices:
 *
 * - `at`    -- where it is drawn: the candle the concept belongs to.
 * - `known` -- the candle whose *close* made it knowable. A swing high at bar
 *              40 with a two-bar confirmation is `at: 40, known: 42`.
 *
 * Nothing is ever edited after the fact. A zone that is later touched, filled
 * or broken gets a status *event* with its own `known`, so the chart at any
 * past candle shows exactly what the engine knew then. That is the whole
 * no-lookahead contract, and `engine.test.ts` checks it by replaying every
 * prefix of the data.
 */

export type Dir = 'bull' | 'bear';

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** A confirmed fractal swing, labelled against the previous confirmed swing of the same side. */
export type Swing = {
  id: string;
  side: 'high' | 'low';
  at: number;
  known: number;
  price: number;
  /** HH / LH / EQH for highs, HL / LL / EQL for lows; null for the first one. */
  label: 'HH' | 'LH' | 'EQH' | 'HL' | 'LL' | 'EQL' | null;
};

/** A close through the last unbroken swing: BOS with the trend, CHoCH against it. */
export type StructureBreak = {
  id: string;
  dir: Dir;
  kind: 'BOS' | 'CHoCH';
  /** CHoCH made by a displacement candle: the market structure shift. */
  mss: boolean;
  level: number;
  /** The swing that was broken. */
  from: number;
  at: number;
  known: number;
};

export type ZoneKind = 'OB' | 'FVG';

/**
 * An order block or fair value gap.
 *
 * The fields below are fixed at creation. What happened to the zone later is
 * in `ZoneEvent`s, never written back here.
 */
export type Zone = {
  id: string;
  kind: ZoneKind;
  dir: Dir;
  low: number;
  high: number;
  at: number;
  known: number;
  /** The break or displacement that created it. */
  source: string;
};

export type ZoneEvent = {
  zone: string;
  /** touched: first retest. filled: price closed the far edge. broken: closed through -- an OB becomes a breaker, an FVG an IFVG. */
  type: 'touched' | 'filled' | 'broken';
  at: number;
  known: number;
};

/** Resting liquidity: a confirmed swing nobody has traded through yet, or a reference level. */
export type Pool = {
  id: string;
  side: 'buy' | 'sell';
  /** BSL/SSL = a single swing; EQH/EQL = two swings within tolerance; the rest are reference levels. */
  kind: 'BSL' | 'SSL' | 'EQH' | 'EQL' | 'PDH' | 'PDL' | 'PWH' | 'PWL' | 'PMH' | 'PML' | 'ASH' | 'ASL' | 'LSH' | 'LSL';
  price: number;
  at: number;
  known: number;
};

export type PoolEvent = {
  pool: string;
  /** swept: wick through and closed back (a liquidity grab); taken: closed through; merged: folded into an EQH/EQL pool. */
  type: 'swept' | 'taken' | 'merged';
  at: number;
  known: number;
  /** The session the candle belonged to, for "London sweep" and the like. */
  session: Session | null;
};

export type Session = 'Asia' | 'London' | 'New York';

export type SessionRange = { session: Session; day: number; from: number; to: number; high: number; low: number; known: number };

export type CandleTag = {
  at: number;
  known: number;
  name: 'Bull engulfing' | 'Bear engulfing' | 'Pin bar' | 'Inside bar' | 'Doji' | 'Displacement' | 'Volume spike' | 'Volume dry-up';
  dir: Dir | null;
};

export type TargetSource = 'liquidity' | 'swing' | 'level' | 'R-multiple';

export type Target = { price: number; label: string; source: TargetSource; rr: number };

export type SetupState =
  | 'FORMING'      // liquidity swept, waiting for the structure shift
  | 'READY'        // shift confirmed and a POI chosen, waiting for the retest
  | 'ACTIVE'       // filled at the POI
  | 'TP1' | 'TP2'  // partial targets reached, still running (stop at break-even after TP1)
  | 'TP3'          // final: every target reached
  | 'STOPPED'      // final: stop before any target
  | 'BREAKEVEN'    // final: stopped at entry after TP1
  | 'INVALIDATED'  // final: closed through the stop before filling, or superseded
  | 'EXPIRED';     // final: ran away without filling, or too long in the trade

export type Confirmation = { name: string; ok: boolean; at: number | null };

export type SetupEvent = { state: SetupState; at: number; known: number; price: number | null; note: string };

/**
 * One setup, from the sweep that started it to the candle that ended it.
 *
 * The plan (entry, stop, targets) is fixed the moment the setup turns READY and
 * never moved afterwards -- only the stop's move to break-even after TP1 is an
 * event, and it is recorded as one.
 */
export type Setup = {
  id: string;
  dir: Dir;
  createdAt: number;
  state: SetupState;
  confirmations: Confirmation[];
  poi: Zone | null;
  entry: number | null;
  stop: number | null;
  targets: Target[];
  /** Risk in price points, fixed at READY. */
  risk: number | null;
  /** The higher timeframe's trend at the time the plan was made, when one was given. */
  htf: Dir | null;
  events: SetupEvent[];
  /** Filled in once the trade is open: best and worst excursion, in R. */
  mfeR: number | null;
  maeR: number | null;
  /** Final result in R: +rr of the last target reached, -1 for a stop, 0 at break-even. */
  resultR: number | null;
  closedAt: number | null;
};

export type DealingRange = {
  high: number; low: number; highAt: number; lowAt: number;
  equilibrium: number;
  /** Optimal trade entry, 62-79% back into the range in the direction of the trend. */
  ote: { low: number; high: number } | null;
  /** Where the last close sits: 0 = range low, 1 = range high. */
  position: number;
};

export type SmcOptions = {
  /** Seconds per bar, for session and day boundaries. */
  tfSec: number;
  /** Fractal size. Two bars each side is the usual intraday choice. */
  pivotLeft?: number;
  pivotRight?: number;
  /** The higher timeframe's trend as it was known at a unix time; used to score setups, never to change the past. */
  htfTrendAt?: (unixSec: number) => Dir | null;
};

export type SmcState = {
  bars: number;
  atr: number;
  trend: Dir | null;
  swings: Swing[];
  breaks: StructureBreak[];
  zones: Zone[];
  zoneEvents: ZoneEvent[];
  pools: Pool[];
  poolEvents: PoolEvent[];
  sessions: SessionRange[];
  tags: CandleTag[];
  /** Session VWAP (UTC day), one value per bar, null before the first bar of a day has volume. */
  vwap: (number | null)[];
  /** The UTC day's opening price, per bar. */
  dayOpen: (number | null)[];
  setups: Setup[];
  range: DealingRange | null;
};
