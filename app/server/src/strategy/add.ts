import type { TradeRecord } from '../trading/engine.js';
import type { OptionSide } from '../trading/types.js';
import { defaultAddUntil, isHhmm, minutesForward, minutesOf, time12, type StrategyConfig } from './types.js';

/**
 * Add to the other leg when a target buys contracts back.
 *
 * A strategy sold 425 CE and 425 PE at 15, both with a target near 1. The CE
 * target buys 425 back; the PE is at 7. The CE has finished earning -- its
 * premium is banked -- and the PE is still paying 7 a contract. So sell 425
 * more PE at 7, appended to the PE trade itself: one position of 850, one
 * average price, and the PE's own target and stop resized to cover all of it.
 *
 * Pure: trades, prices and a clock in; one decision per target out. No store,
 * no exchange, no Telegram -- `adder.ts` does those, and every rule the desk
 * applies to real money is here, where the tests can reach all of it.
 *
 * THE RULES, in the order they are checked:
 *
 *   1. Something new was bought back by a leg's target. A stop, a manual close
 *      or the exit time is not a reason to sell more of anything. A leg that
 *      was itself added to today does not add back: no ping-pong.
 *   2. The fill is fresh. Deciding hours later, after a restart, would sell into
 *      a market that is not the one the rule was about.
 *   3. Not after the strategy's latest-add time (half an hour before its exit
 *      by default), where an add pays to get in and again to be closed minutes
 *      later.
 *   4. There is another leg today. A one-sided day -- the doubled CE 850 -- has
 *      none, so nothing is added.
 *   5. That leg is still simply open: not closed (adding would re-open a leg
 *      the day already got out of) and not closing. If an add is already
 *      working on it, the decision waits for that one to finish.
 *   6. A price to judge by: bid and mark both present. Without one the decision
 *      waits, and rule 2 ends the wait.
 *   7. Its bid is at least the minimum (default $3).
 *   8. Its mark is below the multiple of its sale price (default 2x): a leg that
 *      doubled is a leg losing money, and this is not a way to add to a loss.
 *   9. It has a target, and the bid is above it. The add exits at the leg's
 *      target price; if the market is already there, the target would buy the
 *      add straight back for less than nothing.
 *
 * Every rule ends in a recorded skip with its reason, except "nothing new" and
 * "waiting" (no price yet, or an add already working): an add that does not
 * happen is still a decision somebody may want to check.
 */

/** A target fill older than this is not acted on. */
export const ADD_FRESH_MS = 2 * 60_000;
/** An add rests this long; whatever has not filled by then is cancelled. */
export const ADD_WINDOW_MS = 5 * 60_000;

export type AddQuote = { bid: number | null; ask: number | null; mark: number | null };

export type AddDecision =
  | {
      act: 'add';
      source: TradeRecord;
      opposite: TradeRecord;
      /** Everything the source's target has bought back so far. */
      boughtBack: number;
      /** How many of those have not been decided about yet: the size to sell. */
      contracts: number;
      quote: AddQuote;
      detail: string;
    }
  | {
      act: 'skip';
      source: TradeRecord;
      opposite: TradeRecord | null;
      boughtBack: number;
      contracts: number;
      detail: string;
    }
  | {
      /** Not decided yet: no price to judge by, or an add already working. Nothing is recorded. */
      act: 'wait';
      source: TradeRecord;
      contracts: number;
      detail: string;
    };

const other = (side: OptionSide): OptionSide => (side === 'CE' ? 'PE' : 'CE');

/** Contracts bought back by this trade's target, and when the last of them was. */
export function targetBoughtBack(rec: TradeRecord): { contracts: number; lastAt: number | null } {
  const pieces = rec.state.fills.filter((f) => f.role === 'take_profit');
  return {
    contracts: pieces.reduce((n, f) => n + f.size, 0),
    lastAt: pieces.length ? Math.max(...pieces.map((f) => f.ts)) : null,
  };
}

/** The day's leg on one side: the strategy's trade on that contract, with contracts sold. */
function legOn(trades: TradeRecord[], side: OptionSide, expiryTs: number): TradeRecord | null {
  const legs = trades
    .filter((t) => t.plan.optionSide === side && t.plan.expect.expiryTs === expiryTs && t.state.entrySize > 0)
    .sort((a, b) => b.state.entrySize - a.state.entrySize);
  return legs[0] ?? null;
}

const fmt = (n: number) => n.toFixed(2);

/**
 * What the leg was first sold at, before anything was added to it.
 *
 * "Doubled" is measured against the morning's sale -- 15 to 30 -- not against
 * an average that an earlier add has already pulled down.
 */
export function firstSalePrice(rec: TradeRecord): number | null {
  let want = rec.state.entrySize - (rec.state.addedSize ?? 0);
  let size = 0;
  let notional = 0;
  for (const f of rec.state.fills) {
    if (f.role !== 'entry' || want <= 0) continue;
    const take = Math.min(f.size, want);
    size += take;
    notional += take * f.price;
    want -= take;
  }
  return size > 0 ? notional / size : rec.state.entryAvgPrice;
}

/**
 * What to do about every target that has bought something back.
 *
 * `trades` is one strategy's trades for the day. `decided` says, per source
 * trade, how many bought-back contracts already have a decision recorded.
 * `quotes` holds the live price of each contract that might be sold.
 * `nowIstMinutes` is the IST time of day, for the exit-time cutoff.
 */
export function decideAdds(input: {
  config: StrategyConfig;
  trades: TradeRecord[];
  decided: (sourceTradeId: string) => number;
  quotes: Map<string, AddQuote>;
  now: number;
  nowIstMinutes: number;
}): AddDecision[] {
  const rule = input.config.addToOpposite;
  if (!rule) return [];

  const out: AddDecision[] = [];
  for (const source of input.trades) {
    // Rule 1: a leg whose target has bought back something new.
    const { contracts: boughtBack, lastAt } = targetBoughtBack(source);
    const contracts = boughtBack - input.decided(source.state.tradeId);
    if (contracts <= 0) continue;

    const side = source.plan.optionSide;
    const theirs = other(side);
    const skip = (detail: string, opposite: TradeRecord | null = null): AddDecision =>
      ({ act: 'skip', source, opposite, boughtBack, contracts, detail });
    const said = `${side} target bought back ${contracts}`;

    if ((source.state.addedSize ?? 0) > 0 || source.state.adding) {
      out.push(skip(`${said} — the ${side} was itself added to today, so it does not add back`));
      continue;
    }

    // Rule 2.
    if (lastAt !== null && input.now - lastAt > ADD_FRESH_MS) {
      out.push(skip(`${said} ${Math.round((input.now - lastAt) / 60_000)} min ago — too long ago to add`));
      continue;
    }
    // Rule 3.
    const until = isHhmm(rule.addUntil) ? rule.addUntil : defaultAddUntil(input.config.exitTime);
    // Both measured forward from the entry, so the cutoff sits inside an
    // overnight window the same way it sits inside a daytime one.
    const entry = minutesOf(input.config.entryTime);
    if (minutesForward(entry, input.nowIstMinutes) > minutesForward(entry, minutesOf(until))) {
      out.push(skip(`${said} — after the ${time12(until)} latest time to add, not adding`));
      continue;
    }
    // Rule 4.
    const opposite = legOn(input.trades, theirs, source.plan.expect.expiryTs);
    if (!opposite) {
      out.push(skip(`${said} — no ${theirs} leg today, nothing to add to`));
      continue;
    }
    // Rule 5.
    if (opposite.state.position === 0) {
      out.push(skip(`${said} — the ${theirs} leg is already closed`, opposite));
      continue;
    }
    const phase = opposite.state.phase;
    if (phase !== 'protected' && phase !== 'position_open' && phase !== 'unprotected') {
      out.push(skip(`${said} — the ${theirs} leg is ${phase.replace('_', ' ')}, not adding`, opposite));
      continue;
    }
    if (opposite.state.adding) {
      out.push({ act: 'wait', source, contracts, detail: `${said} — an add is already working on the ${theirs}` });
      continue;
    }
    // Rule 6.
    const q = input.quotes.get(opposite.plan.symbol);
    if (!q || q.bid === null || q.mark === null) {
      out.push({ act: 'wait', source, contracts, detail: `${said} — no ${theirs} price yet` });
      continue;
    }
    // Rule 7.
    if (q.bid < rule.minPriceUsd) {
      out.push(skip(`${said} — ${theirs} bid ${fmt(q.bid)} is below $${fmt(rule.minPriceUsd)}`, opposite));
      continue;
    }
    // Rule 8.
    const sold = firstSalePrice(opposite);
    if (sold !== null && q.mark >= rule.maxMultiple * sold) {
      out.push(skip(
        `${said} — ${theirs} at ${fmt(q.mark)} is ${rule.maxMultiple}x or more its ${fmt(sold)} sale, not adding to a losing leg`,
        opposite,
      ));
      continue;
    }
    // Rule 9.
    const target = opposite.plan.takeProfitPrice;
    if (target === null) {
      out.push(skip(`${said} — the ${theirs} leg has no target to exit an add at`, opposite));
      continue;
    }
    if (q.bid <= target) {
      out.push(skip(`${said} — ${theirs} bid ${fmt(q.bid)} is already at its ${fmt(target)} target`, opposite));
      continue;
    }

    out.push({
      act: 'add', source, opposite, boughtBack, contracts, quote: q,
      detail: `${said} — adding ${contracts} to the ${theirs} ${opposite.plan.expect.strike} at bid ${fmt(q.bid)}+, target ${fmt(target)}`,
    });
  }
  return out;
}
