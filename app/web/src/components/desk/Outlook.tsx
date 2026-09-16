import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, MoveRight, Sigma } from 'lucide-react';
import type { Outlook as OutlookData, OutlookRow } from '@/types/desk';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { strike as fmtStrike } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Where BTC could be, horizon by horizon.
 *
 * Three questions are kept apart on this desk, and this card answers only the
 * first:
 *
 *   prediction    where BTC may move            — here
 *   options risk  touch / expiry / near-zero    — the strike sheet
 *   eligibility   will the desk take the trade  — the ticket's gates
 *
 * ## What each card says, and why it does not say more
 *
 * **The band** is the option market's own price of that horizon:
 * `S × IV × √(t/365d)`. Beside it, what BTC actually did over 105,119 measured
 * windows — so a band that is wider than the history is the market paying for
 * more move than it usually gets, which is the seller's whole business.
 *
 * **The three bars are Below, Inside and Above that band** — from the measured
 * distribution, not from a view. They are not "down 52%, up 10%": the desk
 * measured the direction and it is a coin flip at every horizon (49.4% up at
 * five minutes, 50.6% at twelve hours, never outside 48–52%). A card that
 * printed a directional probability would be printing an invention, so this one
 * prints the measurement instead, on its face.
 *
 * **The arrow is a score, not a forecast** — where that timeframe's own EMAs,
 * RSI, VWAP and swing structure point, −1…+1. Only the timeframes the desk
 * fetches bars for can have one; the rest say so and keep their bands.
 */
export function Outlook({ outlook }: { outlook: OutlookData }) {
  const [showMaths, setShowMaths] = useState(false);
  const { consensus } = outlook;

  return (
    <Card className="outlook">
      <CardTitle
        right={
          <button type="button" className="chain-chip" onClick={() => setShowMaths((v) => !v)}>
            <Sigma size={12} aria-hidden /> {showMaths ? 'Hide the maths' : 'How this is worked out'}
          </button>
        }
      >
        What the next few hours could do
      </CardTitle>

      <div className="ol-summary">
        {/*
          Spot, once.
          It was on every card -- ten identical numbers, because the measured
          drift over these horizons is nil and there is no honest projection to
          put in its place. Nine repetitions of the same price read as a broken
          panel; said once, with each card carrying only its own band, the row
          says what it actually knows.
        */}
        <span className="ol-spot">
          <b>{fmtStrike(Math.round(outlook.rows[0]?.spot ?? 0))}</b>
          <span className="dim"> now · each card is the band around it</span>
        </span>
        <span className="ol-consensus">
          {consensus === null ? (
            <span className="dim">No timeframe could be read</span>
          ) : (
            <>
              <b className={cn(consensus > 0.3 ? 'up' : consensus < -0.3 ? 'down' : undefined)}>
                {consensus >= 0 ? '+' : '−'}{Math.abs(consensus).toFixed(2)}
              </b>
              <span className="dim"> weighted across the timeframes with bars · {outlook.agreement}</span>
            </>
          )}
        </span>
        {outlook.directionEdgePts !== null && (
          <Badge tone="neutral">
            direction measured: within {outlook.directionEdgePts.toFixed(1)} points of a coin flip
          </Badge>
        )}
      </div>

      {showMaths && (
        <div className="ol-maths" aria-label="how this is worked out">
          <Row n="1" title="Expected move, per horizon">
            <code>EM(t) = spot × IV × √(t ÷ 365d)</code>
            <span>The option market's price of that horizon. The band is spot ∓ EM(t).</span>
          </Row>
          <Row n="2" title="Where the band sits in what really happened">
            <code>below = F(−EM%), above = 1 − F(+EM%), inside = 1 − below − above</code>
            <span>
              F is the measured distribution of returns over {outlook.sampleWindows?.toLocaleString('en-IN') ?? 'a year of'} windows.
              Inside above 68% means the market is charging for more move than it usually gets.
            </span>
          </Row>
          <Row n="3" title="The timeframe's own reading">
            <code>score = 0.5·EMA stack + 0.2·RSI + 0.2·structure + 0.1·VWAP</code>
            <span>−1 to +1, over whatever that timeframe can be read from. A reading of the tape, not a probability.</span>
          </Row>
          <Row n="4" title="Consensus">
            <code>Σ wₜ · scoreₜ ÷ Σ wₜ</code>
            <span>5m 5% · 15m 10% · 30m 10% · 1h 15% · 2h 10% · 4h 15% · 6h 10% · 12h 15% · 24h 10%, over the horizons with bars.</span>
          </Row>
          <Row n="5" title="What is deliberately absent">
            <code>P(up) ≈ 0.50 at every horizon</code>
            <span>
              Measured, not assumed. Cumulative delta and funding are not here either — the desk fetches
              neither, and a number that looks like order flow and is not would be worse than the gap.
            </span>
          </Row>
        </div>
      )}

      <div className="ol-grid" aria-label="horizons">
        {outlook.rows.map((r) => <Horizon key={r.label} row={r} />)}
      </div>
    </Card>
  );
}

function Row({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="ol-maths-row">
      <span className="ol-maths-n">{n}</span>
      <div>
        <div className="ol-maths-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function Horizon({ row }: { row: OutlookRow }) {
  const Arrow = row.score === null ? MoveRight
    : row.lean === 'bullish' ? ArrowUpRight
      : row.lean === 'bearish' ? ArrowDownRight
        : MoveRight;
  const tone = row.lean === 'bullish' ? 'up' : row.lean === 'bearish' ? 'down' : undefined;
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

  return (
    <div className={cn('ol-card', row.isExpiry && 'expiry')} aria-label={row.label}>
      <div className="ol-label">{row.label}</div>

      {/*
        The band, and then the one number that moves across the row.

        Below/inside/above are near-constant by construction: the implied band
        and the measured one both scale with √t, so their ratio hardly changes
        and nine cards reading "16 / 69 / 15" say nothing. What does change is
        the two bands against each other -- 1.00 at five minutes and 0.88 at
        twelve hours on 16 September, which is the market charging *less* than
        history delivers at the long end. For a seller that is the question.
      */}
      <div className="ol-mid">
        {row.low === null || row.high === null
          ? <span className="dim">no band</span>
          : `${fmtStrike(Math.round(row.low))} – ${fmtStrike(Math.round(row.high))}`}
      </div>
      <div className={cn('ol-priced', row.priced)}>
        {row.richness === null
          ? <span className="dim">nothing to compare</span>
          : <>
            {row.richness.toFixed(2)}× history
            <span className="ol-priced-word">
              {row.priced === 'rich' ? 'market pays more' : row.priced === 'cheap' ? 'market pays less' : 'fairly priced'}
            </span>
          </>}
      </div>

      {/*
        The arrow is the timeframe's own reading. Where the desk has no bars at
        that horizon there is no reading, and the card says so rather than
        drawing a sideways arrow that looks like a considered "flat".
      */}
      <div className={cn('ol-arrow', tone)} title={row.why}>
        {row.score === null
          ? <span className="dim">not read</span>
          : <><Arrow className="h-3.5 w-3.5" aria-hidden />{row.score >= 0 ? '+' : '−'}{Math.abs(row.score).toFixed(2)}</>}
      </div>

      {/*
        Below / inside / above the band — measured, never a direction. The
        middle row is the one a seller reads: how often a year of BTC finished
        inside what the market is charging for.
      */}
      <dl className="ol-odds">
        <div>
          <dt>Below</dt>
          <dd className="down">{pct(row.below)}</dd>
        </div>
        <div>
          <dt>Inside</dt>
          <dd className={cn(row.inside !== null && row.inside >= 0.68 && 'up')}>{pct(row.inside)}</dd>
        </div>
        <div>
          <dt>Above</dt>
          <dd className="up">{pct(row.above)}</dd>
        </div>
      </dl>

      {row.measured68Pct !== null && (
        <div className="ol-measured" title="What BTC actually did over this horizon, two thirds of the time.">
          history ±{row.measured68Pct.toFixed(2)}%
        </div>
      )}
    </div>
  );
}
