import { MARGIN_PER_CONTRACT, sizingOf } from '@/lib/strategy-preview';
import type { Strategy } from '@/types/strategy';

/**
 * What the signal strategies switched on add up to (4 Oct 2026): how many
 * entries they allow between them, how many lots that is, and the margin it
 * would take with every one of them open at once.
 *
 * Each strategy's own "at most open" reads as modest; the sum is what the
 * account has to carry, and nobody adds five cards up in their head. This is
 * the sum, and what the desk-wide limit is held to: a limit above the entries
 * the strategies allow can never be reached. Pure.
 */
export type SignalTotals = {
  /** Signal strategies switched on. */
  strategies: number;
  /** The sum of their "at most open at once". */
  entries: number;
  /** Lots with every entry open: each strategy's lots times its entries. */
  lots: number;
  /** Margin that needs, at 200x, and its share of the free balance (null with no balance yet). */
  marginUsd: number;
  marginInr: number;
  share: number | null;
};

const on = (strategies: readonly Strategy[]) =>
  strategies.filter((s) => s.enabled && s.config.trigger === 'signal' && s.config.signal);

export function signalTotals(strategies: readonly Strategy[], balanceUsd: number | null, spot: number | null): SignalTotals {
  const mine = on(strategies);
  const sized = mine.map((s) => sizingOf(s.config, balanceUsd, spot));
  const marginUsd = sized.reduce((n, z) => n + z.marginUsd, 0);
  return {
    strategies: mine.length,
    entries: mine.reduce((n, s) => n + s.config.signal!.maxOpen, 0),
    lots: sized.reduce((n, z) => n + z.maxContracts, 0),
    marginUsd,
    marginInr: sized.reduce((n, z) => n + z.marginInr, 0),
    share: balanceUsd && balanceUsd > 0 ? marginUsd / balanceUsd : null,
  };
}

/**
 * What can still open from here, at worst: the entries the strategies have
 * room for -- each its own limit less what it holds -- inside what the
 * desk-wide limit leaves (`cap` less every open trade on the desk; no cap, no
 * such bound), taken from the strategies with the most lots first.
 *
 * This is the number to hold against the FREE margin. The free balance is
 * already net of the margin the open positions use, so the whole requirement
 * against it counts those positions twice -- it read "more than the free
 * margin" on a desk whose remaining entries fitted (4 Oct 2026).
 */
export function roomLeft(
  strategies: readonly Strategy[], cap: number, openOnDesk: number, spot: number | null,
  o: {
    /** Lots the desk's short limit still allows: its cap less the lots short now. Null or absent: no such bound. */
    lotsLeft?: number | null;
    /** Margin a lot, in USD, when a better figure than the 200x model is known (`marginPerLotUsd`). */
    perLotUsd?: number;
  } = {},
): { entries: number; lots: number; marginUsd: number; heldByShortLimit: boolean } {
  const fill = (lotsBound: number) => {
    let slots = cap > 0 ? Math.max(0, cap - openOnDesk) : Infinity;
    let lotsLeft = lotsBound;
    let entries = 0;
    let lots = 0;
    for (const s of [...on(strategies)].sort((a, b) => b.config.lots - a.config.lots)) {
      const per = s.config.lots;
      // An entry is taken whole or not at all: the gate refuses an order that would pass the short limit.
      const take = Math.min(slots, Math.max(0, s.config.signal!.maxOpen - (s.open?.trades ?? 0)), per > 0 ? Math.floor(lotsLeft / per) : 0);
      entries += take;
      lots += take * per;
      slots -= take;
      lotsLeft -= take * per;
      if (slots <= 0) break;
    }
    return { entries, lots };
  };
  const free = fill(Infinity);
  const bound = o.lotsLeft === null || o.lotsLeft === undefined ? free : fill(Math.max(0, o.lotsLeft));
  const perLot = o.perLotUsd ?? (spot && spot > 0 ? MARGIN_PER_CONTRACT(spot) : 0);
  return { ...bound, marginUsd: bound.lots * perLot, heldByShortLimit: bound.lots < free.lots };
}

/**
 * Margin a lot, in USD, for what is still to open: the higher of the desk's
 * 200x model and what Delta is charging per lot on the positions held now
 * (its own margin in use over the lots short). The model is a fixed formula;
 * Delta's figure moves with the premium -- so where Delta's is known and is
 * the dearer, it is the one to plan on. With nothing held, or on paper, the
 * model alone.
 */
export function marginPerLotUsd(spot: number | null, marginUsedUsd: number | null | undefined, shortLots: number | null | undefined): number {
  const model = spot && spot > 0 ? MARGIN_PER_CONTRACT(spot) : 0;
  const delta = marginUsedUsd && shortLots && marginUsedUsd > 0 && shortLots > 0 ? marginUsedUsd / shortLots : 0;
  return Math.max(model, delta);
}

/**
 * Why a desk-wide limit cannot be saved, or null -- the server's
 * `globalMaxOpenProblem`, word for word, so the form says before the save what
 * the server would say after it.
 */
export function globalMaxOpenProblem(v: number, allowed: number, most: number): string | null {
  if (!Number.isInteger(v) || v < 0 || v > most) {
    return `At most open at once, across all strategies, must be a whole number from 0 (no limit) to ${most}.`;
  }
  if (allowed > 0 && v > allowed) {
    return `The strategies switched on allow ${allowed} entr${allowed === 1 ? 'y' : 'ies'} between them, so a limit above ${allowed} changes nothing. Enter ${allowed} or less.`;
  }
  return null;
}

/**
 * One strategy's limit and how much of it is in use now: entries, lots and the
 * margin behind them. "In use" is what the desk holds for it -- positions and
 * working orders -- as the server counts them (`Strategy.open`).
 */
export type Usage = {
  entries: number; maxEntries: number;
  lots: number; maxLots: number;
  marginUsd: number; maxMarginUsd: number;
};

export function usageOf(s: Strategy, spot: number | null): Usage {
  const per = spot && spot > 0 ? MARGIN_PER_CONTRACT(spot) : 0;
  const maxEntries = s.config.signal?.maxOpen ?? 0;
  const maxLots = maxEntries * s.config.lots;
  const lots = s.open?.lots ?? 0;
  return { entries: s.open?.trades ?? 0, maxEntries, lots, maxLots, marginUsd: lots * per, maxMarginUsd: maxLots * per };
}

/** Every signal strategy's use added up -- switched off ones too, since a position does not close when its strategy is switched off. */
export function usageNow(strategies: readonly Strategy[], spot: number | null): { entries: number; lots: number; marginUsd: number } {
  return strategies.filter((s) => s.config.trigger === 'signal').map((s) => usageOf(s, spot))
    .reduce((a, u) => ({ entries: a.entries + u.entries, lots: a.lots + u.lots, marginUsd: a.marginUsd + u.marginUsd }), { entries: 0, lots: 0, marginUsd: 0 });
}

/**
 * A bought option's cost (5 Oct 2026): a BUY strategy uses no margin -- the option is paid for in full -- so its
 * figures are the premium, not margin. Per lot, priced at the strategy's own premium number (USD per BTC, on a
 * 0.001 BTC contract): for "paying at most $50" that is the most a lot costs; for "at least" or a strike picked
 * by distance it is not known until the strike is, and reads as null -- shown as unknown, never as zero.
 */
const CONTRACT_BTC = 0.001;
export function buyCostPerLotUsd(s: Strategy): number | null {
  const c = s.config;
  if (c.strikeRule === 'strict' || c.strikeRule === 'delta' || c.strikeRule === 'distance' || !c.premium || c.premium.mode !== 'atMost') return null;
  const most = Math.max(c.premium.usd, c.premium.fallbackUsd ?? 0);
  return most > 0 ? most * CONTRACT_BTC : null;
}

export type BuyTotals = {
  /** BUY strategies switched on. */
  strategies: number;
  /** The sum of their "at most open at once", and the lots that is. */
  entries: number; lots: number;
  /** What they hold now: open trades and lots, of every BUY strategy (a position outlives its strategy being switched off). */
  openEntries: number; openLots: number;
  /** Room left: each strategy's own limit less what it holds, inside the desk-wide limit's room. */
  roomEntries: number; roomLots: number;
  /** The most that room costs, at each strategy's premium number; null when any of it cannot be priced. */
  roomCostUsd: number | null;
  /** The most every entry open at once costs; null likewise. */
  allCostUsd: number | null;
};

export function buyTotals(strategies: readonly Strategy[], capRoom: number | null): BuyTotals {
  const buyers = strategies.filter((s) => s.config.trigger === 'signal' && s.config.signal?.action === 'buy');
  const live = on(buyers);
  let roomEntries = 0, roomLots = 0, roomCost: number | null = 0, allCost: number | null = 0;
  let left = capRoom === null ? Infinity : Math.max(0, capRoom);
  // The largest lots first: the worst case, as the sellers' room is worked out.
  for (const s of [...live].sort((a, b) => b.config.lots - a.config.lots)) {
    const per = buyCostPerLotUsd(s);
    const max = s.config.signal!.maxOpen;
    allCost = allCost === null || per === null ? null : allCost + per * max * s.config.lots;
    const mine = Math.min(left, Math.max(0, max - (s.open?.trades ?? 0)));
    left -= mine;
    roomEntries += mine;
    roomLots += mine * s.config.lots;
    roomCost = roomCost === null || (per === null && mine > 0) ? null : roomCost + (per ?? 0) * mine * s.config.lots;
  }
  return {
    strategies: live.length,
    entries: live.reduce((n, s) => n + s.config.signal!.maxOpen, 0),
    lots: live.reduce((n, s) => n + s.config.signal!.maxOpen * s.config.lots, 0),
    openEntries: buyers.reduce((n, s) => n + (s.open?.trades ?? 0), 0),
    openLots: buyers.reduce((n, s) => n + (s.open?.lots ?? 0), 0),
    roomEntries, roomLots, roomCostUsd: roomCost, allCostUsd: allCost,
  };
}
