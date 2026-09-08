import { useEffect, useRef } from 'react';
import type { Leg, SideRecommendation, SnapshotMeta } from '../types';

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
    ? 'Past the range the history covers, so the nearest correction was used'
    : `${z.sample?.toLocaleString() ?? 0} strikes like this settled; the maths alone said ${(z.model * 100).toFixed(1)}%`;
  return (
    <td className={`zerocol ${cls}${sold ? ' sellcell' : ''}`} title={title}>
      {(p * 100).toFixed(1)}%
      {z.outsideTable && <span className="dim">*</span>}
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
      Delta lists <b>{c.above} strikes above</b> and <b>{c.below} below</b> the money
      for this expiry{c.lowest !== null && c.highest !== null && <> ({c.lowest.toLocaleString()}–{c.highest.toLocaleString()})</>},
      {' '}so asking for {c.requested} each side gets everything there is. The exchange
      opens a daily contract over a narrow band and adds strikes as BTC moves toward
      them — nothing is missing from the fetch.
    </div>
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
  /**
   * 'default' is the odds either side of the strike, the raw model behind them,
   * and the ask. 'all' adds the bid, the mark, open interest, volume, age,
   * delta and implied volatility.
   *
   * The bid is what a seller actually receives, so it is not a detail -- but
   * the price of the leg the desk picked is stated on the recommendation card
   * either way, and reading the whole board is a different job from reading one
   * strike. Switch to 'all' before pricing a strike the desk did not pick.
   */
  density?: 'default' | 'all';
}) {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  // Show every strike you asked for. Capping this at a fraction of the viewport
  // meant "20 each side" still ended in a scrollbar, which is the opposite of
  // what the setting says. The page scrolls; the table does not need to as well.
  // The header row stays stuck to the top so the columns remain readable.
  const height = `${strikes.length * 22 + 96}px`;
  // visible columns each side of the strike: the odds, the raw model behind
  // them, and the ask -- plus the seven reference ones when they are showing
  const perSide = density === 'all' ? 10 : 3;
  const at = (k: number, cp: 'C' | 'P') => legs.find((l) => l.strike === k && l.cp === cp);
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
    b.scrollTop = Math.max(0, r.offsetTop - b.clientHeight / 2 + r.clientHeight / 2);
    // The strike sits in the middle of the table, calls to its left and puts to
    // its right. On a phone the table is wider than the screen, and opening at
    // either edge shows one side of the board with the strike off-screen -- so
    // centre it, and both bids are a short swipe away.
    b.scrollLeft = Math.max(0, (b.scrollWidth - b.clientWidth) / 2);
  }, [snap.atm, snap.expiry, density]);

  return (
    <>
    <Coverage snap={snap} />
    <div
      className={`scroll chain chain-${density}`}
      style={{ maxHeight: height }}
      ref={box}
    >
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
            <th className="zerocol">→ 0</th><th>model</th>
            <th className="askcol">Ask</th><th className="aux">Mark</th>
            <th className="bidcol aux">Bid</th>
            <th></th>
            <th className="bidcol aux">Bid</th><th className="aux">Mark</th>
            <th className="askcol">Ask</th>
            <th>model</th><th className="zerocol">→ 0</th>
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
            return (
              <tr
                key={k}
                ref={isAtm ? atmRow : undefined}
                className={[isAtm ? 'atm' : '', sellC || sellP ? 'sold' : ''].filter(Boolean).join(' ') || undefined}
              >
                <td className="dim aux">{num(c?.oi ?? null)}</td>
                <td className="dim aux">{num(c?.volume ?? null)}</td>
                <td className="aux"><Age min={c?.ageMin ?? null} /></td>
                <td className="aux">{n(c?.delta ?? null, 3)}</td>
                <td className="dim aux">{c?.iv != null ? (c.iv * 100).toFixed(1) : '·'}</td>
                <Zero leg={c} sold={sellC} />
                <td className="dim">{c?.pOtm != null ? (c.pOtm * 100).toFixed(0) + '%' : '·'}</td>
                <td className="askcol">{n(c?.ask ?? null)}</td>
                <td className="aux">{n(c?.mark ?? null)}</td>
                <td className={`bidcol aux${sellC ? ' sellcell' : ''}`}>{n(c?.bid ?? null)}</td>

                <td className="mono strikecell">
                  {k}
                  {isAtm && <span className="tag">ATM</span>}
                  {sellC && <span className="tag ok">SELL CE</span>}
                  {sellP && <span className="tag ok">SELL PE</span>}
                </td>

                <td className={`bidcol aux${sellP ? ' sellcell' : ''}`}>{n(p?.bid ?? null)}</td>
                <td className="aux">{n(p?.mark ?? null)}</td>
                <td className="askcol">{n(p?.ask ?? null)}</td>
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
        <b className="up">Bid</b> is what you receive when you <b>sell</b>.
        {' '}<b className="down">Ask</b> is what you pay when you <b>buy</b> — the hedge leg.
        {' '}Mark is Delta's fair value: use it to judge, never as your fill.
        {' '}<b className="up">→ 0</b> is the chance this strike expires worthless — the
        maths, corrected by what really happened to 27,371 strikes like it over 733
        days. <b>model</b> is the raw maths before that correction. A <b>*</b> means
        the history does not reach that far, so the nearest correction was used.
        Open interest and volume tell you whether you can get filled; they do not
        change these odds.
      </div>
      {!hasBook && (
        <div className="note" style={{ padding: '8px 12px', margin: '0 0 12px' }}>
          No order book on a historical snapshot — bid and ask are live-only, so the
          mark stands in as the sell estimate here.
        </div>
      )}
    </>
  );
}
