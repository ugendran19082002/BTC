/** The shapes the strategy API returns. Mirrors app/server/src/strategy/types.ts. */

export type PremiumMode = 'atLeast' | 'atMost';
export type LegConfig = 'CE' | 'PE' | 'both';

/**
 * A premium rule, whole (server: PremiumRule). `minOtm` is a condition on
 * distance, counted like a by-strike rule: the premium's own pick stands at
 * OTM n or further out. Else -- nearer than that, or no pick -- the strike
 * `elseOtm` names is sold, which may be the same strike or a different one;
 * absent, it reads as `minOtm`. `minOtm` null or absent: no condition.
 */
export type PremiumRule = {
  mode: PremiumMode; usd: number; fallbackUsd?: number | null;
  minOtm?: number | null; elseOtm?: number | null;
};

/** The strike a premium rule's else sells; null when there is no condition (server: elseOtmOf). */
export const elseOtmOf = (p: Pick<PremiumRule, 'minOtm' | 'elseOtm'>): number | null =>
  (p.minOtm === null || p.minOtm === undefined ? null : (p.elseOtm ?? p.minOtm));

/** The two ways a premium reads, as the form names them: the sign first, since the two are opposites. */
export const PREMIUM_MODE_LABEL: Record<PremiumMode, string> = { atLeast: '≥ Greater or equal', atMost: '≤ Less or equal' };

/** What "at least OTM" starts at when it is switched on. */
export const DEFAULT_MIN_OTM = 6;
export type EntryPrice = 'now' | 'offer' | 'set';

/** How the strike is chosen: by what it pays, or by where it sits. */
export type StrikeRule =
  | 'premium'
  | 'strict'
  /**
   * At the open-interest wall — the heaviest put strike for a PE, the heaviest
   * call strike for a CE, out of the money only.
   *
   * Differently untested from the other two: the premium rule carries a
   * 733-day record, `strict` carries none but is only a way of naming a strike
   * a person already chose, and this one is a claim — that the heaviest strike
   * is a better one to sell. Open interest is the thing `feature_screen.py`
   * tested as a trading rule and rejected. The form says so.
   */
  | 'oiWall'
  /** By delta (8 Oct 2026): the strike nearest the money whose delta is at or under a number. */
  | 'delta'
  /** By distance (8 Oct 2026): the strike nearest the money at least this far from BTC. */
  | 'distance';

/** A delta rule: the delta, as a size, a strike must be at or under (server: DeltaRule). */
export type DeltaRule = { max: number };
export const MIN_DELTA = 0.01;
export const MAX_DELTA = 0.5;
export const DEFAULT_DELTA: DeltaRule = { max: 0.1 };
/** The quick picks beside the number. */
export const DELTA_PRESETS = [0.05, 0.07, 0.1, 0.15] as const;

/**
 * A distance rule (server: DistanceRule): `pct` percent of BTC all day (`fixed`), or `pct` times the square
 * root of the hours left to the settlement (`time`) -- 0.45 is 2.0% with 20 hours left and 0.6% with 2.
 */
export type DistanceScale = 'fixed' | 'time';
export type DistanceRule = { pct: number; scale: DistanceScale };
export const MAX_DISTANCE_PCT = 20;
export const DEFAULT_DISTANCE: DistanceRule = { pct: 0.45, scale: 'time' };
/** What a rule switched to the other reading starts at: a fixed 1.5% is about what 0.45 asks for with 11 hours left. */
export const DEFAULT_FIXED_DISTANCE_PCT = 1.5;

/** How far from BTC a distance rule asks for with this long left, in percent; null when it needs the time and has none (server: distanceNeeded). */
export function distanceNeeded(d: DistanceRule, hoursToExpiry: number | null | undefined): number | null {
  if (d.scale !== 'time') return d.pct;
  if (hoursToExpiry === null || hoursToExpiry === undefined || !Number.isFinite(hoursToExpiry) || hoursToExpiry < 0) return null;
  return d.pct * Math.sqrt(hoursToExpiry);
}

/** What is wrong with a delta rule -- the server's `deltaProblem`, in its words. */
export function deltaProblem(d: DeltaRule | null | undefined): string | null {
  const max = d?.max;
  return typeof max === 'number' && max >= MIN_DELTA && max <= MAX_DELTA
    ? null
    : `Delta must be between ${MIN_DELTA.toFixed(2)} and ${MAX_DELTA.toFixed(2)}.`;
}

/** What is wrong with a distance rule -- the server's `distanceProblem`, in its words. */
export function distanceProblem(d: DistanceRule | null | undefined): string | null {
  if (!d || typeof d.pct !== 'number' || !(d.pct > 0) || d.pct > MAX_DISTANCE_PCT) {
    return `The distance from BTC must be above 0% and at most ${MAX_DISTANCE_PCT}%.`;
  }
  return d.scale === 'fixed' || d.scale === 'time' ? null : 'The distance must be a fixed percentage, or one that shrinks with the time left.';
}

/** How far from the money a strict rule may reach, either way. */
export const MAX_STRIKE_STEP = 20;

/** 0 -> "ATM", 2 -> "OTM 2", -1 -> "ITM 1". */
export function strikeLabel(step: number): string {
  if (!Number.isFinite(step) || step === 0) return 'ATM';
  return step > 0 ? `OTM ${step}` : `ITM ${-step}`;
}

/** From `at` (IST "HH:MM"), strikes are picked by this rule until the next block. Mirrors the server's StrikeBlock. */
export type StrikeBlock = {
  at: string;
  strikeRule: 'premium' | 'strict' | 'delta' | 'distance';
  strikeStep: number;
  premium: PremiumRule;
  delta?: DeltaRule | null;
  distance?: DistanceRule | null;
};

/** A block for every hour of a contract (server: MAX_STRIKE_BLOCKS). */
export const MAX_STRIKE_BLOCKS = 24;

/**
 * An exit read as a share (0.8 = 80%), as points from the entry, or as the
 * price itself -- the level, whatever the entry; its balance (level minus
 * entry) is re-measured from the entry that happens.
 */
export type MonitorOn = 'ltp' | 'close';

export type ExitMode = 'pct' | 'points' | 'price';

/** From `at` (IST "HH:MM"), the exit becomes `value`, in its rule's units. Zero turns it off. */
export type ExitStep = { at: string; value: number };

export type StrategyConfig = {
  /** IST, 24-hour "HH:MM". Shown as 12-hour with AM or PM. */
  entryTime: string;
  /** IST, 24-hour "HH:MM", later than entry and before the 17:30 settlement for a daytime entry. */
  exitTime: string;
  /** How the strike is chosen. Strategies saved before this read as 'premium'. */
  strikeRule: StrikeRule;
  /**
   * Which strike, counted from the money, when `strikeRule` is 'strict'.
   * 0 = ATM, +n = OTM n, -n = ITM n, over the strikes actually listed.
   */
  strikeStep: number;
  /**
   * `fallbackUsd`: tried only when `usd` finds no strike -- "at most $20, else
   * the last strike at or under $50". Above `usd` for at-most, below it for
   * at-least. Null or absent is no fallback.
   */
  premium: PremiumRule;
  /** The delta a strike must be at or under, when `strikeRule` is 'delta'. Absent on a strategy that never used it. */
  delta?: DeltaRule | null;
  /** How far from BTC a strike must sit, when `strikeRule` is 'distance'. Absent on a strategy that never used it. */
  distance?: DistanceRule | null;
  /**
   * A signal strategy's strike rule over its window: from each block's time the
   * strike is picked by that block's rule, until the next. Before the first
   * block the rule above is in force. Absent or empty: one rule all window.
   */
  strikeBlocks?: StrikeBlock[];
  /** This strategy's own premium floor, in dollars. Null or absent: the desk's $5. */
  minPremiumUsd?: number | null;
  entryPrice: EntryPrice;
  entryLimit: number | null;
  /** Seconds to wait at the offer before crossing. Zero rests until filled. */
  crossAfterSec: number;
  /** Sell at the bid only while the spread is at most this (0.15 = 15%). Older strategies may lack it. */
  maxCrossSpreadPct?: number;
  takeProfitPct: number;
  /** Above 1 is allowed: a short option can multiply. 2000% is the typo guard. */
  stopLossPct: number;
  /** How the target is read: a share of the credit, or points under the entry. Absent is 'pct'. */
  targetMode?: ExitMode;
  /** Target as points under the entry price. Absent is 0. */
  takeProfitPoints?: number;
  /** Target as the price itself, in `price` mode. Absent is 0. */
  takeProfitAt?: number;
  /** From each step's time, the target becomes its value, in `targetMode` units. */
  targetSteps?: ExitStep[];
  /** How the stop is read: a share of the entry, or points over it. Absent is 'pct'. */
  stopMode?: ExitMode;
  /**
   * What the stop and the target are watched on: the touch, or the bar's close.
   *
   * `ltp` fires the moment the mark reaches the level, which is what a resting
   * stop at the exchange does. `close` waits for the bar to finish -- a wick
   * through a level is not a break, and a thin option's mark can print a price
   * nothing traded at. The difference is real money both ways, so it is the
   * operator's choice per strategy.
   */
  monitorOn?: MonitorOn;
  /** Stop as points over the entry price. Absent is 0. */
  stopLossPoints?: number;
  /** Stop as the price itself, in `price` mode: 70 is 70, whatever the entry. Absent is 0. */
  stopLossAt?: number;
  /** From each step's time, the stop becomes its value, in `stopMode` units. */
  stopSteps?: ExitStep[];
  lots: number;
  legs: LegConfig;
  /** null means the gate is off. */
  /**
   * How late an entry may still be taken, in minutes after its time.
   *
   * A desk that was down at 05:30 and comes up at 05:34 should still trade; one
   * that comes up at 09:00 should not. How long "still fine" lasts belongs to
   * the strategy: an hour into a twelve-hour contract is nothing, ten minutes
   * into a signal is everything. Absent on strategies saved before this
   * existed, which read as 60.
   */
  graceMin: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /**
   * What starts an entry: the clock (`entryTime`, once a day), or a signal from
   * the desk's entry methods. Absent: the clock. A signal strategy sells one leg
   * per signal -- BUY sells the put, SELL the call -- so `legs` is not read, and
   * `entryTime` to `exitTime` is the window it takes signals in.
   */
  trigger?: 'time' | 'signal';
  /** Which signals a signal strategy takes. */
  signal?: SignalRule;
  /** Real orders only with this on. Off (the default): it writes down what it would have sold. */
  liveOrders?: boolean;
  /**
   * A signal strategy's no-entry windows (9 Oct 2026): inside one no new entry is taken -- the signal is written
   * down as skipped -- and nothing already open is closed: it keeps its SL, TGT and exit time. The times are kept
   * while switched off. Absent or null: no window. Mirrors the server's `NoEntry`.
   */
  noEntry?: NoEntry | null;
};

/** From `from` (in the window) up to `to` (not in it), IST "HH:MM"; it may run past midnight. */
export type NoEntryWindow = { from: string; to: string };
export type NoEntry = { on: boolean; windows: NoEntryWindow[] };
/** The server's `MAX_NO_ENTRY_WINDOWS`. */
export const MAX_NO_ENTRY_WINDOWS = 6;

/** Mirrors the server's SignalRule (app/server/src/strategy/types.ts). */
export type SignalTf = '3m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h';
export const SIGNAL_TFS: readonly SignalTf[] = ['3m', '5m', '15m', '30m', '1h', '2h', '4h'];
/** "At most open at once" is typed, 1 to this (server: MAX_SIGNAL_OPEN). */
export const MAX_SIGNAL_OPEN = 100;
/** The most the desk-wide cap may be set to; 0 takes it off (server: MAX_GLOBAL_OPEN). */
export const MAX_GLOBAL_OPEN = 500;
/** The quick picks beside it. */
export const MAX_OPEN_PRESETS = [1, 5, 10, 25, 50, 75, 100] as const;
export type SignalTarget = 'tp1' | 'tp2' | 'tp3';
export type SignalRule = {
  /** With the timeframe chain (entry on 5m), or without it on `tf`. */
  mode: 'mtf' | 'single';
  /** The one timeframe a rule was saved with before there could be several; `tfs` is read when present. */
  tf: SignalTf;
  /** Without the chain, every timeframe it takes signals on. */
  tfs?: SignalTf[];
  /** Method ids whose TRADE signals it takes. */
  methods: string[];
  /** The signal's target the trade exits at; TGT2/TGT3 fall back to TGT1 where the signal has none. */
  target: SignalTarget;
  /** At most this many of its trades open at once. */
  maxOpen: number;
  /** When the option is sold: when the perp reaches the entry zone ("in the trade", the default), or at the signal. */
  enterOn?: 'zone' | 'signal';
  /**
   * Without the chain, per timeframe: the least distance, in BTC points, from the perp entry to the signal's SL
   * for the signal to be taken; nearer, it is skipped and the history says so. Absent or 0 for a timeframe: no filter.
   * With the chain it is the one number under `chain` (6 Oct 2026) -- its own, never a timeframe's carried over.
   */
  minSlPts?: PtsBy;
  /** The same on the other side: the least distance from the perp entry to the target the trade exits at. Absent or 0: no filter. */
  minTgtPts?: PtsBy;
  /** The other end of each: the most distance from the perp entry to the SL, and to the target; further, the signal is skipped. Absent or 0: no maximum. */
  maxSlPts?: PtsBy;
  maxTgtPts?: PtsBy;
  /**
   * What is done with the option: `sell` (a BUY signal sells the put, a SELL the call -- every strategy before the
   * choice) or `buy` (a BUY signal buys the call, a SELL the put). Absent reads as `sell`. With live orders on a
   * `buy` strategy buys at the offer and sells to close, its own target and stop judged by the desk on the bid.
   */
  action?: SignalAction;
};
export type SignalAction = 'sell' | 'buy';
export const actionOf = (rule: Pick<SignalRule, 'action'> | null | undefined): SignalAction => (rule?.action === 'buy' ? 'buy' : 'sell');
/** A bought option's exits hold one level each (the server's words). */
export const BUY_NO_STEPS = 'A BUY strategy\'s option target and stop hold one level each: remove the time steps.';
/** Where a rule with the chain keeps its distance filters (server: CHAIN_PTS). */
export const CHAIN_PTS = 'chain' as const;
export type PtsKey = SignalTf | typeof CHAIN_PTS;
export type PtsBy = Partial<Record<PtsKey, number>>;
/** "for 15m", "with the chain" (the server's words). */
export const ptsWhere = (key: string): string => (key === CHAIN_PTS ? 'with the chain' : `for ${key}`);
/** The rows a rule's distance filters have: its timeframes without the chain, the chain's one with it. */
export const ptsKeysOf = (rule: Pick<SignalRule, 'mode' | 'tf' | 'tfs'>): PtsKey[] => (rule.mode === 'single' ? (rule.tfs ?? [rule.tf]) : [CHAIN_PTS]);
/** The most an SL-distance filter may ask for (server: MAX_SL_PTS). */
export const MAX_SL_PTS = 100_000;

/** A timeframe's distance filter: `pts` the least (0: none), `max` the most (0: none). */
export type DistanceFilter = { tf: PtsKey; pts: number; max: number };

/** The timeframes a rule filters by SL distance, with their points: only the ones it takes signals on, and only where a least or a most is set. */
export function slFilters(rule: SignalRule): DistanceFilter[] {
  return distanceFilters(rule, rule.minSlPts, rule.maxSlPts);
}

/** The same for the TGT distance. */
export function tgtFilters(rule: SignalRule): DistanceFilter[] {
  return distanceFilters(rule, rule.minTgtPts, rule.maxTgtPts);
}

type ByTf = PtsBy | undefined;
function distanceFilters(rule: SignalRule, least: ByTf, most: ByTf): DistanceFilter[] {
  return ptsKeysOf(rule).map((tf) => ({ tf, pts: least?.[tf] ?? 0, max: most?.[tf] ?? 0 })).filter((x) => x.pts > 0 || x.max > 0);
}

/** The leg a signal is traded as. Sold: a BUY sells the put, a SELL the call. Bought: a BUY buys the call, a SELL the put. */
export const legOfSignal = (dir: 'long' | 'short' | 1 | -1, action: SignalAction = 'sell'): 'CE' | 'PE' => {
  const up = dir === 'long' || dir === 1;
  return action === 'buy' ? (up ? 'CE' : 'PE') : (up ? 'PE' : 'CE');
};

export const DEFAULT_SIGNAL_RULE: SignalRule = { mode: 'mtf', tf: '5m', tfs: ['5m'], methods: [], target: 'tp1', maxOpen: 1, enterOn: 'zone', action: 'sell' };

/**
 * The timeframes a rule without the chain takes: `tfs`, or the one `tf` it was saved with. An empty `tfs` is
 * the form's "None" -- nothing picked, said as a problem -- not a fall back to `tf` (the server never stores one).
 */
export const ruleTfs = (rule: Pick<SignalRule, 'tf' | 'tfs'>): SignalTf[] => rule.tfs ?? [rule.tf];

/** "5m", "5m + 1h", or "with the chain" -- how a rule's timeframes are said. */
export const ruleTfWords = (rule: SignalRule): string => (rule.mode === 'mtf' ? 'with the chain' : `on ${ruleTfs(rule).join(' + ')}`);

/**
 * A config switched to signals: its rule, live orders off, and one lot -- a
 * signal is one leg at a time, and an untested setup is sized to be measured,
 * not to matter.
 */
export function asSignalConfig(c: StrategyConfig, fresh: boolean): StrategyConfig {
  return {
    ...c,
    trigger: 'signal',
    signal: c.signal ?? { ...DEFAULT_SIGNAL_RULE },
    liveOrders: c.liveOrders ?? false,
    /*
     * A new one: one lot, and NO option target or stop (owner, 2 Oct 2026: "the option TGT / SL only when I
     * give them; not otherwise"). Its exits are the signal's, on the perp; an option exit is placed at Delta
     * only when one is typed in. Nothing is put on the option by default.
     */
    ...(fresh ? {
      lots: 1,
      targetMode: 'pct' as const, takeProfitPct: 0, takeProfitPoints: 0, takeProfitAt: 0, targetSteps: [],
      stopMode: 'pct' as const, stopLossPct: 0, stopLossPoints: 0, stopLossAt: 0, stopSteps: [],
    } : {}),
  };
}

export type Strategy = {
  /** The broker account it belongs to; it enters only while the desk is on that account. Null: none. */
  accountId?: number | null;
  /** The group it is listed in -- always one of its own account's; null or absent: in none. */
  groupId?: string | null;
  /** Its place in its group's list, set by hand (Reorder); null: where it was made. Display only. */
  position?: number | null;
  id: string;
  name: string;
  enabled: boolean;
  config: StrategyConfig;
  createdAt: number;
  updatedAt: number;
  lastRunDate: string | null;
  ranToday: boolean;
  nextEntryAt: number | null;
  /** Why it is not entering right now, in the server's own words. */
  status: string;
  /** A signal strategy's open trades now -- positions and working orders -- and their lots. Absent on an older server. */
  open?: { trades: number; lots: number };
};

/**
 * A group of one account's strategies (server: strategy/types.ts `StrategyGroup`). A way of listing them and of
 * switching them together; it is not a switch of its own -- each strategy keeps its own, and the runner reads those.
 */
export type StrategyGroup = {
  id: string;
  name: string;
  accountId: number | null;
  /** The account's name as the desk knows it; null for none. */
  accountName: string | null;
  createdAt: number;
  updatedAt: number;
  /** Its place among its account's groups, set by hand; null: where it was made. */
  position?: number | null;
};

export type StrategyRun = {
  id: number;
  strategyId: string;
  runDate: string;
  status: 'placed' | 'refused' | 'failed' | 'skipped';
  detail: string;
  at: number;
};

export type SignalRunStatus = 'claimed' | 'placed' | 'would-place' | 'refused' | 'skipped' | 'failed';
/** What a signal strategy did with one signal, in the server's words. */
export type SignalRun = {
  id: number; strategyId: string; signalKey: string; method: string; mode: string; tf: string; dir: 1 | -1;
  status: SignalRunStatus; detail: string; tradeId: string | null; at: number;
};

/** A signal strategy's trade, for the history (server: strategy/store.ts `SignalTrade`). */
export type SignalTrade = {
  id: number; strategyId: string; at: number; method: string; mode: string; tf: string; dir: 1 | -1;
  /** placed / would-place are trades; skipped, refused and failed are signals not taken, the reason in `detail`. */
  status: Exclude<SignalRunStatus, 'claimed'>; detail: string; tradeId: string | null;
  /** The signal's own plan on the BTC perp. */
  levels: { entryLo: number; entryHi: number; stop: number; tp1: number; tp2: number | null; tp3: number | null } | null;
  /** What the paper log saw on the perp: open (waiting at the zone), filled, tp1, stop, timeout, expired. */
  perp: { status: string; fillPrice: number | null; filledAt: number | null; exitPrice: number | null; exitAt: number | null } | null;
  /** A real order's option. */
  option: {
    side: string; strike: number | null; size: number; open: boolean;
    entry: number | null; exit: number | null; pnlUsd: number; exitReason: string | null;
    perpStop: number | null; perpTarget: number | null;
    /** The perp's price as the option filled in; `perpEntryApprox`: the perp that minute (a trade from before it was kept). */
    perpEntry?: number | null;
    perpEntryApprox?: boolean;
    /** The perp's price as the option was bought back; `perpExitApprox`: the perp that minute. */
    perpExit?: number | null;
    perpExitApprox?: boolean;
    /** The option's own target and stop, as placed (the backstop at Delta); null when off. */
    optionTarget?: number | null; optionStop?: number | null;
    /** Which exit closed it: the perp's SL/TGT, the option's, the window's end, or by hand. Null while open. */
    exitBy?: 'perp-sl' | 'perp-tgt' | 'option-tgt' | 'option-sl' | 'window-end' | 'manual' | null;
    /** When the option filled in, and when it was last bought back (epoch ms). */
    entryAt?: number | null; exitAt?: number | null;
  } | null;
};

export type StrategyStatus = {
  today: string;
  schedulerOn: boolean;
  /** The desk-wide "at most open at once" over every strategy; 0 is no cap. Absent on an older server. */
  signalMaxOpen?: number;
  /** Open trades the desk holds now -- positions and working orders -- which that cap is counted against. */
  openNow?: number;
  /** The desk's limit on lots short at once (the order gate's), and the lots it holds short now. Absent on an older server. */
  shortCap?: number;
  shortNow?: number;
  /** Delta's own figures, where it gives them: the account's value and the margin in use. Null on paper. */
  walletUsd?: number | null;
  marginUsedUsd?: number | null;
  /** Which build the server is, and since when (epoch ms); the tag is null when run by hand. */
  build?: { tag: string | null; startedAt: number };
  /** Whether the loop that actually places the orders is installed. */
  runnerInstalled?: boolean;
  mode: 'live' | 'paper';
  /** For pricing a size in the editor while it is being typed. */
  balanceUsd: number | null;
  spot: number | null;
  strategies: Strategy[];
  /** The groups of the account(s) shown, oldest first; absent on an older server. */
  groups?: StrategyGroup[];
  runs: StrategyRun[];
  /** The latest signals the signal strategies took, or wrote down; absent on an older server. */
  signalRuns?: SignalRun[];
  /** The signal strategies' trades, newest first, with their levels and outcomes; absent on an older server. */
  signalTrades?: SignalTrade[];
};

export const DEFAULT_CONFIG: StrategyConfig = {
  entryTime: '05:30',
  exitTime: '17:29',
  strikeRule: 'premium',
  strikeStep: 0,
  premium: { mode: 'atLeast', usd: 15, fallbackUsd: null },
  entryPrice: 'offer',
  entryLimit: null,
  crossAfterSec: 5,
  maxCrossSpreadPct: 0.15,
  takeProfitPct: 0.95,
  stopLossPct: 0,
  targetMode: 'pct',
  monitorOn: 'ltp',
  takeProfitPoints: 0,
  takeProfitAt: 0,
  targetSteps: [],
  stopMode: 'pct',
  stopLossPoints: 0,
  stopLossAt: 0,
  stopSteps: [],
  lots: 10,
  legs: 'both',
  graceMin: 60,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
