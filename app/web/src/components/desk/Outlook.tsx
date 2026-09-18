import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronDown, Info, MoveHorizontal, MoveRight, Sigma, Zap } from 'lucide-react';
import type {
  ChainContext, Containment, DirectionVerdict, MeasuredRow, OptionStructure,
  Outlook as OutlookData, OutlookRow,
} from '@/types/desk';
import { SideVerdict } from '@/components/desk/SideVerdict';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { strike as fmtStrike } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePersisted } from '@/hooks/usePersisted';

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
export function Outlook({ outlook, direction, containment, structure }: {
  outlook: OutlookData;
  /** The verdict drawn from the same indicators, at the head of the row. */
  direction?: DirectionVerdict;
  containment?: Containment | null;
  /** The board, for the readings that have no history to be measured against yet. */
  structure?: OptionStructure | null;
}) {
  const [showMaths, setShowMaths] = useState(false);
  // Folded, the header and its lean box stay: the answer without the working.
  // Remembered, like every other card -- ten cards are a long scroll on a phone.
  const [open, setOpen] = usePersisted<boolean>('open:outlook', true);
  const { consensus } = outlook;
  // The measured cards when the analytics service answered; the desk's own otherwise.
  const measured = outlook.rows.some((r) => r.measured);

  return (
    <Card className="outlook">
      {/*
        The header carries the answer as well as the question: the overall
        lean sits in its own box at the top right, where the eye lands after
        the title, and the verdict line under it says why.
      */}
      <div className={cn('ol-header', !open && 'folded')}>
        <button
          type="button"
          className="ol-fold"
          aria-expanded={open}
          aria-label={open ? 'fold the outlook' : 'open the outlook'}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown size={16} aria-hidden className={cn(!open && '-rotate-90')} />
        </button>
        <span className="ol-bolt" aria-hidden><Zap size={20} /></span>
        <div className="ol-heading">
          <h2 className="ol-title">How far could BTC move, and when</h2>
          <p className="ol-sub">Based on the charts, volume, volatility and the option board</p>
        </div>
        <div className="ol-header-right">
          {open && (
            <button type="button" className="chain-chip" onClick={() => setShowMaths((v) => !v)}>
              <Sigma size={12} aria-hidden /> {showMaths ? 'Hide the maths' : 'How this is worked out'}
            </button>
          )}
          {direction && <LeanBox direction={direction} />}
        </div>
      </div>

      {open && <>
      {direction && (
        <SideVerdict direction={direction} containment={containment ?? null} embedded />
      )}

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
          <span className="dim"> now · each card shows how far it could move from here</span>
        </span>
        <span className="ol-consensus">
          {consensus === null ? (
            <span className="dim">No timeframe could be read</span>
          ) : (
            <>
              {/*
                Words, not a signed decimal. "+0.19 overall lean" had to be
                explained twice on 17 September; "Charts: 3 of 5 up" does not.
                The number stays on hover for anyone who wants it.
              */}
              <b
                className={cn(consensus > 0.3 ? 'up' : consensus < -0.3 ? 'down' : undefined)}
                title={`Weighted chart score ${consensus >= 0 ? '+' : '−'}${Math.abs(consensus).toFixed(2)}, from −1 (down) to +1 (up).`}
              >
                Charts: {plainAgreement(outlook.agreement)}
              </b>
              <span className="dim"> · recent trend, not a forecast</span>
            </>
          )}
        </span>
        {measured ? (
          <Badge tone="neutral">
            Measured, not guessed: a lean shows only when it held in 2024, 2025 and 2026
          </Badge>
        ) : outlook.directionEdgePts !== null && (
          <Badge tone="neutral">
            Up or down? History says it is a coin toss (within {outlook.directionEdgePts.toFixed(1)} points of 50/50)
          </Badge>
        )}
      </div>

      {!measured && (
        <p className="ol-howto">
          <b>How to read a card:</b> <b>±$</b> how far BTC could move · <b>Stays in range</b> how often it did ·{' '}
          <b>Premium</b> fair, high or low for that risk · <b>Chart</b> the recent trend, not a forecast
        </p>
      )}

      {showMaths && (
        <div className="ol-maths" aria-label="how this is worked out">
          {measured && (
            <>
              <div className="ol-maths-group">The measured cards</div>
              <Row n="1" title="Expected move, per horizon">
                <code>EMₜ = Spot × IV × √(t ÷ 365d)</code>
                <span>What the option market charges for that horizon.</span>
              </Row>
              <Row n="2" title="Why no formula can call the direction">
                <code>Sₜ ~ LogNormal(μ, σ²t), μ = −½σ²  ⇒  P(up) = N(−½σ√t) ≈ 50%</code>
                <span>The risk-neutral price distribution is balanced by construction, and the desk measured the same: up and down are near even at every horizon.</span>
              </Row>
              <Row n="3" title="Side, Down and Up">
                <code>τₕ = tercile of |returnₕ|;  Side = |r| ≤ τₕ,  Down = r &lt; −τₕ,  Up = r &gt; τₕ</code>
                <span>With no information the split is 33 / 33 / 33, so any lean away from it is what the state now is worth.</span>
              </Row>
              <Row n="4" title="The state now">
                <code>momentum over h vs τₕ · RSI(14) · EMA 9/21/50 stack — closed bars only</code>
                <span>Labelled with the same code that labelled 280,326 five-minute bars of history, so the live card and the measurement cannot disagree.</span>
              </Row>
              <Row n="5" title="What is shown">
                <code>P(Down), P(Side), P(Up) = counted outcomes for that state</code>
                <span>Kept only if it pointed the same way in 2024, 2025 and 2026 by 3+ points, with z &gt; 3 on non-overlapping windows. A side that held without a lean shows Down and Up split evenly; nothing held shows the unconditional split.</span>
              </Row>
              <Row n="6" title="Price and range">
                <code>price = spot × (1 + median return);  range = 16th – 84th percentile</code>
                <span>The price moves off spot only on a lean that held; the range narrows only on a calmer state that held.</span>
              </Row>
              <div className="ol-maths-group">The desk's own figures (shown when the model is away)</div>
            </>
          )}
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
        {outlook.rows.map((r) => (r.measured ? <MeasuredHorizon key={r.label} row={r} m={r.measured} /> : <Horizon key={r.label} row={r} />))}
      </div>

      <MarketContext context={outlook.context ?? []} structure={structure ?? null} />
      </>}
    </Card>
  );
}

/**
 * The overall lean, boxed: the words first, the signed score beside them.
 *
 * The same score the verdict line reads -- moved up here so the number is
 * found where the eye lands, not at the end of a sentence.
 */
function LeanBox({ direction }: { direction: DirectionVerdict }) {
  const { score, side, confirmed } = direction;
  const tone = side === 'bullish' ? 'up' : side === 'bearish' ? 'down' : undefined;
  const words = side === null ? 'No clear lean' : side === 'bullish' ? 'Leaning up' : 'Leaning down';
  return (
    <div className="ol-lean" aria-label="overall lean">
      <div className="ol-lean-words">
        <span
          className="ol-lean-label"
          title="The charts’ weighted score, from −1 (down) to +1 (up). Past ±0.45 it names a side; four of the five checks agreeing confirms it. A reading of the tape, not a forecast."
        >
          Overall lean <Info size={12} aria-hidden />
        </span>
        <small className={cn(tone)}>{words}{confirmed ? ' · confirmed' : ''}</small>
      </div>
      <b className={cn('ol-lean-score', tone)} aria-label="direction score">
        {score === null ? '—' : `${score < 0 ? '−' : '+'}${Math.abs(score).toFixed(2)}`}
      </b>
    </div>
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

/**
 * A horizon card in the shape of the reference: the price, the range, the
 * arrow, and Down / Side / Up with the largest lit.
 *
 * Every figure is measured -- counted from what followed moments like this one
 * in 280,326 five-minute bars -- and the arrow appears only when a lean held in
 * all three years. Where nothing held the card says so in words instead of
 * leaving a sideways arrow to be read as a considered "flat".
 */
function MeasuredHorizon({ row, m }: { row: OutlookRow; m: MeasuredRow }) {
  const Arrow = m.arrow === 'up' ? ArrowUpRight : m.arrow === 'down' ? ArrowDownRight : MoveHorizontal;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  // The settlement card reads the reference's way: where it finishes against the band.
  const odds = [
    { key: 'down', label: row.isExpiry ? 'Below' : 'Down', value: m.pDown },
    { key: 'side', label: row.isExpiry ? 'Within' : 'Side', value: m.pSide },
    { key: 'up', label: row.isExpiry ? 'Above' : 'Up', value: m.pUp },
  ] as const;
  /*
   * Lit: the larger of the outcomes that *held*, never simply the largest.
   *
   * Lighting the largest put a green "Up 35%" beside "nothing held" on the long
   * horizons -- the sample's overall drift, which failed the year-by-year test --
   * and a red "Down 36%" on a card whose Down and Up were split evenly because
   * only its calm held. A lit row reads as a call, so only a measured call lights.
   */
  const held: { key: 'down' | 'side' | 'up'; value: number }[] = [];
  if (m.basis?.leanHolds && m.arrow !== 'flat') held.push(m.arrow === 'up' ? { key: 'up', value: m.pUp } : { key: 'down', value: m.pDown });
  // Side lights only as *calmer*. A livelier reading held too, but it means less
  // likely to stay in range -- lighting Side for it says the opposite -- so the
  // word under the card carries it instead.
  if (m.basis?.sideHolds && m.calm === 'calmer') held.push({ key: 'side', value: m.pSide });
  const top = held.length ? held.reduce((a, b) => (b.value > a.value ? b : a)).key : null;
  const title = row.isExpiry ? `By expiry · ${(row.minutes / 60).toFixed(1)}h` : row.label;
  const why = m.basis
    ? `${m.basis.words}${m.calm ? ` · ${m.calm}` : ''}`
    : 'no lean held — about even';

  return (
    <div className={cn('ol-card ol-mcard', row.isExpiry && 'expiry')} aria-label={row.label}>
      <div className="ol-top">
        <div className="ol-label">{title}</div>
        <span
          className={cn('ol-mc-arrow', m.arrow)}
          role="img"
          aria-label={m.arrow === 'flat' ? 'no lean that held' : `leans ${m.arrow}, measured`}
        >
          <Arrow className="h-4 w-4" aria-hidden />
        </span>
      </div>

      <div className="ol-mc-price">{fmtStrike(Math.round(m.projected))}</div>
      <div className="ol-mid">{fmtStrike(Math.round(m.low))} – {fmtStrike(Math.round(m.high))}</div>

      <dl className="ol-odds ol-mc-odds" aria-label="down, side and up, measured">
        {odds.map((o) => (
          <div key={o.key} className={cn(o.key, o.key === top && 'top')}>
            <dt>{o.label}</dt>
            <dd>{pct(o.value)}</dd>
          </div>
        ))}
      </dl>

      {/*
        Where "Side" ends, on the card's face. It is the middle third of what
        BTC did over this horizon -- ±0.1% at five minutes -- so 33 / 33 / 33 is
        the no-information answer. The sudden-move panel's Sideways is ±1%, and
        without this line the two read as a contradiction.
      */}
      <div className="ol-mc-band">
        {row.isExpiry ? 'Within' : 'Side'} = ±${Math.round(m.sideBandUsd).toLocaleString('en-US')} ({m.sideBandPct.toFixed(2)}%)
      </div>

      <div
        className="ol-mc-why"
        title={`Side means finishing within ±$${Math.round(m.sideBandUsd).toLocaleString('en-IN')} (±${m.sideBandPct.toFixed(2)}%). `
          + `Counted over ${m.windows.toLocaleString('en-IN')} windows${m.measuredMinutes !== row.minutes ? `, answered from the ${m.measuredMinutes}-minute horizon` : ''}.`}
      >
        {why}
      </div>
    </div>
  );
}

const CHAIN_LABEL: Record<string, string> = {
  implied_move: 'Implied move',
  skew: 'Skew (puts vs calls)',
  pcr_volume: 'Put/call volume',
};

/** The reading in the units it was measured in. */
export function chainValue(feature: string, value: number | null): string {
  if (value === null) return '—';
  if (feature === 'implied_move') return `${value.toFixed(2)}%`;
  if (feature === 'skew') return `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(0)}%`;
  // a log ratio: 0.69 is twice as many puts as calls
  return `${Math.exp(value).toFixed(2)}× puts`;
}

/**
 * The option board, and how far each reading is allowed to speak.
 *
 * Asked on 17 September to use OI, volume, ΔOI, IV, skew and PCR for the
 * prediction. Three of them had a history to be tested against — chain.db holds
 * 735 mornings of marks and volume at 05:30 and the settle twelve hours later —
 * and of those only a large implied move held, and only about *how far*, never
 * which way. So the board shows here, in full, with what each reading is: a
 * measured one that held, a measured one that did not, or one nobody can
 * measure yet because the desk has only been recording it since 17 September.
 *
 * The rule the strip exists to keep: a figure on a card above moved only if the
 * service used a reading that held. Everything else on this line is context.
 */
function MarketContext({ context, structure }: { context: ChainContext[]; structure: OptionStructure | null }) {
  const unmeasured: { label: string; value: string }[] = [];
  if (structure) {
    if (structure.pcrOi !== null) unmeasured.push({ label: 'Put/call open interest', value: structure.pcrOi.toFixed(2) });
    if (structure.ivSkewPts !== null) unmeasured.push({ label: 'IV skew', value: `${structure.ivSkewPts >= 0 ? '+' : '−'}${Math.abs(structure.ivSkewPts).toFixed(1)} pts` });
    // The walls within reach, as the summary draws them; the whole-board pair is noise here.
    if (structure.ceOiWallNear && structure.peOiWallNear) {
      unmeasured.push({ label: 'OI walls', value: `${fmtStrike(structure.peOiWallNear.strike)} – ${fmtStrike(structure.ceOiWallNear.strike)}` });
    }
    if (structure.maxPain) unmeasured.push({ label: 'Max pain', value: fmtStrike(structure.maxPain.strike) });
  }
  if (!context.length && !unmeasured.length) return null;

  return (
    <section className="ol-ctx" aria-label="market context">
      <div className="ol-ctx-title">
        The option board — and what it is measured to be worth
      </div>
      <div className="ol-ctx-row">
        {context.map((c) => {
          const held = c.leanHolds || c.sideHolds;
          return (
            <div key={c.feature} className={cn('ol-ctx-chip', held && 'held')} aria-label={CHAIN_LABEL[c.feature] ?? c.feature}>
              <span className="ol-ctx-label">{CHAIN_LABEL[c.feature] ?? c.feature}</span>
              <b className="ol-ctx-value">{chainValue(c.feature, c.value)}</b>
              <span className="ol-ctx-words">{c.words ?? 'nothing to read'}</span>
              <span
                className={cn('ol-ctx-badge', held && 'ok')}
                title={c.windows ? `Counted over ${c.windows.toLocaleString('en-IN')} mornings, 2024–2026.` : undefined}
              >
                {!c.measured ? 'not measured'
                  : held ? `counts — ${c.calm === 'calmer' ? 'calmer to settlement' : c.calm === 'livelier' ? 'livelier to settlement' : 'leans'}`
                    : 'measured · did not hold'}
              </span>
            </div>
          );
        })}
        {unmeasured.map((u) => (
          <div key={u.label} className="ol-ctx-chip" aria-label={u.label}>
            <span className="ol-ctx-label">{u.label}</span>
            <b className="ol-ctx-value">{u.value}</b>
            <span className="ol-ctx-words">shown, not counted</span>
            <span className="ol-ctx-badge" title="The desk has recorded this every five minutes since 17 September 2026; a year of it can be measured the way the candles were.">
              no history yet
            </span>
          </div>
        ))}
      </div>
      <p className="ol-ctx-foot">
        Only a reading that held in 2024, 2025 and 2026 moves a figure above — measured over 735 mornings,
        that is a large implied move, and it says how far, never which way. The rest is the board as it is.
      </p>
    </section>
  );
}

/** "3 of 5 bullish, 1 flat" → "3 of 5 up, 1 flat": the words people use. */
export const plainAgreement = (agreement: string): string =>
  agreement.replace(/bullish/g, 'up').replace(/bearish/g, 'down');

/** "up · strong", "up", "flat", "down" — the chart in words; the score stays on hover. */
export function chartWords(row: Pick<OutlookRow, 'score' | 'lean'>): string {
  if (row.score === null) return 'no chart';
  const strong = Math.abs(row.score) >= 0.6 ? ' · strong' : '';
  if (row.lean === 'bullish') return `Chart up${strong}`;
  if (row.lean === 'bearish') return `Chart down${strong}`;
  return 'Chart flat';
}

function Horizon({ row }: { row: OutlookRow }) {
  const Arrow = row.lean === 'bullish' ? ArrowUpRight : row.lean === 'bearish' ? ArrowDownRight : MoveRight;
  const tone = row.lean === 'bullish' ? 'up' : row.lean === 'bearish' ? 'down' : undefined;
  const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

  /*
   * The card reads top to bottom the way the question is asked: which horizon
   * and which way the chart leans, how far, between what, whether options are
   * cheap or dear for it, and where BTC usually finishes against that.
   *
   * It used to lead with the range, then a two-line uppercase sentence, then
   * the score, then three long labels -- every figure honest and the card still
   * hard to read at a glance. The figures are the same; the order and the
   * weight are what changed.
   */
  const odds: { key: 'below' | 'inside' | 'above'; label: string; value: number | null; cls?: string }[] = [
    { key: 'below', label: 'Falls below', value: row.below, cls: 'down' },
    // Only marked when the band holds more than two thirds of history: that
    // is the market charging for more move than it usually gets.
    { key: 'inside', label: 'Stays in range', value: row.inside, cls: row.inside !== null && row.inside >= 0.68 ? 'up' : undefined },
    { key: 'above', label: 'Rises above', value: row.above, cls: 'up' },
  ];
  const known = odds.filter((o) => o.value !== null);
  const top = known.length ? known.reduce((a, b) => (b.value! > a.value! ? b : a)).key : null;
  // For a seller: high means paid more than the usual risk, low means paid less.
  const pricedWord = row.priced === 'rich' ? 'high' : row.priced === 'cheap' ? 'low' : 'fair';
  const pricedSentence = row.priced === 'rich' ? 'a seller is paid more than the usual risk'
    : row.priced === 'cheap' ? 'a seller is paid less than the usual risk' : 'about the usual risk'

  return (
    <div className={cn('ol-card', row.isExpiry && 'expiry')} aria-label={row.label}>
      <div className="ol-top">
        <div className="ol-label">{row.label}</div>
        {/*
          The timeframe's own reading. Where the desk has no bars at that
          horizon there is no reading, and the card says so rather than drawing
          a sideways arrow that looks like a considered "flat".
        */}
        {/* Settlement is not a chart horizon, so it has no reading to be missing --
            and the note cost its label: "TO SETTLEMEN…". */}
        {row.score === null
          ? (row.isExpiry ? null : <span className="ol-arrow none" title="The desk fetches no candles at this timeframe, so there is no chart to read.">no chart</span>)
          : (
            <div
              className={cn('ol-arrow', tone)}
              title={`Chart score ${row.score >= 0 ? '+' : '−'}${Math.abs(row.score).toFixed(2)} (−1 down … +1 up): ${row.why}. `
                + 'What the candles have done, not where BTC goes next.'}
            >
              <Arrow className="h-4 w-4" aria-hidden />
              {chartWords(row)}
            </div>
          )}
      </div>

      {/* How far: the option market's own price of this horizon. */}
      <div className="ol-move">
        {row.impliedUsd === null ? <span className="dim">can’t price it</span> : `±$${Math.round(row.impliedUsd).toLocaleString('en-IN')}`}
      </div>
      {row.low !== null && row.high !== null && (
        <div className="ol-mid">{fmtStrike(Math.round(row.low))} – {fmtStrike(Math.round(row.high))}</div>
      )}

      {row.richness === null
        ? <div className="ol-chip"><span className="dim">nothing to compare</span></div>
        : (
          <div
            className={cn('ol-chip', row.priced)}
            title={`Options charge ${row.richness.toFixed(2)}× the move BTC usually makes here — ${pricedSentence}.`}
          >
            Premium: {pricedWord}
          </div>
        )}

      {/*
        Below / in range / above the band -- measured, never a direction. The
        largest is highlighted the way a gauge shows its reading; it is almost
        always "in range", which is the seller's figure.
      */}
      <dl className="ol-odds" aria-label="where BTC usually ends up, against this range">
        {odds.map((o) => (
          <div key={o.key} className={cn(o.key === top && 'top', o.key === top && o.cls)}>
            <dt>{o.label}</dt>
            <dd className={o.cls}>{pct(o.value)}</dd>
          </div>
        ))}
      </dl>

      {row.measured68Pct !== null && (
        <div className="ol-measured" title="What BTC actually did over this horizon, two thirds of the time.">
          usually ±${Math.round((row.spot * row.measured68Pct) / 100).toLocaleString('en-IN')}
        </div>
      )}
    </div>
  );
}
