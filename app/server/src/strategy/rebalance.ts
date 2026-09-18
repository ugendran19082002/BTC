import type { TradeRecord } from '../trading/engine.js';
import type { OptionSide } from '../trading/types.js';
import { firstSalePrice } from './add.js';

/**
 * Dynamic one-sided rebalance, as a state machine.
 *
 * Both sides are sold at the open. When one side's premium has risen by 30% and
 * the other's has fallen by 20% *at the same moment*, the desk buys back part of
 * the fallen side and sells the same number of lots again on the risen one. Then
 * 40 / 30, then 50 / 40, and so on by the increment, one stage at a time.
 *
 *   100 / 100  →  70 / 130  →  40 / 160  →  10 / 190
 *
 * ## What this is, said plainly
 *
 * It **takes profit on the winning side and adds to the losing one, at a
 * higher price each time.** That is the whole strategy, and it is why the caps
 * are part of the rule rather than decoration: the position gets more one-sided
 * at exactly the moment the market is proving the sold side wrong.
 *
 * ## The rules, and the reason for each
 *
 * **Measured from the fill, not from the form.** The thresholds are percentages
 * of what each side was actually sold at. A CE filled at 14.60 against a typed
 * reference of 15.00 would otherwise fire 2.7% early, every stage, for ever.
 * The typed reference is the fallback when there is no fill to measure from.
 *
 * **Both conditions, in one evaluation.** "+31% at 10:01:01" and "−21% at
 * 10:01:05" is not the pattern; both have to be true of the same reading.
 *
 * **Confirmed over N readings.** A single wide print on a thin strike is a
 * quote, not a move. Two consecutive readings by default.
 *
 * **One stage at a time, in order.** A gap straight through stage 3's
 * thresholds fires stage 1 now and stage 2 on the next confirmed reading. Firing
 * three stages at once would treble the size on one print.
 *
 * **A stage never fires twice.** The condition stays true after it fires -- that
 * is the normal case -- and the only correct answer is to wait for the next
 * stage's thresholds. The journal enforces it as well, per strategy per day.
 *
 * **The direction is locked at the first stage** (by default). Without the lock
 * a whipsaw buys the CE back at stage 1 and the PE back at stage 2: both
 * spreads paid, and one-sided in both directions inside one day.
 *
 * **Buy first, then sell** -- the caller's job, but the reason belongs here: if
 * the buy-back fails the desk must end up flatter, never larger.
 *
 * Every refusal comes back with words, because a rebalance that did not happen
 * is the thing somebody will ask about.
 */

export type RebalanceRule = {
  /** The whole feature. Off is the default, and off is a strategy that never rebalances. */
  enabled: boolean;
  /** Lots bought back on the falling side, and sold again on the rising one. */
  lotsPerStep: number;
  /** How many stages exist at all. */
  steps: number;
  /** Stage 1's rise, in percent of the sale price. */
  upStartPct: number;
  /** Stage 1's fall, as a positive number of percent. */
  downStartPct: number;
  /** Added to both at every later stage. */
  incrementPct: number;
  /** Consecutive readings both conditions must hold for. */
  confirmTicks: number;
  /** Latest IST time a stage may fire, "HH:MM". After it, only the exit runs. */
  endTime: string;
  /** Keep the side that rose at stage 1 as the side that is sold at every stage. */
  lockDirection: boolean;
  /** Never let either side exceed this many lots. Null is no cap of its own. */
  maxLotsPerSide: number | null;
  /** With fewer lots left than a step, sell what is left rather than nothing. */
  allowPartial: boolean;
  /** Refuse to act when the book on either leg is wider than this (0.15 = 15%). */
  maxSpreadPct: number | null;
};

/**
 * What a rule starts as when the switch is first turned on. Kept as a desk
 * setting too, so a desk that always uses 40/25 over five stages types it once.
 */
export const DEFAULT_REBALANCE: RebalanceRule = {
  enabled: false,
  lotsPerStep: 30,
  steps: 3,
  upStartPct: 30,
  downStartPct: 20,
  incrementPct: 10,
  confirmTicks: 2,
  endTime: '13:30',
  lockDirection: true,
  maxLotsPerSide: 200,
  allowPartial: true,
  maxSpreadPct: 0.15,
};

/**
 * The limits a rule is held to — themselves settings, edited from the screen.
 *
 * "…n stages" was the ask, and a 3 written into the source is not an n. What
 * cannot be edited is `REBALANCE_CEILINGS`: a mistyped limit must not be able
 * to turn a 30-lot step into a 30,000-lot one, and a side that falls more than
 * 100% is not a price.
 */
export type RebalanceLimits = {
  maxSteps: number;
  maxLotsPerStep: number;
  /** The largest rise a stage may ask for, in percent. */
  maxUpPct: number;
  /** The largest fall, which cannot pass 99: a premium does not go below zero. */
  maxDownPct: number;
  maxIncrementPct: number;
  maxConfirmTicks: number;
  maxLotsPerSide: number;
};

export const REBALANCE_LIMITS: RebalanceLimits = {
  maxSteps: 20,
  maxLotsPerStep: 10_000,
  maxUpPct: 500,
  maxDownPct: 99,
  maxIncrementPct: 500,
  maxConfirmTicks: 10,
  maxLotsPerSide: 100_000,
};

/** What no limit may pass, whoever types it. */
export const REBALANCE_CEILINGS = {
  maxSteps: 100,
  maxLotsPerStep: 100_000,
  maxUpPct: 10_000,
  /** A premium cannot fall by more than all of itself. */
  maxDownPct: 99,
  maxIncrementPct: 10_000,
  maxConfirmTicks: 60,
  maxLotsPerSide: 1_000_000,
} as const;

/** Limits from a browser, brought inside the ceilings. */
export function cleanRebalanceLimits(raw: Partial<RebalanceLimits> | null | undefined): RebalanceLimits {
  const n = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const out = {} as RebalanceLimits;
  for (const key of Object.keys(REBALANCE_LIMITS) as (keyof RebalanceLimits)[]) {
    out[key] = clamp(n(raw?.[key], REBALANCE_LIMITS[key]), 1, REBALANCE_CEILINGS[key]);
  }
  return out;
}

export type RebalanceQuote = { bid: number | null; ask: number | null; mark: number | null; ts?: number };

/** What a stage needs, in percent and in money. */
export type StageThreshold = {
  stage: number;
  upPct: number;
  downPct: number;
  /** The prices those percentages mean for the two sale prices, when they are known. */
  upPrice: number | null;
  downPrice: number | null;
};

/**
 * Every stage's thresholds. Stage n rises by `increment` from stage 1, on both
 * sides, which is the "+30/-20, +40/-30, +50/-40 … n" the desk was asked for.
 */
export function stageThresholds(
  rule: Pick<RebalanceRule, 'steps' | 'upStartPct' | 'downStartPct' | 'incrementPct'>,
  base: { up: number | null; down: number | null } = { up: null, down: null },
): StageThreshold[] {
  const out: StageThreshold[] = [];
  for (let i = 0; i < Math.max(0, Math.round(rule.steps)); i++) {
    const upPct = rule.upStartPct + rule.incrementPct * i;
    const downPct = rule.downStartPct + rule.incrementPct * i;
    out.push({
      stage: i + 1,
      upPct,
      downPct,
      upPrice: base.up === null ? null : round2(base.up * (1 + upPct / 100)),
      downPrice: base.down === null ? null : round2(base.down * (1 - downPct / 100)),
    });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Percent move from the sale price. Negative is a fall, which is a seller's profit. */
export const movePct = (base: number, now: number): number | null =>
  base > 0 && Number.isFinite(now) ? ((now - base) / base) * 100 : null;

export type RebalanceSideState = {
  side: OptionSide;
  rec: TradeRecord;
  quote: RebalanceQuote;
  /** What this side was first sold at, before any rebalance changed the average. */
  base: number;
  /** Contracts still short on this side. */
  lots: number;
  /** The price the move is measured at, and the percentage it makes. */
  price: number | null;
  pct: number | null;
};

export type RebalanceDecision =
  | {
      /** Both conditions hold. The caller counts the confirmations. */
      act: 'ready';
      stage: number;
      up: RebalanceSideState;
      down: RebalanceSideState;
      /** Contracts to buy back on the fallen side and sell again on the risen one. */
      lots: number;
      partial: boolean;
      detail: string;
    }
  | {
      /** Nothing is written down for a wait: it is the answer on almost every tick. */
      act: 'wait';
      stage: number;
      detail: string;
    }
  | {
      /** Recorded, because a rebalance that could not happen is worth finding later. */
      act: 'skip';
      stage: number;
      detail: string;
    };

export type RebalanceInput = {
  rule: RebalanceRule;
  /** The two legs, with their books. Either may be missing on a one-sided day. */
  legs: { ce: TradeRecord | null; pe: TradeRecord | null };
  quotes: { ce: RebalanceQuote | null; pe: RebalanceQuote | null };
  /** Stages already done for this strategy today: 0 before the first. */
  stagesDone: number;
  /** The side sold at the first stage, when one has been. */
  lockedUpSide: OptionSide | null;
  /** IST minutes since midnight, and the strategy's entry, for the cutoff. */
  nowIstMinutes: number;
  entryIstMinutes: number;
  endIstMinutes: number;
  /** The reference typed on the form, used only where a leg has no fill. */
  referencePremium: number | null;
};

const sideState = (
  side: OptionSide,
  rec: TradeRecord,
  quote: RebalanceQuote,
  referencePremium: number | null,
): RebalanceSideState => {
  const base = firstSalePrice(rec) ?? referencePremium ?? 0;
  /*
   * The mark, not the bid or the ask.
   *
   * A threshold read off the bid fires late on the rising side and early on the
   * falling one, which biases every stage in the same direction as the spread.
   * The mark is the price both sides of the book agree on; what the orders are
   * actually placed at is a separate question, answered by the engine.
   */
  const price = quote.mark ?? mid(quote) ?? null;
  return {
    side,
    rec,
    quote,
    base,
    lots: Math.abs(rec.state.position),
    price,
    pct: price === null || !(base > 0) ? null : movePct(base, price),
  };
};

const mid = (q: RebalanceQuote): number | null =>
  q.bid !== null && q.ask !== null && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null;

const spreadPct = (q: RebalanceQuote): number | null => {
  const m = mid(q);
  return m && m > 0 && q.bid !== null && q.ask !== null ? (q.ask - q.bid) / m : null;
};

const fmt = (n: number) => n.toFixed(2);
const pctText = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;

/**
 * One evaluation. Nothing here reads a clock or places an order: given the two
 * legs, their books and what has already been done, it says what should happen.
 */
export function decideRebalance(input: RebalanceInput): RebalanceDecision {
  const { rule, legs, quotes, stagesDone } = input;
  const stage = stagesDone + 1;
  if (!rule.enabled) return { act: 'wait', stage, detail: 'rebalancing is off for this strategy' };
  if (stagesDone >= rule.steps) {
    return { act: 'wait', stage, detail: `all ${rule.steps} stages are done` };
  }
  if (!legs.ce || !legs.pe) {
    return { act: 'wait', stage, detail: 'needs both legs; a one-sided day has nothing to rebalance between' };
  }
  if (!quotes.ce || !quotes.pe) return { act: 'wait', stage, detail: 'no prices yet' };

  // The cutoff is measured forward from the entry, so an overnight strategy's
  // 13:30 is the 13:30 after it entered, not one before it.
  const since = (m: number) => (m - input.entryIstMinutes + 1_440) % 1_440;
  if (since(input.nowIstMinutes) > since(input.endIstMinutes)) {
    return { act: 'wait', stage, detail: `past ${hhmm(input.endIstMinutes)} — no more rebalancing today` };
  }

  const ce = sideState('CE', legs.ce, quotes.ce, input.referencePremium);
  const pe = sideState('PE', legs.pe, quotes.pe, input.referencePremium);
  if (ce.pct === null || pe.pct === null) {
    return { act: 'wait', stage, detail: 'no price to measure the move from' };
  }

  // Whichever side has risen is the side that is sold again; the desk never
  // decides in advance that the call is the risen one.
  const [up, down] = (ce.pct >= pe.pct ? [ce, pe] : [pe, ce]) as [
    RebalanceSideState & { pct: number; price: number },
    RebalanceSideState & { pct: number; price: number },
  ];

  const t = stageThresholds(rule, { up: up.base, down: down.base })[stage - 1];
  if (!t) return { act: 'wait', stage, detail: `no stage ${stage} in this rule` };

  const upOk = up.pct >= t.upPct;
  const downOk = down.pct <= -t.downPct;
  if (!upOk || !downOk) {
    return {
      act: 'wait',
      stage,
      detail: `stage ${stage}: ${up.side} ${pctText(up.pct)} of +${t.upPct}%`
        + `, ${down.side} ${pctText(down.pct)} of −${t.downPct}%`,
    };
  }

  if (rule.lockDirection && input.lockedUpSide && input.lockedUpSide !== up.side) {
    return {
      act: 'skip',
      stage,
      detail: `the sides swapped: stage 1 sold ${input.lockedUpSide}, and ${up.side} is the risen side now`,
    };
  }

  for (const s of [up, down]) {
    const w = spreadPct(s.quote);
    if (rule.maxSpreadPct !== null && w !== null && w > rule.maxSpreadPct) {
      return {
        act: 'wait',
        stage,
        detail: `${s.side} spread ${(w * 100).toFixed(1)}% is wider than ${(rule.maxSpreadPct * 100).toFixed(0)}%`,
      };
    }
  }

  // Only what is actually there can be bought back.
  let lots = Math.min(rule.lotsPerStep, down.lots);
  const partial = lots < rule.lotsPerStep;
  if (lots <= 0) {
    return { act: 'skip', stage, detail: `nothing left on the ${down.side} to buy back` };
  }
  if (partial && !rule.allowPartial) {
    return {
      act: 'skip',
      stage,
      detail: `only ${down.lots} lots left on the ${down.side}, and partial steps are off`,
    };
  }
  if (rule.maxLotsPerSide !== null) {
    const room = rule.maxLotsPerSide - up.lots;
    if (room <= 0) {
      return { act: 'skip', stage, detail: `${up.side} is at the ${rule.maxLotsPerSide}-lot cap` };
    }
    if (room < lots) lots = room;
  }

  return {
    act: 'ready',
    stage,
    up,
    down,
    lots,
    partial: lots < rule.lotsPerStep,
    detail: `stage ${stage}: ${up.side} ${pctText(up.pct)} at ${fmt(up.price)} (≥ +${t.upPct}%)`
      + `, ${down.side} ${pctText(down.pct)} at ${fmt(down.price)} (≤ −${t.downPct}%)`
      + ` — buy ${lots} ${down.side}, sell ${lots} ${up.side}`,
  };
}

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Every number brought inside its limits, for a rule arriving from a browser. */
export function cleanRebalance(
  raw: Partial<RebalanceRule> | null | undefined,
  limits: RebalanceLimits = REBALANCE_LIMITS,
  defaults: RebalanceRule = DEFAULT_REBALANCE,
): RebalanceRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const d = defaults;
  return {
    enabled: raw.enabled === true,
    lotsPerStep: Math.round(clamp(n(raw.lotsPerStep, d.lotsPerStep), 1, limits.maxLotsPerStep)),
    steps: Math.round(clamp(n(raw.steps, d.steps), 1, limits.maxSteps)),
    upStartPct: Math.round(clamp(n(raw.upStartPct, d.upStartPct), 1, limits.maxUpPct)),
    downStartPct: Math.round(clamp(n(raw.downStartPct, d.downStartPct), 1, limits.maxDownPct)),
    incrementPct: Math.round(clamp(n(raw.incrementPct, d.incrementPct), 0, limits.maxIncrementPct)),
    confirmTicks: Math.round(clamp(n(raw.confirmTicks, d.confirmTicks), 1, limits.maxConfirmTicks)),
    endTime: typeof raw.endTime === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(raw.endTime) ? raw.endTime : d.endTime,
    lockDirection: raw.lockDirection !== false,
    maxLotsPerSide: raw.maxLotsPerSide === null || raw.maxLotsPerSide === undefined
      ? null
      : Math.round(clamp(n(raw.maxLotsPerSide, d.maxLotsPerSide ?? 200), 1, limits.maxLotsPerSide)),
    allowPartial: raw.allowPartial !== false,
    maxSpreadPct: raw.maxSpreadPct === null || raw.maxSpreadPct === undefined
      ? null
      : clamp(n(raw.maxSpreadPct, d.maxSpreadPct ?? 0.15), 0.01, 1),
  };
}


/** A stored set of defaults, checked the same way a rule is. */
export function cleanRebalanceDefaults(
  raw: Partial<RebalanceRule> | null | undefined,
  limits: RebalanceLimits = REBALANCE_LIMITS,
): RebalanceRule {
  return cleanRebalance({ ...DEFAULT_REBALANCE, ...(raw ?? {}) }, limits, DEFAULT_REBALANCE) ?? DEFAULT_REBALANCE;
}
