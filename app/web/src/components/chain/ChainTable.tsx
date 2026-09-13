import { useEffect, useRef } from 'react';
import type { Leg, SideRecommendation, SnapshotMeta } from '@/types/desk';
import { heldKey, type HeldLeg } from '@/lib/held';
import { signedInr, signedUsd, usdToInr } from '@/lib/format';
import { SIGNAL_LABEL, signalReason } from '@/lib/ev-view';

/**
 * Why a strike carries the pick mark.
 *
 * The settings that decide it -- the premium floor, the strike rule, the safety
 * bar -- came off the screen when the settings bar was cut to time and expiry.
 * They still decide, at whatever was last chosen, so the mark has to say so
 * somewhere or it is an assertion with no visible basis.
 */
const PICK_WHY =
  'The desk’s pick for this side, from the premium floor, the strike rule and '
  + 'the safety bar. Those are no longer controls on screen; they run at '
  + 'whatever was last set. See “What to sell”.';

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
 * What this strike is worth on average, for the lots set above the board.
 *
 * It sits beside the odds on purpose. A 99% strike paying $2 and a 94% strike
 * paying $40 look one way in the odds column and the other way here, and the
 * whole reason this column exists is that the probability alone calls the first
 * one better. See domain/ev.ts.
 */
function Ev({ leg, sold = false }: { leg: Leg | undefined; sold?: boolean }) {
  const v = leg?.ev?.evUsd ?? null;
  if (v == null) return <td className="evcol dim">—</td>;
  // `== null` on purpose: a leg may arrive with the field absent rather than
  // null -- an older server, or a past snapshot -- and `=== null` let an
  // undefined through into toFixed and took the whole board down with it.
  const per = leg?.ev?.evPerBtc;
  return (
    <td
      className={`evcol ${v >= 0 ? 'up' : 'down'}${sold ? ' sellcell' : ''}`}
      title={
        per == null
          ? undefined
          : 'Credit less the average payout of strikes like this one, after charges.' +
            ` $${per.toFixed(2)} per BTC.`
      }
    >
      {signedUsd(v)}
    </td>
  );
}

/**
 * Sell, watch or avoid — and, on a tap, which rule it is failing.
 *
 * A coloured cell with no reason behind it is a cell nobody can argue with, so
 * the whole eligibility list is one tap away rather than a tooltip a phone
 * cannot show.
 */
function SignalCell({
  leg, sold = false, onInspect,
}: {
  leg: Leg | undefined;
  sold?: boolean;
  onInspect?: () => void;
}) {
  if (!leg?.ev) return <td className="sigcol dim">—</td>;
  const s = leg.ev.signal;
  const label = SIGNAL_LABEL[s];
  const why = signalReason(leg);
  return (
    <td className={`sigcol sig-${s}${sold ? ' sellcell' : ''}`} title={why}>
      {onInspect ? (
        <button type="button" onClick={onInspect} aria-label={`${label} — why? ${why}`}>
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
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
      Delta lists only {c.above} strikes above and {c.below} below the price for this expiry
      {c.lowest !== null && c.highest !== null && <> ({c.lowest.toLocaleString()}–{c.highest.toLocaleString()})</>}.
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
  onInspect,
  maxSpreadPct,
  held,
  view = 'both',
  eligibleOnly = false,
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
   * Tapping a Signal cell asks for the whole picture on that strike.
   *
   * The board has room for six columns on a phone and the eligibility list is
   * nine rules long, so the reason a strike says Avoid cannot live in the cell.
   * A tooltip is not an answer either -- a phone has no hover.
   */
  onInspect?: (cp: 'C' | 'P', strike: number) => void;
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
   * Which half of the board to show.
   *
   * Both sides at once is 27 columns, and on a phone that is a board you swipe
   * rather than read. A seller is usually working one side at a time.
   */
  view?: 'calls' | 'puts' | 'both';
  /**
   * Hide the strikes the arithmetic refuses outright.
   *
   * Only `avoid` is hidden, never `watch`: at this distance almost every real
   * candidate is warned about for liquidity, and hiding those would empty the
   * board. The count of what was hidden is shown, because a filter that silently
   * removes rows is how someone concludes a strike does not exist.
   */
  eligibleOnly?: boolean;
  /**
   * The strikes currently held, keyed by `heldKey`. Absent on a historical
   * snapshot and on the read-only board, where "you are short this" would be a
   * claim about the wrong day.
   */
  held?: Map<string, HeldLeg>;
}) {
  const at = (k: number, cp: 'C' | 'P') => legs.find((l) => l.strike === k && l.cp === cp);
  const showCalls = view !== 'puts';
  const showPuts = view !== 'calls';

  const allStrikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const keeps = (k: number) => {
    if (!eligibleOnly) return true;
    const sides = [showCalls ? at(k, 'C') : undefined, showPuts ? at(k, 'P') : undefined];
    return sides.some((l) => l?.ev && l.ev.signal !== 'avoid');
  };
  const strikes = allStrikes.filter(keeps);
  const hidden = allStrikes.length - strikes.length;
  // visible columns each side of the strike: the odds, the raw model behind
  // them, and the ask -- plus the seven reference ones when they are showing
  // The odds either side of the strike, the raw model behind them, the offer,
  // and the bid. The bid is back in the default set: it is what a seller
  // actually receives, and now that the board marks which ones are too wide to
  // cross, it is the column you act on rather than a reference figure.
  // Must match what is actually rendered. Signal and EV are always on -- they
  // are the two columns the decision is read from -- so the default set is six
  // and the full set thirteen. A colSpan that over-claims reserves width for
  // columns that are not there, which is how the calls bid got pushed off the
  // left edge of a phone once.
  const perSide = density === 'all' ? 12 : 6;

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
  const inspect = (leg: Leg | undefined, cp: 'C' | 'P', k: number) =>
    onInspect && leg ? () => onInspect(cp, k) : undefined;
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
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    const b = box.current, r = atmRow.current;
    if (!b || !r) return;
    // The strike sits in the middle of the table, calls to its left and puts to
    // its right. On a phone the table is wider than the screen, and opening at
    // either edge shows one side of the board with the strike off-screen -- so
    // centre it, and both bids are a short swipe away.
    b.scrollLeft = Math.max(0, (b.scrollWidth - b.clientWidth) / 2);
    /*
     * Down the page only when you changed the expiry or the columns.
     *
     * Scrolling on first load dropped a phone straight into the middle of the
     * chain, past the settings and the card that says what to sell -- and doing
     * it whenever the at-the-money strike moved yanked the page away from
     * whatever you were reading every time BTC crossed a strike.
     */
    const key = `${snap.expiry}|${density}`;
    if (shownFor.current !== null && shownFor.current !== key) r.scrollIntoView?.({ block: 'center' });
    shownFor.current = key;
  }, [snap.atm, snap.expiry, density]);

  return (
    <>
    <Coverage snap={snap} />
    {hidden > 0 && (
      <div className="note" style={{ padding: '8px 12px', margin: 0 }}>
        {hidden} {hidden === 1 ? 'strike is' : 'strikes are'} hidden — the arithmetic refuses
        {' '}{hidden === 1 ? 'it' : 'them'} outright. Turn off <b>Eligible only</b> to see the
        whole board.
      </div>
    )}
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
            {showCalls && <th colSpan={perSide} className="left ce">CALLS</th>}
            <th>STRIKE</th>
            {showPuts && <th colSpan={perSide} className="left pe">PUTS</th>}
          </tr>
          <tr>
            {showCalls && (
              <>
                <th className="aux">OI</th><th className="aux">Vol</th><th className="aux">V/OI</th>
                <th className="aux">Δ</th><th className="aux">IV</th>
                <th className="sigcol">Signal</th><th className="evcol">EV</th>
                <th className="zerocol">→ 0</th><th>Model</th>
                <th className="askcol">Ask</th><th className="aux">Mark</th>
                <th className="bidcol">Bid</th>
              </>
            )}
            <th></th>
            {showPuts && (
              <>
                <th className="bidcol">Bid</th><th className="aux">Mark</th>
                <th className="askcol">Ask</th>
                <th>Model</th><th className="zerocol">→ 0</th>
                <th className="evcol">EV</th><th className="sigcol">Signal</th>
                <th className="aux">IV</th><th className="aux">Δ</th>
                <th className="aux">V/OI</th><th className="aux">Vol</th><th className="aux">OI</th>
              </>
            )}
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
                {showCalls && (
                  <>
                    <td className="dim aux">{num(c?.oi ?? null)}</td>
                    <td className="dim aux">{num(c?.volume ?? null)}</td>
                    <td className="dim aux">{c?.ev?.volumeToOi != null ? (c.ev.volumeToOi * 100).toFixed(1) + '%' : '·'}</td>
                    <td className="aux">{n(c?.delta ?? null, 3)}</td>
                    <td className="dim aux">{c?.iv != null ? (c.iv * 100).toFixed(1) : '·'}</td>
                    <SignalCell leg={c} sold={sellC} onInspect={inspect(c, 'C', k)} />
                    <Ev leg={c} sold={sellC} />
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
                  </>
                )}

                <td className="mono strikecell">
                  {onInspect
                    ? (
                      <button
                        type="button"
                        className="strikebtn"
                        onClick={() => onInspect(c ? 'C' : 'P', k)}
                        aria-label={`what is at strike ${k}`}
                      >
                        {k}
                      </button>
                    )
                    : k}
                  {isAtm && <span className="tag">ATM</span>}
                  {heldC && <HeldChip held={heldC} />}
                  {heldP && <HeldChip held={heldP} />}
                  {/*
                    Quiet, and it says what it rests on. The premium floor, the
                    strike rule and the safety bar are no longer controls on
                    screen, so a loud "SELL CE" asserts a recommendation whose
                    inputs a reader cannot see. The mark stays -- the pick has to
                    be findable on the board it came from -- but it is a mark,
                    not a headline.
                  */}
                  {sellC && !heldC && (
                    <span className="tag pick" title={PICK_WHY}>CE</span>
                  )}
                  {sellP && !heldP && (
                    <span className="tag pick" title={PICK_WHY}>PE</span>
                  )}
                </td>

                {showPuts && (
                  <>
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
                    <Ev leg={p} sold={sellP} />
                    <SignalCell leg={p} sold={sellP} onInspect={inspect(p, 'P', k)} />
                    <td className="dim aux">{p?.iv != null ? (p.iv * 100).toFixed(1) : '·'}</td>
                    <td className="aux">{n(p?.delta ?? null, 3)}</td>
                    <td className="dim aux">{p?.ev?.volumeToOi != null ? (p.ev.volumeToOi * 100).toFixed(1) + '%' : '·'}</td>
                    <td className="dim aux">{num(p?.volume ?? null)}</td>
                    <td className="dim aux">{num(p?.oi ?? null)}</td>
                  </>
                )}
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
        {' '}<b>EV</b> = that credit less the average payout, after charges — a 99% strike paying
        $2 can still be negative.
        {onInspect && <> <b>Tap a strike</b> for everything known about it — both sides, the money and every rule it passes or fails.</>}
        {' '}A <b className="up">CE</b> or <b className="up">PE</b> mark beside a strike is the
        desk’s pick for that side.
        {' '}Signal and EV are for information: neither has been tested across 2024, 2025 and
        2026, and nothing on the trading side reads them.
      </div>
      {!hasBook && (
        <div className="note" style={{ padding: '8px 12px', margin: '0 0 12px' }}>
          Past date: no bid or ask, so the mark is used as the sell price.
        </div>
      )}
    </>
  );
}
