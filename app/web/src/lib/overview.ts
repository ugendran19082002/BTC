import type {
  ChainResponse, Leg, OptionStructure, Outlook, OutlookRow, SnapshotMeta,
} from '@/types/desk';

/**
 * The arithmetic behind the Overview screen: every figure it shows that is
 * not already a field of the chain response.
 *
 * Two rules, both from docs/test.md:
 *   - nothing is estimated where it can be read, and nothing is shown where it
 *     cannot be computed -- a missing input is `null`, which the screen draws as
 *     a dash, never as a plausible-looking number;
 *   - probabilities come from the desk's own measured sources (the settlement
 *     record, the analytics service), never from a rule of thumb dressed as one.
 */

/** Contract value on Delta's BTC options: one contract is 0.001 BTC. */
export const CONTRACT_BTC = 0.001;

// ------------------------------------------------------------------ volatility

export type IvRv = { ivPct: number; rvPct: number; spreadPts: number; ratio: number; label: 'rich' | 'fair' | 'cheap' };

/**
 * Implied against realised volatility, both annualised percent.
 *
 * `ratio` is what a seller is paid for against what BTC has been delivering:
 * above 1.15 the premium is rich, under 0.9 it is cheap. Thresholds, not a
 * model -- the label says which side of fair, the numbers say by how much.
 */
export function ivRv(atmIv: number | null, realisedVolPct: number | null): IvRv | null {
  if (atmIv === null || realisedVolPct === null || !(realisedVolPct > 0) || !(atmIv > 0)) return null;
  const ivPct = atmIv * 100;
  const ratio = ivPct / realisedVolPct;
  return {
    ivPct, rvPct: realisedVolPct, spreadPts: ivPct - realisedVolPct, ratio,
    label: ratio >= 1.15 ? 'rich' : ratio <= 0.9 ? 'cheap' : 'fair',
  };
}

// ------------------------------------------------------------------------ skew

export type Skew = {
  put25: { strike: number; iv: number; delta: number } | null;
  call25: { strike: number; iv: number; delta: number } | null;
  atmIv: number | null;
  /** 25Δ put IV minus 25Δ call IV, in volatility points. Positive: downside protection costs more. */
  putCallPts: number | null;
};

/** The leg whose delta is nearest `target`, among legs that have both a delta and an IV. */
function nearestDelta(legs: readonly Leg[], cp: 'C' | 'P', target: number) {
  let best: Leg | null = null;
  for (const l of legs) {
    if (l.cp !== cp || l.delta === null || l.iv === null) continue;
    if (!best || Math.abs(l.delta - target) < Math.abs(best.delta! - target)) best = l;
  }
  // Nothing within 0.1 of the target is not a 25-delta option; say so rather than stretch.
  if (!best || Math.abs(best.delta! - target) > 0.1) return null;
  return { strike: best.strike, iv: best.iv!, delta: best.delta! };
}

export function skew(legs: readonly Leg[], atmIv: number | null): Skew {
  const put25 = nearestDelta(legs, 'P', -0.25);
  const call25 = nearestDelta(legs, 'C', 0.25);
  return {
    put25, call25, atmIv,
    putCallPts: put25 && call25 ? (put25.iv - call25.iv) * 100 : null,
  };
}

// ---------------------------------------------------------- expected move

export type ExpectedMove = { move: number; upper: number; lower: number; hours: number; ivPct: number } | null;

/** spot × IV × √(t / 1 year), to this contract's settlement. The option market's own price of the move. */
export function expectedMove(snap: Pick<SnapshotMeta, 'spot' | 'atmIv' | 'hoursToExpiry' | 'expectedMove'>): ExpectedMove {
  if (snap.atmIv === null || !(snap.hoursToExpiry > 0)) return null;
  const move = snap.expectedMove ?? snap.spot * snap.atmIv * Math.sqrt(snap.hoursToExpiry / 8760);
  return { move, upper: snap.spot + move, lower: snap.spot - move, hours: snap.hoursToExpiry, ivPct: snap.atmIv * 100 };
}

// --------------------------------------------------------- premium and odds

export type PremiumAnalysis = {
  premium: number;
  intrinsic: number;
  extrinsic: number;
  extrinsicShare: number;
  /** |theta| as a share of the premium, per day. How fast time is working for a seller. */
  thetaPerPremiumDay: number | null;
  /** |theta| per hour, in USD per BTC. Near settlement a day's theta exceeds the premium, so hours are the honest unit. */
  thetaPerHour: number | null;
  /** Premium as a share of the expected move: what the short is paid per dollar of typical travel. */
  premiumPerEm: number | null;
  /** Distance from spot to the strike, in expected moves. */
  emDistance: number | null;
  /** Spread as a share of the mid. */
  spreadPct: number | null;
};

export function premiumAnalysis(leg: Leg, em: ExpectedMove): PremiumAnalysis | null {
  const premium = leg.mark ?? leg.sellPrice;
  if (premium === null || !(premium >= 0)) return null;
  const intrinsic = leg.intrinsic;
  const extrinsic = Math.max(0, premium - intrinsic);
  const mid = leg.bid !== null && leg.ask !== null ? (leg.bid + leg.ask) / 2 : null;
  return {
    premium, intrinsic, extrinsic,
    extrinsicShare: premium > 0 ? extrinsic / premium : 0,
    thetaPerPremiumDay: leg.theta !== null && premium > 0 ? Math.abs(leg.theta) / premium : null,
    thetaPerHour: leg.theta === null ? null : Math.abs(leg.theta) / 24,
    premiumPerEm: em && em.move > 0 ? premium / em.move : null,
    emDistance: leg.emDistance ?? leg.emBuffer ?? null,
    spreadPct: mid !== null && mid > 0 ? (leg.ask! - leg.bid!) / mid : null,
  };
}

export type Odds = {
  /** Settlement odds from the desk's measured record where it has one, the model otherwise. */
  pOtm: number | null;
  pItm: number | null;
  pTouch: number | null;
  deltaApprox: number | null;
  modelOtm: number | null;
  /** Where `pOtm` came from, so the screen can say. */
  source: 'measured' | 'model' | null;
};

export function odds(leg: Leg): Odds {
  const measured = leg.zero?.adjusted ?? null;
  const model = leg.pOtm ?? leg.probs.expireWorthless ?? null;
  const pOtm = measured ?? model;
  return {
    pOtm, pItm: pOtm === null ? null : 1 - pOtm, pTouch: leg.probs.touch,
    deltaApprox: leg.delta === null ? null : Math.abs(leg.delta),
    modelOtm: model,
    source: measured !== null ? 'measured' : model !== null ? 'model' : null,
  };
}

// ---------------------------------------------------------------- payoff

export type PayoffRow = { price: number; pnlUsd: number };

/**
 * A short option held to settlement: premium kept, less what it pays out at
 * each price. Per `contracts` (0.001 BTC each), in USD, before fees.
 */
export function shortPayoff(cp: 'C' | 'P', strike: number, premium: number, prices: readonly number[], contracts: number): PayoffRow[] {
  const size = contracts * CONTRACT_BTC;
  return prices.map((price) => {
    const payout = cp === 'C' ? Math.max(0, price - strike) : Math.max(0, strike - price);
    return { price, pnlUsd: (premium - payout) * size };
  });
}

/** The strike price where a short breaks even at settlement, before fees. */
export const breakeven = (cp: 'C' | 'P', strike: number, premium: number) => (cp === 'C' ? strike + premium : strike - premium);

/** Prices to show a payoff over: the strike ± a few steps, and spot, sorted and de-duplicated. */
export function payoffPrices(strike: number, spot: number, step: number, n = 3): number[] {
  const out = new Set<number>([Math.round(spot / step) * step]);
  for (let i = -n; i <= n; i++) out.add(strike + i * step);
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------- the decision

export type SideCard = {
  side: 'CE' | 'PE';
  leg: Leg | null;
  /** The leg's desk score, 0–10. */
  score: number | null;
  pOtm: number | null;
  pTouch: number | null;
  emDistance: number | null;
  ivRich: IvRv['label'] | null;
  gammaRisk: 'low' | 'medium' | 'high' | null;
  preferred: boolean;
};

/** Gamma risk from distance in expected moves: the nearer the strike, the faster its delta can turn. */
export function gammaRisk(emDistance: number | null): SideCard['gammaRisk'] {
  if (emDistance === null) return null;
  return emDistance >= 1.5 ? 'low' : emDistance >= 0.8 ? 'medium' : 'high';
}

/** The desk's highest-scoring out-of-the-money strike on one side, or null. */
export function bestLeg(legs: readonly Leg[], cp: 'C' | 'P'): Leg | null {
  let best: Leg | null = null;
  for (const l of legs) {
    if (l.cp !== cp || l.moneyness !== 'OTM' || l.score === null) continue;
    if (!best || l.score > best.score!) best = l;
  }
  return best;
}

export function sideCards(data: Pick<ChainResponse, 'legs' | 'best' | 'recommendation'>, iv: IvRv | null): SideCard[] {
  const chosen = data.best.pick && !data.best.bestOfNone ? data.best.pick.side : null;
  return (['CE', 'PE'] as const).map((side) => {
    const cp = side === 'CE' ? 'C' : 'P';
    // The desk's own pick for the side where it has one; otherwise its best-scored strike.
    const rec = data.recommendation.sides.find((s) => s.side === side)?.leg ?? null;
    const leg = rec ?? bestLeg(data.legs, cp);
    const o = leg ? odds(leg) : null;
    const emDistance = leg ? (leg.emDistance ?? leg.emBuffer ?? null) : null;
    return {
      side, leg,
      score: leg?.score === null || leg?.score === undefined ? null : leg.score * 10,
      pOtm: o?.pOtm ?? null, pTouch: o?.pTouch ?? null, emDistance,
      ivRich: iv?.label ?? null, gammaRisk: gammaRisk(emDistance),
      preferred: chosen === side,
    };
  });
}

/** Top `n` sell candidates on one side, by the desk's score, out of the money and not refused. */
export function candidates(legs: readonly Leg[], cp: 'C' | 'P', n = 3): Leg[] {
  return legs
    .filter((l) => l.cp === cp && l.moneyness === 'OTM' && l.score !== null && l.ev?.signal !== 'avoid')
    .sort((a, b) => b.score! - a.score!)
    .slice(0, n);
}

// ------------------------------------------------------------- the model view

export type ModelView = {
  /** Which horizon this is. */
  label: string;
  pUp: number;
  pSide: number;
  pDown: number;
  /** Where the numbers come from: the analytics service's measured states, or the desk's own history. */
  source: 'measured' | 'history';
  windows: number | null;
} | null;

/**
 * Down / Side / Up for one horizon, from what was measured -- never invented.
 *
 * The analytics service's row where it answered; otherwise the plain history
 * (share of windows that closed higher) with Side left at zero, because the
 * history alone does not separate "flat" from "up a little".
 */
export function modelView(outlook: Outlook, horizonMinutes = 720): ModelView {
  const row = pickRow(outlook.rows, horizonMinutes);
  if (!row) return null;
  if (row.measured) {
    return { label: row.label, pUp: row.measured.pUp, pSide: row.measured.pSide, pDown: row.measured.pDown, source: 'measured', windows: row.measured.windows };
  }
  if (row.pUp === null) return null;
  return { label: row.label, pUp: row.pUp, pSide: 0, pDown: 1 - row.pUp, source: 'history', windows: outlook.sampleWindows };
}

function pickRow(rows: readonly OutlookRow[], minutes: number): OutlookRow | null {
  let best: OutlookRow | null = null;
  for (const r of rows) if (!best || Math.abs(r.minutes - minutes) < Math.abs(best.minutes - minutes)) best = r;
  return best;
}

/** How many horizons lean each way, and whether they agree enough to trust a side. */
export function consensus(outlook: Outlook): { up: number; down: number; flat: number; scored: number; agree: boolean } {
  const scored = outlook.bullish + outlook.bearish + outlook.flat;
  const top = Math.max(outlook.bullish, outlook.bearish);
  return {
    up: outlook.bullish, down: outlook.bearish, flat: outlook.flat, scored,
    // Five of seven, as the text asks: strong disagreement is itself a reason to wait.
    agree: scored > 0 && top / scored >= 5 / 7,
  };
}

// ------------------------------------------------------------- the gates

export type Gate = { key: string; ok: boolean | null; text: string };

/** How old the board is. Beyond `maxAgeMs` nothing on it is a price to trade on. */
export function freshness(snapTsSec: number, nowMs: number, maxAgeMs = 30_000): { ageMs: number; fresh: boolean } {
  const ageMs = Math.max(0, nowMs - snapTsSec * 1000);
  return { ageMs, fresh: ageMs <= maxAgeMs };
}

/**
 * The entry checklist: every gate that must be green before a sell.
 *
 * The desk's own verdict checks come first -- they are the server's, and the
 * server decides -- and the screen-side ones (fresh data, a live contract,
 * horizons agreeing, the spread) are added beside them, each with its reason.
 */
export function entryGates(input: {
  data: Pick<ChainResponse, 'snapshot' | 'verdict' | 'direction' | 'outlook'>;
  leg: Leg | null;
  iv: IvRv | null;
  nowMs: number;
  maxSpreadPct: number | null;
}): Gate[] {
  const { data, leg, iv, nowMs, maxSpreadPct } = input;
  const f = freshness(data.snapshot.ts, nowMs);
  const c = consensus(data.outlook);
  const pa = leg ? premiumAnalysis(leg, null) : null;
  const gates: Gate[] = [
    { key: 'fresh', ok: data.snapshot.live ? f.fresh : false,
      text: data.snapshot.live ? `Market data ${Math.round(f.ageMs / 1000)}s old${f.fresh ? '' : ' — too old to trade on'}` : 'A past snapshot — nothing to trade' },
    { key: 'contract', ok: data.snapshot.live && data.snapshot.hoursToExpiry > 0 && leg !== null,
      text: leg ? `${leg.cp === 'C' ? 'CE' : 'PE'} ${leg.strike.toLocaleString('en-US')} live, ${data.snapshot.hoursToExpiry.toFixed(1)}h to settlement` : 'No strike selected' },
    { key: 'direction', ok: data.direction.confirmed ? true : data.direction.readable === 0 ? null : false,
      text: data.direction.summary },
    { key: 'consensus', ok: c.scored === 0 ? null : c.agree,
      text: c.scored === 0 ? 'No horizon could be read' : `Horizons: ${c.up} up · ${c.down} down · ${c.flat} flat${c.agree ? '' : ' — they disagree'}` },
    { key: 'iv', ok: iv ? iv.label !== 'cheap' : null,
      text: iv ? `IV ${iv.ivPct.toFixed(1)}% vs realised ${iv.rvPct.toFixed(1)}% — ${iv.label}` : 'IV vs realised: not readable' },
    { key: 'liquidity', ok: pa?.spreadPct === null || pa === null || maxSpreadPct === null ? null : pa.spreadPct <= maxSpreadPct / 100,
      text: pa?.spreadPct == null ? 'Spread: no two-sided quote' : `Spread ${(pa.spreadPct * 100).toFixed(1)}%${maxSpreadPct !== null ? ` (limit ${maxSpreadPct}%)` : ''}` },
  ];
  // The server's own gates, as it wrote them. It is the authority; these are shown, not re-judged.
  for (const [i, ch] of data.verdict.checks.entries()) {
    gates.push({ key: `verdict-${i}`, ok: ch.ok ? true : ch.severity === 'block' ? false : null, text: ch.text });
  }
  return gates;
}

/** All hard gates green. A `null` (unreadable) is not a pass. */
export const allClear = (gates: readonly Gate[]) => gates.length > 0 && gates.every((g) => g.ok === true);

// ------------------------------------------------------------ key levels

export type Level = { label: string; price: number; kind: 'resistance' | 'support' | 'pivot' | 'range' };

/** Levels the board and the tape both know, sorted high to low. Nothing drawn that was not read. */
export function keyLevels(structure: OptionStructure, high24h: number | null, low24h: number | null): Level[] {
  const out: Level[] = [];
  const ce = structure.ceOiWallNear ?? structure.ceOiWall;
  const pe = structure.peOiWallNear ?? structure.peOiWall;
  if (ce) out.push({ label: 'Call OI wall', price: ce.strike, kind: 'resistance' });
  if (pe) out.push({ label: 'Put OI wall', price: pe.strike, kind: 'support' });
  if (structure.maxPain) out.push({ label: 'Max pain', price: structure.maxPain.strike, kind: 'pivot' });
  if (structure.gammaWall) out.push({ label: 'Gamma wall', price: structure.gammaWall.strike, kind: 'pivot' });
  if (high24h !== null) out.push({ label: '24h high', price: high24h, kind: 'range' });
  if (low24h !== null) out.push({ label: '24h low', price: low24h, kind: 'range' });
  return out.sort((a, b) => b.price - a.price);
}
