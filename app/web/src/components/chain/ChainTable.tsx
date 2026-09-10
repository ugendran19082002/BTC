import { useEffect, useRef } from 'react';
import type { Leg, SideRecommendation, SnapshotMeta } from '@/types/desk';
import { heldKey, type HeldLeg } from '@/lib/held';
import { signedInr, usdToInr } from '@/lib/format';

/** What a tap on a price hands back: enough to open a ticket, nothing more. */
export type ChainSellIntent = {
  cp: 'C' | 'P';
  strike: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
};

const n = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '·' : v.toFixed(d);

const num = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '·';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(0);
};

/**
 * This strike's own chance of expiring worthless: the maths, corrected by what
 * really happened to strikes like it. The raw maths sits in the next column so
 * the size of the correction is visible rather than hidden.
 *
 * Reading the history bucket straight off instead gave every strike in a
 * five-point bucket the same percentage, which is what made a call and a put
 * with different open interest show an identical number.
 */
function Zero({ leg, sold = false }: { leg: Leg | undefined; sold?: boolean }) {
  const z = leg?.zero ?? null;
  const p = z?.adjusted ?? null;
  if (z === null || p === null) return <td className="zerocol dim">—</td>;
  const cls = p >= 0.97 ? 'up' : p >= 0.9 ? 'warn' : 'down';
  const title = z.outsideTable
    ? 'Beyond the tested range — the nearest estimate is used'
    : `${z.sample?.toLocaleString() ?? 0} similar strikes settled; the maths alone says ${(z.model * 100).toFixed(1)}%`;
  return (
    <td className={`zerocol ${cls}${sold ? ' sellcell' : ''}`} title={title}>
      {(p * 100).toFixed(1)}%
      {z.outsideTable && <span className="dim">*</span>}
    </td>
  );
}

/**
 * A price that opens the ticket.
 *
 * Selling is what this desk does, so a tap anywhere on a strike's prices means
 * "sell this one" and the ticket decides bid or offer. Making the ask the only
 * live target would put the fastest route to a fill -- the bid -- behind an
 * extra step, and on a phone the two cells are four millimetres apart anyway.
 */
function PriceCell({
  value, className, onSell, decimals = 2, title,
}: {
  value: number | null | undefined;
  className: string;
  onSell?: () => void;
  decimals?: number;
  title?: string;
}) {
  const text = n(value ?? null, decimals);
  if (!onSell || value === null || value === undefined) {
    return <td className={className} title={title}>{text}</td>;
  }
  return (
    <td className={`${className} tappable`} title={title}>
      <button type="button" onClick={onSell} aria-label={`sell at ${text}`}>{text}</button>
    </td>
  );
}

/** A traded price nobody has hit in a while is not a price you can sell at. */
function Age({ min }: { min: number | null }) {
  if (min === null) return <span className="dim">—</span>;
  if (min === 0) return <span className="up">live</span>;
  if (min <= 15) return <span className="muted">{min}m</span>;
  return <span className="warn">{min}m</span>;
}

/**
 * What the exchange actually listed, against what was asked for.
 *
 * Delta lists a daily contract over a narrow band around the money -- around a
 * dozen strikes each way -- and widens it only as BTC travels. Asking for 30
 * each side and getting 12 is that limit, not a truncated fetch, but with
 * nothing said the table just looks short of the setting and reads as a bug.
 */
function Coverage({ snap }: { snap: SnapshotMeta }) {
  const c = snap.coverage;
  if (!c || !c.truncated) return null;
  return (
    <div className="note" style={{ padding: '8px 12px', margin: 0 }}>
      Delta lists {c.above} strikes above and {c.below} below the price
      {c.lowest !== null && c.highest !== null && <> ({c.lowest.toLocaleString()}–{c.highest.toLocaleString()})</>}.
      {' '}That is all there is for this expiry.
    </div>
  );
}

/**
 * A strike you are already short, said on the strike itself.
 *
 * The board and the positions card were two readings of the same account with
 * nothing joining them: a strike could be open in one and anonymous in the
 * other, and connecting them meant matching a number in a card against a column
 * of two dozen. The chip is that join, and it carries the P&L because "am I
 * short this one" and "how is it doing" are the same glance.
 *
 * Rupees only, and rounded: this is a mark in a crowded row, not the account.
 * The full figure with its dollars lives on the positions card.
 */
function HeldChip({ held }: { held: HeldLeg }) {
  const pnl = held.pnlUsd;
  const tone = pnl === null || pnl === 0 ? '' : pnl > 0 ? ' up' : ' down';
  return (
    <span
      className={`tag held${tone}`}
      title={`You are short ${held.size} of this strike. P&L at Delta's price.`}
    >
      {held.cp === 'C' ? 'CE' : 'PE'} {held.size}
      {pnl !== null && <> · {signedInr(usdToInr(pnl))}</>}
    </span>
  );
}

/**
 * Laid out the way the exchange lays it out — calls left, puts right, strike in
 * the middle — with bid and ask shown separately from the mark.
 *
 * The separation matters for a seller: you receive the BID, not the mark and
 * not the last trade. Reading the mark as your fill is how a backtest that
 * looks profitable turns into a live account that is not.
 */
export function ChainTable({
  legs,
  snap,
  sides = [],
  density = 'default',
  onSell,
  maxSpreadPct,
  held,
}: {
  legs: Leg[];
  snap: SnapshotMeta;
  /**
   * The strikes the desk is actually recommending, marked on the board they
   * came from. This is `recommendation.sides`, not `picks`: picks is the best
   * leg by premium alone and is populated even on a day when nothing clears the
   * safety bar, so marking from it put SELL tags on the chain while the card
   * beside it said there was nothing safe enough to sell.
   */
  sides?: SideRecommendation[];
  /** Tapping a price asks for a ticket. Absent means the board is read-only. */
  onSell?: (intent: ChainSellIntent) => void;
  /**
   * The widest spread an order may cross, as a fraction of the mid.
   *
   * Strikes past it are marked, because a board of two dozen prices does not
   * say which of them you can actually take -- and finding out by having the
   * ticket refuse you is a slow way to read a chain.
   */
  maxSpreadPct?: number;
  /**
   * 'default' is the odds either side of the strike, the raw model behind them,
   * the offer and the bid. 'all' adds the mark, open interest, volume, age,
   * delta and implied volatility.
   *
   * The bid is what a seller actually receives, and the board marks the ones
   * whose spread is too wide to cross -- which makes it the column you act on
   * rather than a reference figure, so it is in the default set.
   */
  density?: 'default' | 'all';
  /**
   * The strikes currently held, keyed by `heldKey`. Absent on a historical
   * snapshot and on the read-only board, where "you are short this" would be a
   * claim about the wrong day.
   */
  held?: Map<string, HeldLeg>;
}) {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  // visible columns each side of the strike: the odds, the raw model behind
  // them, and the ask -- plus the seven reference ones when they are showing
  // The odds either side of the strike, the raw model behind them, the offer,
  // and the bid. The bid is back in the default set: it is what a seller
  // actually receives, and now that the board marks which ones are too wide to
  // cross, it is the column you act on rather than a reference figure.
  const perSide = density === 'all' ? 10 : 4;
  const at = (k: number, cp: 'C' | 'P') => legs.find((l) => l.strike === k && l.cp === cp);

  /**
   * Can this one be taken at the bid right now?
   *
   * `null` when there is no two-sided quote to judge from -- which is not the
   * same as "no", and is drawn differently.
   */
  const takeable = (leg: Leg | undefined): boolean | null => {
    if (maxSpreadPct === undefined || !leg || leg.bid == null || leg.ask == null) return null;
    const mid = (leg.bid + leg.ask) / 2;
    if (!(mid > 0) || leg.ask <= leg.bid) return null;
    return (leg.ask - leg.bid) / mid <= maxSpreadPct;
  };
  const sell = (leg: Leg | undefined, cp: 'C' | 'P', k: number) =>
    onSell && leg
      ? () => onSell({ cp, strike: k, bid: leg.bid ?? null, ask: leg.ask ?? null, mark: leg.mark ?? null })
      : undefined;
  const hasBook = legs.some((l) => l.bid !== null || l.ask !== null);

  // The recommendation names a strike; the chain is where that strike lives.
  // Without this the two never meet on screen and you are left matching a
  // number in a card against a number in a column of twenty-four.
  const sold: Partial<Record<'C' | 'P', number>> = {};
  for (const s of sides) sold[s.side === 'CE' ? 'C' : 'P'] = s.leg.strike;

  // Open on the money. The interesting strikes are around spot, and a table
  // that opens at its lowest strike makes you scroll to find where you are.
  const box = useRef<HTMLDivElement>(null);
  const atmRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const b = box.current, r = atmRow.current;
    if (!b || !r) return;
    // The board no longer scrolls vertically, so the money is brought into view
    // by moving the page rather than the box.
    r.scrollIntoView({ block: 'center' });
    // The strike sits in the middle of the table, calls to its left and puts to
    // its right. On a phone the table is wider than the screen, and opening at
    // either edge shows one side of the board with the strike off-screen -- so
    // centre it, and both bids are a short swipe away.
    b.scrollLeft = Math.max(0, (b.scrollWidth - b.clientWidth) / 2);
  }, [snap.atm, snap.expiry, density]);

  return (
    <>
    <Coverage snap={snap} />
    {/*
      Full height, always. A board of two dozen strikes inside its own scroller
      means the page scrolls and then the table scrolls, and you lose your place
      in both. The page is the only thing that scrolls vertically now; the box
      still scrolls sideways, because on a phone the board is wider than the
      screen and nothing can be done about that.
    */}
    <div className={`scroll chain chain-${density}`} ref={box}>
      <table>
        <thead>
          <tr>
            {/*
              This has to match what is actually on screen. Hiding the reference
              columns with CSS while the span still claimed ten of them made the
              table reserve width for columns that were not there -- a blank
              strip down the right of the box, and the calls bid pushed off the
              left edge on a phone.
            */}
            <th colSpan={perSide} className="left ce">CALLS</th>
            <th>STRIKE</th>
            <th colSpan={perSide} className="left pe">PUTS</th>
          </tr>
          <tr>
            <th className="aux">OI</th><th className="aux">Vol</th><th className="aux">Age</th>
            <th className="aux">Δ</th><th className="aux">IV</th>
            <th className="zerocol">→ 0</th><th>Model</th>
            <th className="askcol">Ask</th><th className="aux">Mark</th>
            <th className="bidcol">Bid</th>
            <th></th>
            <th className="bidcol">Bid</th><th className="aux">Mark</th>
            <th className="askcol">Ask</th>
            <th>Model</th><th className="zerocol">→ 0</th>
            <th className="aux">IV</th><th className="aux">Δ</th>
            <th className="aux">Age</th><th className="aux">Vol</th><th className="aux">OI</th>
          </tr>
        </thead>
        <tbody>
          {strikes.map((k) => {
            const c = at(k, 'C');
            const p = at(k, 'P');
            const sellC = sold.C === k;
            const sellP = sold.P === k;
            const isAtm = k === snap.atm;
            const heldC = held?.get(heldKey('C', k));
            const heldP = held?.get(heldKey('P', k));
            return (
              <tr
                key={k}
                ref={isAtm ? atmRow : undefined}
                className={[
                  isAtm ? 'atm' : '',
                  sellC || sellP ? 'sold' : '',
                  // Separate from `sold`: one is what the desk suggests, the
                  // other is what you have actually done, and the row must not
                  // let them look like the same statement.
                  heldC || heldP ? 'holding' : '',
                ].filter(Boolean).join(' ') || undefined}
              >
                <td className="dim aux">{num(c?.oi ?? null)}</td>
                <td className="dim aux">{num(c?.volume ?? null)}</td>
                <td className="aux"><Age min={c?.ageMin ?? null} /></td>
                <td className="aux">{n(c?.delta ?? null, 3)}</td>
                <td className="dim aux">{c?.iv != null ? (c.iv * 100).toFixed(1) : '·'}</td>
                <Zero leg={c} sold={sellC} />
                <td className="dim">{c?.pOtm != null ? (c.pOtm * 100).toFixed(0) + '%' : '·'}</td>
                <PriceCell className="askcol" value={c?.ask} onSell={sell(c, 'C', k)} />
                <td className="aux">{n(c?.mark ?? null)}</td>
                <PriceCell
                  className={`bidcol${sellC ? ' sellcell' : ''}${takeable(c) === false ? ' wide' : ''}`}
                  value={c?.bid}
                  onSell={sell(c, 'C', k)}
                  title={takeable(c) === false ? 'Spread too wide — sell at the ask instead' : undefined}
                />

                <td className="mono strikecell">
                  {k}
                  {isAtm && <span className="tag">ATM</span>}
                  {heldC && <HeldChip held={heldC} />}
                  {heldP && <HeldChip held={heldP} />}
                  {sellC && !heldC && <span className="tag ok">SELL CE</span>}
                  {sellP && !heldP && <span className="tag ok">SELL PE</span>}
                </td>

                <PriceCell
                  className={`bidcol${sellP ? ' sellcell' : ''}${takeable(p) === false ? ' wide' : ''}`}
                  value={p?.bid}
                  onSell={sell(p, 'P', k)}
                  title={takeable(p) === false ? 'Spread too wide — sell at the ask instead' : undefined}
                />
                <td className="aux">{n(p?.mark ?? null)}</td>
                <PriceCell className="askcol" value={p?.ask} onSell={sell(p, 'P', k)} />
                <td className="dim">{p?.pOtm != null ? (p.pOtm * 100).toFixed(0) + '%' : '·'}</td>
                <Zero leg={p} sold={sellP} />
                <td className="dim aux">{p?.iv != null ? (p.iv * 100).toFixed(1) : '·'}</td>
                <td className="aux">{n(p?.delta ?? null, 3)}</td>
                <td className="aux"><Age min={p?.ageMin ?? null} /></td>
                <td className="dim aux">{num(p?.volume ?? null)}</td>
                <td className="dim aux">{num(p?.oi ?? null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
      <div className="note" style={{ padding: '8px 12px', margin: '0 0 12px' }}>
        {onSell && <><b>Tap a price</b> to sell that strike.{' '}</>}
        {maxSpreadPct !== undefined && (
          <>A <b className="warnbid">crossed-out bid</b> has too wide a spread — sell at the ask instead.{' '}</>
        )}
        <b className="up">Bid</b> = what you get when you sell.
        {' '}<b className="up">→ 0</b> = chance it expires worthless, from 733 days of real results.
        {' '}<b>Model</b> = the maths alone. <b>*</b> = beyond the tested range.
      </div>
      {!hasBook && (
        <div className="note" style={{ padding: '8px 12px', margin: '0 0 12px' }}>
          Past date: no bid or ask, so the mark is used as the sell price.
        </div>
      )}
    </>
  );
}
