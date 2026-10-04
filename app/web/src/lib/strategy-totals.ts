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
