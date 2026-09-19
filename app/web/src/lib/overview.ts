import type {
  ChainResponse, Leg, MarketRead, OptionStructure, Outlook, OutlookRow, SnapshotMeta,
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

/**
 * What Delta holds for a short, per contract, at `leverage`: spot × contract
 * value ÷ leverage, plus the fee to open -- the formula the server's margin
 * model was fitted to against a real ticket (server: trading/margin.ts). An
 * estimate; the ticket, and then the exchange, is the authority.
 */
export const TAKER_FEE_RATE = 0.0001;
export const FEE_CAP_FRACTION_OF_PREMIUM = 0.035;
export function feePerContract(spot: number, premium: number): number {
  return Math.min(spot * CONTRACT_BTC * TAKER_FEE_RATE, premium * CONTRACT_BTC * FEE_CAP_FRACTION_OF_PREMIUM);
}
export function marginPerContract(spot: number, leverage: number, premium: number): number {
  return spot * CONTRACT_BTC / Math.max(1, leverage) + feePerContract(spot, premium);
}

export type OrderEstimate = {
  contracts: number;
  /** Premium received, before fees. */
  creditUsd: number;
  feesUsd: number;
  marginUsd: number;
  /** Credit after the opening fee as a share of the margin it ties up. */
  returnOnMargin: number | null;
  /** The strike price where the short breaks even at settlement, after the opening fee. */
  breakevenAfterFees: number;
};

export function orderEstimate(cp: 'C' | 'P', strike: number, premium: number, spot: number, leverage: number, contracts: number): OrderEstimate {
  const creditUsd = premium * contracts * CONTRACT_BTC;
  const feesUsd = feePerContract(spot, premium) * contracts;
  const marginUsd = marginPerContract(spot, leverage, premium) * contracts;
  const feePerBtc = contracts > 0 ? feesUsd / (contracts * CONTRACT_BTC) : 0;
  return {
    contracts, creditUsd, feesUsd, marginUsd,
    returnOnMargin: marginUsd > 0 ? (creditUsd - feesUsd) / marginUsd : null,
    breakevenAfterFees: cp === 'C' ? strike + premium - feePerBtc : strike - premium + feePerBtc,
  };
}

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

/**
 * Is BTC moving more or less than it usually does: the last hour's realised
 * volatility against the 21-day figure. High above 1.3×, low under 0.7×.
 */
export function volRegime(rvShortPct: number | null, rvLongPct: number | null): { label: 'high' | 'normal' | 'low'; ratio: number } | null {
  if (rvShortPct === null || rvLongPct === null || !(rvLongPct > 0)) return null;
  const ratio = rvShortPct / rvLongPct;
  return { ratio, label: ratio >= 1.3 ? 'high' : ratio <= 0.7 ? 'low' : 'normal' };
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

// ------------------------------------------------------------ both sides

export type BothSides = {
  ce: Leg | null;
  pe: Leg | null;
  /** A side is safe when its strike sits at least one expected move away. */
  ceSafe: boolean | null;
  peSafe: boolean | null;
  /** Delta of the pair, short both: near zero is balanced. */
  netDelta: number | null;
};

export function bothSides(legs: readonly Leg[]): BothSides {
  const ce = bestLeg(legs, 'C');
  const pe = bestLeg(legs, 'P');
  const safe = (l: Leg | null) => (l === null ? null : l.emDistance === null ? null : l.emDistance >= 1);
  const netDelta = ce?.delta != null && pe?.delta != null ? -(ce.delta + pe.delta) : null;
  return { ce, pe, ceSafe: safe(ce), peSafe: safe(pe), netDelta };
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
  /** The size about to be sold, what is already short, and the desk's caps: the risk gate. */
  risk?: { contracts: number; heldShort: number; maxShortContracts: number; dayNetUsd: number | null; maxDailyLossUsd: number } | null;
}): Gate[] {
  const { data, leg, iv, nowMs, maxSpreadPct, risk } = input;
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
  if (risk) {
    const after = risk.heldShort + risk.contracts;
    const lossHit = risk.dayNetUsd !== null && risk.dayNetUsd <= -risk.maxDailyLossUsd;
    gates.push({
      key: 'risk',
      ok: after <= risk.maxShortContracts && !lossHit,
      text: lossHit
        ? `Day's loss $${Math.abs(risk.dayNetUsd!).toFixed(2)} has reached the $${risk.maxDailyLossUsd} limit`
        : `Risk: ${after} short after this (cap ${risk.maxShortContracts})${risk.dayNetUsd !== null ? ` · day ${risk.dayNetUsd >= 0 ? '+' : '−'}$${Math.abs(risk.dayNetUsd).toFixed(2)} of −$${risk.maxDailyLossUsd} allowed` : ''}`,
    });
  }
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
export function keyLevels(
  structure: OptionStructure, high24h: number | null, low24h: number | null,
  prevDayHigh: number | null = null, prevDayLow: number | null = null,
): Level[] {
  const out: Level[] = [];
  if (prevDayHigh !== null) out.push({ label: 'Prev day high', price: prevDayHigh, kind: 'range' });
  if (prevDayLow !== null) out.push({ label: 'Prev day low', price: prevDayLow, kind: 'range' });
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

// ------------------------------------------------------------ the horizons

export type HorizonRow = {
  label: string;
  minutes: number;
  pUp: number | null;
  pDown: number | null;
  /** Measured share of windows that closed inside the implied band. */
  pRange: number | null;
  /** The option market's price of the move over this horizon, in USD. */
  em: number | null;
  low: number | null;
  high: number | null;
  /** Implied ÷ measured band: above 1, the market charges more than the horizon delivers. */
  richness: number | null;
  measured: boolean;
};

/**
 * Every horizon the outlook carries, as one table: the measured up / down /
 * inside odds beside the implied move and its band. Direction odds come from
 * the measured record only; the implied move is arithmetic on the ATM IV.
 */
export function horizonRows(outlook: Outlook): HorizonRow[] {
  return outlook.rows.map((r) => ({
    label: r.label, minutes: r.minutes,
    pUp: r.pUp, pDown: r.pUp === null ? null : 1 - r.pUp, pRange: r.inside,
    em: r.impliedUsd, low: r.low, high: r.high,
    richness: r.richness,
    measured: r.pUp !== null,
  }));
}

// ------------------------------------------------ the sides, assessed

export type SideStatus = 'SELL' | 'WATCH' | 'NOT PREFERRED';

export type SideAssessment = SideCard & {
  /** Strikes between this one and the OI wall on its side; negative when spot is past the wall. */
  wallDistanceStrikes: number | null;
  wallStrike: number | null;
  /** Loss at an adverse move of two expected moves, for `contracts`, USD. The tail the desk plans for. */
  tailLossUsd: number | null;
  expectedPnlUsd: number | null;
  marginUsd: number | null;
  /** Expected P&L per dollar of tail loss. */
  riskReward: number | null;
  status: SideStatus;
};

/** Loss for a short at `price`, before fees: what the option pays out less the premium kept. Positive is a loss. */
export function shortLossAt(cp: 'C' | 'P', strike: number, premium: number, price: number, contracts: number): number {
  const payout = cp === 'C' ? Math.max(0, price - strike) : Math.max(0, strike - price);
  return Math.max(0, payout - premium) * contracts * CONTRACT_BTC;
}

export function assessSides(
  data: Pick<ChainResponse, 'legs' | 'best' | 'recommendation' | 'structure' | 'snapshot'>,
  iv: IvRv | null, em: ExpectedMove, contracts: number, leverage: number,
): SideAssessment[] {
  const step = data.snapshot.step || 200;
  return sideCards(data, iv).map((c) => {
    const leg = c.leg;
    const px = leg ? (leg.sellPrice ?? leg.mark) : null;
    const wall = c.side === 'CE' ? (data.structure.ceOiWallNear ?? data.structure.ceOiWall) : (data.structure.peOiWallNear ?? data.structure.peOiWall);
    const wallStrike = wall?.strike ?? null;
    const wallDistanceStrikes = leg && wallStrike !== null ? Math.round((c.side === 'CE' ? wallStrike - leg.strike : leg.strike - wallStrike) / step) : null;
    const adverse = em && leg ? (c.side === 'CE' ? data.snapshot.spot + 2 * em.move : data.snapshot.spot - 2 * em.move) : null;
    const tailLossUsd = leg && px !== null && adverse !== null ? shortLossAt(leg.cp, leg.strike, px, adverse, contracts) : null;
    const expectedPnlUsd = leg?.ev?.evUsd ?? null;
    const marginUsd = leg && px !== null ? marginPerContract(data.snapshot.spot, leverage, px) * contracts : null;
    const status: SideStatus = !leg ? 'NOT PREFERRED'
      : leg.ev?.signal === 'sell' && c.preferred ? 'SELL'
        : leg.ev?.signal === 'sell' || leg.ev?.signal === 'watch' ? 'WATCH'
          : 'NOT PREFERRED';
    return {
      ...c, wallDistanceStrikes, wallStrike, tailLossUsd, expectedPnlUsd, marginUsd,
      riskReward: expectedPnlUsd !== null && tailLossUsd !== null && tailLossUsd > 0 ? expectedPnlUsd / tailLossUsd : null,
      status,
    };
  });
}

export type BothStatus = 'BOTH' | 'SINGLE SIDE' | 'NO TRADE';

export type BothAssessment = BothSides & {
  rangeProbability: number | null;
  netGamma: number | null;
  netTheta: number | null;
  netVega: number | null;
  /** The worse of the two tails: a move only ever hurts one side, and the other side's premium softens it. */
  combinedTailLossUsd: number | null;
  combinedExpectedPnlUsd: number | null;
  marginUsd: number | null;
  status: BothStatus;
};

/**
 * Both sides together. Activates only when the call and the put each pass
 * their own gates (sell or watch, at least one expected move out); one side
 * passing is a single-side day; neither is no trade.
 */
export function assessBoth(
  data: Pick<ChainResponse, 'legs' | 'containment' | 'snapshot'>, sides: readonly SideAssessment[], contracts: number, leverage: number, em: ExpectedMove,
): BothAssessment {
  const b = bothSides(data.legs);
  const ce = sides.find((s) => s.side === 'CE') ?? null;
  const pe = sides.find((s) => s.side === 'PE') ?? null;
  const pass = (s: SideAssessment | null) => Boolean(s?.leg && s.status !== 'NOT PREFERRED' && (s.emDistance ?? 0) >= 1);
  const cePass = pass(ce), pePass = pass(pe);
  const sum = (a: number | null | undefined, c: number | null | undefined) => (a == null || c == null ? null : a + c);
  const size = contracts * CONTRACT_BTC;
  const cePx = b.ce ? (b.ce.sellPrice ?? b.ce.mark) : null;
  const pePx = b.pe ? (b.pe.sellPrice ?? b.pe.mark) : null;
  let combinedTailLossUsd: number | null = null;
  if (b.ce && b.pe && cePx !== null && pePx !== null && em) {
    const up = shortLossAt('C', b.ce.strike, cePx, data.snapshot.spot + 2 * em.move, contracts) - pePx * size;
    const down = shortLossAt('P', b.pe.strike, pePx, data.snapshot.spot - 2 * em.move, contracts) - cePx * size;
    combinedTailLossUsd = Math.max(0, up, down);
  }
  return {
    ...b,
    rangeProbability: data.containment?.probability ?? null,
    netGamma: b.ce && b.pe ? sum(b.ce.gamma, b.pe.gamma) : null,
    netTheta: b.ce && b.pe ? sum(b.ce.theta, b.pe.theta) : null,
    netVega: b.ce && b.pe ? sum(b.ce.vega, b.pe.vega) : null,
    combinedTailLossUsd,
    combinedExpectedPnlUsd: sum(ce?.expectedPnlUsd, pe?.expectedPnlUsd),
    marginUsd: cePx !== null && pePx !== null
      ? (marginPerContract(data.snapshot.spot, leverage, cePx) + marginPerContract(data.snapshot.spot, leverage, pePx)) * contracts : null,
    status: cePass && pePass ? 'BOTH' : cePass || pePass ? 'SINGLE SIDE' : 'NO TRADE',
  };
}

// ---------------------------------------------------------- risk engine

export type RiskEngine = {
  premium: number;
  intrinsic: number;
  extrinsic: number;
  /** Black–Scholes at the mark IV, from the server. Null on an older server. */
  theoretical: number | null;
  /** What the bid pays against the mark: negative, the market pays less than fair. */
  marketRichness: number | null;
  pTouch: number | null;
  /** |theta| ÷ gamma: how much decay is earned per unit of convexity risk. */
  thetaGammaRatio: number | null;
  /** P&L for the size if IV rises five points, USD. */
  vegaShockUsd: number | null;
  /** P&L for the size on a 1% adverse move in BTC, delta and gamma only, USD. */
  gammaShockUsd: number | null;
  /** Extrinsic value left at each point to settlement, model: extrinsic × √(time left ÷ time now). */
  decayCurve: { hours: number; extrinsic: number }[];
  tailLossUsd: number | null;
  breakevenAfterFees: number | null;
  /** Half the spread, for the size, USD: what crossing to fill costs. */
  slippageUsd: number | null;
  /** Credit after fees over margin. */
  marginYield: number | null;
  /** The next strike out on the same side with an ask: what protection costs, per BTC, and whether there is any. */
  hedge: { strike: number; askUsd: number; costUsd: number } | null;
  protectionAvailable: boolean;
};

export function riskEngine(
  leg: Leg, legs: readonly Leg[], em: ExpectedMove, spot: number, hoursToExpiry: number, contracts: number, leverage: number,
): RiskEngine | null {
  const premium = leg.sellPrice ?? leg.mark;
  if (premium === null) return null;
  const size = contracts * CONTRACT_BTC;
  const extrinsic = Math.max(0, premium - leg.intrinsic);
  const adverse = em ? (leg.cp === 'C' ? spot + 2 * em.move : spot - 2 * em.move) : null;
  const move = spot * 0.01 * (leg.cp === 'C' ? 1 : -1);
  const gammaShockUsd = leg.delta !== null && leg.gamma !== null ? -(leg.delta * move + 0.5 * leg.gamma * move * move) * size : null;
  const est = orderEstimate(leg.cp, leg.strike, premium, spot, leverage, contracts);
  const points = [1, 0.75, 0.5, 0.25, 0].map((f) => ({ hours: hoursToExpiry * f, extrinsic: extrinsic * Math.sqrt(f) }));
  const further = legs
    .filter((l) => l.cp === leg.cp && (leg.cp === 'C' ? l.strike > leg.strike : l.strike < leg.strike) && l.ask !== null && l.ask > 0)
    .sort((a, b) => (leg.cp === 'C' ? a.strike - b.strike : b.strike - a.strike))[0] ?? null;
  return {
    premium, intrinsic: leg.intrinsic, extrinsic,
    theoretical: leg.theoretical ?? null,
    marketRichness: leg.mark !== null && leg.mark > 0 && leg.bid !== null ? leg.bid / leg.mark - 1 : null,
    pTouch: leg.probs.touch,
    thetaGammaRatio: leg.theta !== null && leg.gamma !== null && leg.gamma > 0 ? Math.abs(leg.theta) / leg.gamma : null,
    vegaShockUsd: leg.vega === null ? null : -leg.vega * 5 * size,
    gammaShockUsd,
    decayCurve: points,
    tailLossUsd: adverse === null ? null : shortLossAt(leg.cp, leg.strike, premium, adverse, contracts),
    breakevenAfterFees: est.breakevenAfterFees,
    slippageUsd: leg.bid !== null && leg.ask !== null ? ((leg.ask - leg.bid) / 2) * size : null,
    marginYield: est.returnOnMargin,
    hedge: further ? { strike: further.strike, askUsd: further.ask!, costUsd: further.ask! * size } : null,
    protectionAvailable: further !== null,
  };
}

// ------------------------------------------------------- scenario grid

export type ScenarioRow = { pct: number; price: number; ce: number | null; pe: number | null; both: number | null };

/** Fee and half-spread slippage for a short of `contracts`, USD: what a scenario row nets after. */
function costsUsd(leg: Leg, spot: number, contracts: number): number {
  const px = leg.sellPrice ?? leg.mark ?? 0;
  const half = leg.bid !== null && leg.ask !== null ? (leg.ask - leg.bid) / 2 : 0;
  return feePerContract(spot, px) * contracts + half * contracts * CONTRACT_BTC;
}

/**
 * P&L at settlement for BTC −3% … +3%: the call, the put, and both together,
 * for `contracts` each, net of the opening fee and half-spread slippage:
 * premium − max(0, payout) − fees − slippage.
 */
export function scenarioGrid(ce: Leg | null, pe: Leg | null, spot: number, contracts: number, pcts: readonly number[] = [-3, -2, -1, 0, 1, 2, 3]): ScenarioRow[] {
  const cePx = ce ? (ce.sellPrice ?? ce.mark) : null;
  const pePx = pe ? (pe.sellPrice ?? pe.mark) : null;
  const ceCost = ce ? costsUsd(ce, spot, contracts) : 0;
  const peCost = pe ? costsUsd(pe, spot, contracts) : 0;
  return pcts.map((pct) => {
    const price = spot * (1 + pct / 100);
    const c = ce && cePx !== null ? shortPayoff('C', ce.strike, cePx, [price], contracts)[0]!.pnlUsd - ceCost : null;
    const p = pe && pePx !== null ? shortPayoff('P', pe.strike, pePx, [price], contracts)[0]!.pnlUsd - peCost : null;
    return { pct, price, ce: c, pe: p, both: c !== null && p !== null ? c + p : null };
  });
}

// ------------------------------------------------- the full checklist

export type Readiness = { gates: Gate[]; ready: boolean; verdict: 'ENTRY READY' | 'NO TRADE'; failing: number; unknown: number };

/**
 * The spec's full checklist: the desk's gates plus the ones a seller adds by
 * hand. `null` is "could not be read", which is not a pass. Ready only when
 * every gate is green.
 */
export function readiness(input: {
  data: Pick<ChainResponse, 'snapshot' | 'verdict' | 'direction' | 'outlook' | 'structure' | 'market'>;
  leg: Leg | null;
  iv: IvRv | null;
  em: ExpectedMove;
  nowMs: number;
  contracts: number;
  leverage: number;
  trade: { maxSpreadPct: number; maxShortContracts: number; maxDailyLossUsd: number; heldShort: number; dayNetUsd: number | null; balanceUsd: number | null } | null;
  risk: RiskEngine | null;
}): Readiness {
  const { data, leg, iv, nowMs, contracts, trade, risk } = input;
  const gates = entryGates({
    data, leg, iv, nowMs, maxSpreadPct: trade?.maxSpreadPct ?? null,
    risk: trade ? { contracts, heldShort: trade.heldShort, maxShortContracts: trade.maxShortContracts, dayNetUsd: trade.dayNetUsd, maxDailyLossUsd: trade.maxDailyLossUsd } : null,
  });
  const snap = data.snapshot;
  const h = snap.hoursToExpiry;
  const emDist = leg ? (leg.emDistance ?? leg.emBuffer ?? null) : null;
  const wall = leg ? (leg.cp === 'C' ? (data.structure.ceOiWallNear ?? data.structure.ceOiWall) : (data.structure.peOiWallNear ?? data.structure.peOiWall)) : null;
  const wallBeyond = leg && wall ? (leg.cp === 'C' ? wall.strike >= leg.strike : wall.strike <= leg.strike) : null;
  const gamma = gammaRisk(emDist);
  const slipPct = risk && risk.premium > 0 && risk.slippageUsd !== null ? risk.slippageUsd / (risk.premium * contracts * CONTRACT_BTC) : null;
  const tailOk = risk?.tailLossUsd == null || trade === null ? null : risk.tailLossUsd <= trade.maxDailyLossUsd;
  const regime = data.market?.regime ?? null;
  const conflict = leg && regime ? (leg.cp === 'C' && /up/i.test(regime)) || (leg.cp === 'P' && /down/i.test(regime)) : null;
  const marginUsd = leg && risk ? marginPerContract(snap.spot, input.leverage, risk.premium) * contracts : null;
  const extra: Gate[] = [
    { key: 'expiry', ok: snap.live ? h > 0 && h <= 36 : false, text: h <= 0 ? 'The contract has settled' : h > 36 ? `Expiry ${h.toFixed(0)}h away — not an intraday contract` : `Expiry valid — settles in ${h.toFixed(1)}h` },
    { key: 'side', ok: leg !== null, text: leg ? `${leg.cp === 'C' ? 'CE' : 'PE'} side selected` : 'No side selected' },
    { key: 'pot', ok: leg?.probs.touch == null ? null : leg.probs.touch <= 0.35, text: leg?.probs.touch == null ? 'Probability of touch: not readable' : `Probability of touch ${(leg.probs.touch * 100).toFixed(0)}% (limit 35%)` },
    { key: 'em', ok: emDist === null ? null : emDist >= 1, text: emDist === null ? 'Distance / EM: not readable' : `Strike ${emDist.toFixed(2)} expected moves away${emDist >= 1 ? '' : ' — inside the move'}` },
    { key: 'wall', ok: wallBeyond, text: wallBeyond === null ? 'No OI wall on this side' : wallBeyond ? `OI wall at ${wall!.strike.toLocaleString('en-US')} sits beyond the strike` : `OI wall at ${wall!.strike.toLocaleString('en-US')} is inside the strike` },
    { key: 'gamma', ok: gamma === null ? null : gamma !== 'high', text: gamma === null ? 'Gamma risk: not readable' : `Gamma risk ${gamma}` },
    { key: 'slippage', ok: slipPct === null ? null : slipPct <= 0.1, text: slipPct === null ? 'Slippage: no two-sided quote' : `Slippage ${(slipPct * 100).toFixed(1)}% of the credit (limit 10%)` },
    { key: 'tail', ok: tailOk, text: risk?.tailLossUsd == null ? 'Tail loss: not readable' : `Tail loss at 2×EM $${risk.tailLossUsd.toFixed(2)}${trade ? ` (day limit $${trade.maxDailyLossUsd})` : ''}` },
    { key: 'margin', ok: marginUsd === null || trade?.balanceUsd == null ? null : marginUsd <= trade.balanceUsd, text: marginUsd === null ? 'Margin: not readable' : `Margin $${marginUsd.toFixed(2)}${trade?.balanceUsd != null ? ` of $${trade.balanceUsd.toFixed(2)} balance` : ''}` },
    { key: 'size', ok: contracts > 0 && (trade ? contracts <= trade.maxShortContracts : true), text: `Position size ${contracts} contracts` },
    { key: 'regime', ok: conflict === null ? null : !conflict, text: conflict === null ? 'Regime: not readable' : conflict ? `Regime "${regime}" conflicts with a short ${leg!.cp === 'C' ? 'call' : 'put'}` : `Regime "${regime}" does not conflict` },
  ];
  // The server's checks were appended by entryGates; keep them last.
  const server = gates.filter((g) => g.key.startsWith('verdict-'));
  const mine = gates.filter((g) => !g.key.startsWith('verdict-'));
  const all = [...mine, ...extra, ...server];
  const failing = all.filter((g) => g.ok === false).length;
  const unknown = all.filter((g) => g.ok === null).length;
  const ready = allClear(all);
  return { gates: all, ready, verdict: ready ? 'ENTRY READY' : 'NO TRADE', failing, unknown };
}

// -------------------------------------------------- position state

export type PositionState = 'NORMAL' | 'WATCH' | 'WARNING' | 'ADJUST' | 'HEDGE' | 'EXIT';

export type PositionView = {
  tradeId: string;
  symbol: string;
  side: 'CE' | 'PE';
  strike: number | null;
  contracts: number;
  entryPrice: number | null;
  mark: number | null;
  pnlUsd: number | null;
  decayed: number | null;
  /** Spot to strike, USD and in expected moves. */
  distanceUsd: number | null;
  distanceEm: number | null;
  delta: number | null;
  gamma: number | null;
  iv: number | null;
  oiChange: number | null;
  state: PositionState;
  why: string;
};

/**
 * Where a short stands, and what to do about it. Thresholds in expected
 * moves and in the premium's multiple of entry:
 *   NORMAL   more than one EM away and the premium at or under entry
 *   WATCH    under one EM away, or the premium up to 1.5× entry
 *   WARNING  under half an EM, or the premium 1.5–2× entry
 *   ADJUST   under a quarter EM
 *   HEDGE    the premium past 2× entry with protection listed
 *   EXIT     through the strike, or the premium past 3× entry
 */
export function positionState(distanceEm: number | null, premiumRatio: number | null, protectionAvailable: boolean): { state: PositionState; why: string } {
  if (distanceEm !== null && distanceEm <= 0) return { state: 'EXIT', why: 'BTC is through the strike' };
  if (premiumRatio !== null && premiumRatio >= 3) return { state: 'EXIT', why: `Premium ${premiumRatio.toFixed(1)}× entry` };
  if (premiumRatio !== null && premiumRatio >= 2) return protectionAvailable ? { state: 'HEDGE', why: `Premium ${premiumRatio.toFixed(1)}× entry; protection is listed` } : { state: 'EXIT', why: `Premium ${premiumRatio.toFixed(1)}× entry and nothing to hedge with` };
  if (distanceEm !== null && distanceEm < 0.25) return { state: 'ADJUST', why: `Strike ${distanceEm.toFixed(2)} EM away` };
  if ((distanceEm !== null && distanceEm < 0.5) || (premiumRatio !== null && premiumRatio >= 1.5)) return { state: 'WARNING', why: distanceEm !== null && distanceEm < 0.5 ? `Strike ${distanceEm.toFixed(2)} EM away` : `Premium ${premiumRatio!.toFixed(1)}× entry` };
  if ((distanceEm !== null && distanceEm < 1) || (premiumRatio !== null && premiumRatio > 1)) return { state: 'WATCH', why: distanceEm !== null && distanceEm < 1 ? `Strike ${distanceEm.toFixed(2)} EM away` : `Premium ${premiumRatio!.toFixed(2)}× entry` };
  return { state: 'NORMAL', why: 'Outside the expected move, premium decaying' };
}

/** The symbol's strike and side: C-BTC-82000-190926. */
export function parseSymbol(symbol: string): { cp: 'C' | 'P'; strike: number; expiry: string } | null {
  const m = /^([CP])-BTC-(\d+)-(\d{6})$/.exec(symbol);
  return m ? { cp: m[1] as 'C' | 'P', strike: Number(m[2]), expiry: m[3]! } : null;
}

export function positionViews(
  open: readonly { tradeId: string; symbol: string; optionSide: 'CE' | 'PE'; position: number; entryAvgPrice: number | null; live?: { markPrice: number | null; unrealisedPnl: number | null; decayed: number | null } | null }[],
  legs: readonly Leg[], spot: number, em: ExpectedMove,
): PositionView[] {
  return open.filter((t) => t.position !== 0).map((t) => {
    const p = parseSymbol(t.symbol);
    const leg = p ? legs.find((l) => l.cp === p.cp && l.strike === p.strike) ?? null : null;
    const mark = t.live?.markPrice ?? leg?.mark ?? null;
    const distanceUsd = p ? (p.cp === 'C' ? p.strike - spot : spot - p.strike) : null;
    const distanceEm = distanceUsd !== null && em && em.move > 0 ? distanceUsd / em.move : null;
    const ratio = t.entryAvgPrice !== null && t.entryAvgPrice > 0 && mark !== null ? mark / t.entryAvgPrice : null;
    const protection = leg ? legs.some((l) => l.cp === leg.cp && (leg.cp === 'C' ? l.strike > leg.strike : l.strike < leg.strike) && l.ask !== null && l.ask > 0) : false;
    const s = positionState(distanceEm, ratio, protection);
    return {
      tradeId: t.tradeId, symbol: t.symbol, side: t.optionSide, strike: p?.strike ?? null, contracts: Math.abs(t.position),
      entryPrice: t.entryAvgPrice, mark, pnlUsd: t.live?.unrealisedPnl ?? null, decayed: t.live?.decayed ?? null,
      distanceUsd, distanceEm, delta: leg?.delta ?? null, gamma: leg?.gamma ?? null, iv: leg?.iv ?? null,
      oiChange: leg?.oiChange?.change ?? null, state: s.state, why: s.why,
    };
  });
}

// ------------------------------------------------ premium momentum

/** Premium velocity (per 5 minutes) and acceleration (the change of that), from recorded snapshots. */
export function premiumMomentum(points: readonly { at: number; mark: number | null }[]): { velocity: number | null; acceleration: number | null } {
  const marks = points.filter((p) => p.mark !== null);
  const n = marks.length;
  if (n < 2) return { velocity: null, acceleration: null };
  const v1 = marks[n - 1]!.mark! - marks[n - 2]!.mark!;
  if (n < 3) return { velocity: v1, acceleration: null };
  const v0 = marks[n - 2]!.mark! - marks[n - 3]!.mark!;
  return { velocity: v1, acceleration: v1 - v0 };
}

// ------------------------------------------------ side gates and selector

export type SideGate = { name: string; ok: boolean | null; text: string };

/**
 * One side, criterion by criterion -- PASS / FAIL rather than a score, as
 * the spec asks. A `null` is unreadable and counts against SELL.
 */
export function sideGates(input: {
  side: 'CE' | 'PE';
  leg: Leg | null;
  iv: IvRv | null;
  regime: string | null;
  direction: { confirmed: boolean; readable: number; summary: string };
  outlook: Outlook;
  maxSpreadPct: number | null;
  tailLossUsd: number | null;
  maxDailyLossUsd: number | null;
  marginUsd: number | null;
  balanceUsd: number | null;
}): SideGate[] {
  const { side, leg, iv, regime, direction, outlook, maxSpreadPct, tailLossUsd, maxDailyLossUsd, marginUsd, balanceUsd } = input;
  const cp = side === 'CE' ? 'C' : 'P';
  const c = consensus(outlook);
  // A short call wants the market not to go up; a short put, not down.
  const against = side === 'CE' ? c.up : c.down;
  const withSide = side === 'CE' ? c.down + c.flat : c.up + c.flat;
  const mtf = c.scored === 0 ? null : against <= c.scored / 3 && withSide >= c.scored / 2;
  const conflict = regime === null ? null : (cp === 'C' && /up/i.test(regime)) || (cp === 'P' && /down/i.test(regime));
  const emDist = leg ? (leg.emDistance ?? leg.emBuffer ?? null) : null;
  const g = gammaRisk(emDist);
  const pa = leg ? premiumAnalysis(leg, null) : null;
  const slip = pa && pa.spreadPct !== null ? pa.spreadPct / 2 : null;
  return [
    { name: 'Direction', ok: conflict === null ? (direction.readable === 0 ? null : direction.confirmed) : !conflict, text: conflict ? `regime "${regime}" runs into a short ${cp === 'C' ? 'call' : 'put'}` : direction.summary },
    { name: 'PoT', ok: leg?.probs.touch == null ? null : leg.probs.touch <= 0.35, text: leg?.probs.touch == null ? 'not readable' : `${(leg.probs.touch * 100).toFixed(0)}% (limit 35%)` },
    { name: 'Distance / EM', ok: emDist === null ? null : emDist >= 1, text: emDist === null ? 'not readable' : `${emDist.toFixed(2)}×` },
    { name: 'IV − RV', ok: iv ? iv.label !== 'cheap' : null, text: iv ? `${iv.label} · ${iv.ratio.toFixed(2)}×` : 'not readable' },
    { name: 'Gamma', ok: g === null ? null : g !== 'high', text: g ?? 'not readable' },
    { name: 'Liquidity', ok: pa?.spreadPct == null || maxSpreadPct === null ? null : pa.spreadPct <= maxSpreadPct / 100, text: pa?.spreadPct == null ? 'no two-sided quote' : `spread ${(pa.spreadPct * 100).toFixed(1)}%` },
    { name: 'Tail risk', ok: tailLossUsd === null || maxDailyLossUsd === null ? null : tailLossUsd <= maxDailyLossUsd, text: tailLossUsd === null ? 'not readable' : `$${tailLossUsd.toFixed(2)} at 2×EM` },
    { name: 'Execution', ok: slip === null ? null : slip <= 0.1, text: slip === null ? 'no quote' : `half-spread ${(slip * 100).toFixed(1)}% of premium` },
    { name: 'Margin', ok: marginUsd === null || balanceUsd === null ? null : marginUsd <= balanceUsd, text: marginUsd === null ? 'not readable' : `$${marginUsd.toFixed(2)}` },
    { name: 'MTF consensus', ok: mtf, text: c.scored === 0 ? 'no horizon readable' : `${c.up} up · ${c.down} down · ${c.flat} flat of ${c.scored}` },
  ];
}

/** SELL when every gate passes; WATCH when only soft gates fail; NOT PREFERRED otherwise. */
export function sideStatusOf(gates: readonly SideGate[]): SideStatus {
  const hard = new Set(['Direction', 'PoT', 'Distance / EM', 'Tail risk', 'Margin']);
  if (gates.every((g) => g.ok === true)) return 'SELL';
  if (gates.some((g) => hard.has(g.name) && g.ok === false)) return 'NOT PREFERRED';
  return gates.filter((g) => g.ok !== true).length <= 2 ? 'WATCH' : 'NOT PREFERRED';
}

export type SideChoice = { side: 'CE' | 'PE' | 'BOTH' | 'NO_TRADE'; why: string };

/**
 * The side, from the regime and the horizon consensus and each side's own
 * safety -- never from the score alone. Bullish and the put safe: PE.
 * Bearish and the call safe: CE. Range and both safe: BOTH. A conflict, or
 * a failed side: NO_TRADE.
 */
export function sideSelector(regime: string | null, outlook: Outlook, ceStatus: SideStatus, peStatus: SideStatus): SideChoice {
  const c = consensus(outlook);
  const bull = c.scored > 0 && c.up > c.scored / 2;
  const bear = c.scored > 0 && c.down > c.scored / 2;
  const regUp = regime !== null && /up/i.test(regime);
  const regDown = regime !== null && /down/i.test(regime);
  const regRange = regime !== null && /quiet|mixed|range/i.test(regime);
  const ceOk = ceStatus !== 'NOT PREFERRED', peOk = peStatus !== 'NOT PREFERRED';
  if ((regUp && bear) || (regDown && bull)) return { side: 'NO_TRADE', why: `Regime "${regime}" against the horizons (${c.up} up · ${c.down} down)` };
  if ((regUp || bull) && !regDown && !bear) return peOk ? { side: 'PE', why: 'Bullish regime and horizons; the put side passes' } : { side: 'NO_TRADE', why: 'Bullish, but the put side fails its gates' };
  if ((regDown || bear) && !regUp && !bull) return ceOk ? { side: 'CE', why: 'Bearish regime and horizons; the call side passes' } : { side: 'NO_TRADE', why: 'Bearish, but the call side fails its gates' };
  if (regRange || (!bull && !bear)) {
    if (ceOk && peOk) return { side: 'BOTH', why: 'Range regime; both sides pass' };
    if (ceOk) return { side: 'CE', why: 'Range regime; only the call side passes' };
    if (peOk) return { side: 'PE', why: 'Range regime; only the put side passes' };
  }
  return { side: 'NO_TRADE', why: 'No side passes its gates' };
}

// --------------------------------------------------- execution estimate

export type ExecutionEstimate = {
  bid: number | null;
  bidSize: number | null;
  /** Where a sell of `contracts` fills: the bid when the bid is deep enough, a tick under it otherwise. */
  expectedFill: number | null;
  /** Bid to expected fill, plus half the spread, per BTC. */
  slippagePerBtc: number | null;
  feeUsd: number;
  /** Premium at the expected fill less fee and slippage, USD for the size. */
  netPremiumUsd: number | null;
  thin: boolean;
};

/** A short fills at the bid, not the mark. Delta's ticker carries the best bid and its size; that is what is used. */
export function executionEstimate(leg: Leg, spot: number, contracts: number, tick = 0.5): ExecutionEstimate {
  const bid = leg.bid;
  const size = contracts * CONTRACT_BTC;
  const bidSize = (leg as Leg & { bidSize?: number | null }).bidSize ?? null;
  const thin = bidSize !== null && bidSize < contracts;
  const expectedFill = bid === null ? null : thin ? Math.max(0, bid - tick) : bid;
  const half = leg.bid !== null && leg.ask !== null ? (leg.ask - leg.bid) / 2 : 0;
  const slippagePerBtc = bid === null || expectedFill === null ? null : bid - expectedFill + half;
  const feeUsd = expectedFill === null ? 0 : feePerContract(spot, expectedFill) * contracts;
  return {
    bid, bidSize, expectedFill, slippagePerBtc, feeUsd,
    netPremiumUsd: expectedFill === null || slippagePerBtc === null ? null : expectedFill * size - feeUsd - slippagePerBtc * size,
    thin,
  };
}

// ---------------------------------------------------------- shock table

export type Shock = { label: string; pnlUsd: number | null };

/** P&L for the size on fixed BTC moves (delta + gamma) and IV moves (vega), as the short sees them. */
export function shockTable(leg: Leg, contracts: number): Shock[] {
  const size = contracts * CONTRACT_BTC;
  const px = (d: number) => (leg.delta === null || leg.gamma === null ? null : -(leg.delta * d + 0.5 * leg.gamma * d * d) * size);
  const iv = (pts: number) => (leg.vega === null ? null : -leg.vega * pts * size);
  return [
    { label: 'BTC +100', pnlUsd: px(100) }, { label: 'BTC +250', pnlUsd: px(250) }, { label: 'BTC +500', pnlUsd: px(500) },
    { label: 'BTC −100', pnlUsd: px(-100) }, { label: 'BTC −250', pnlUsd: px(-250) }, { label: 'BTC −500', pnlUsd: px(-500) },
    { label: 'IV +1', pnlUsd: iv(1) }, { label: 'IV +2', pnlUsd: iv(2) }, { label: 'IV −1', pnlUsd: iv(-1) },
  ];
}

// ------------------------------------------------ multi-timeframe table

export type MtfRow = { tf: string; trend: string; momentum: 'bullish' | 'bearish' | 'neutral' | null; model: number | null; signal: '↑' | '↓' | '→' };

/** Trend and RSI momentum from the bars, the model's up-odds from the matching horizon, one row per timeframe. */
export function mtfRows(market: MarketRead | null, outlook: Outlook): MtfRow[] {
  const byMin = new Map(outlook.rows.map((r) => [r.minutes, r]));
  const mins: Record<string, number> = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '3h': 180, '4h': 240, '6h': 360, '12h': 720, '1d': 1440 };
  const tfs = market?.timeframes ?? [];
  const labels = [...new Set([...tfs.map((t) => t.tf), ...outlook.rows.map((r) => r.label)])]
    .filter((l) => l in mins).sort((a, b) => mins[a]! - mins[b]!);
  return labels.map((tf) => {
    const t = tfs.find((x) => x.tf === tf) ?? null;
    const r = byMin.get(mins[tf]!) ?? null;
    const momentum = t?.rsi14 == null ? null : t.rsi14 >= 55 ? 'bullish' : t.rsi14 <= 45 ? 'bearish' : 'neutral';
    const model = r?.pUp ?? null;
    const lean = t ? t.trend : model === null ? 0 : model > 0.55 ? 1 : model < 0.45 ? -1 : 0;
    return { tf, trend: t ? (t.trend === 1 ? 'up' : t.trend === -1 ? 'down' : 'side') : '—', momentum, model, signal: lean === 1 ? '↑' : lean === -1 ? '↓' : '→' };
  });
}
