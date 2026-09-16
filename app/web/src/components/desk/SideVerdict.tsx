import { useState } from 'react';
import { Check, Minus, X, TrendingUp, TrendingDown, PauseCircle } from 'lucide-react';
import type { Containment, DirectionVerdict } from '@/types/desk';
import { Card, CardTitle } from '@/components/ui/card';
import { pct } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * A signed reading, with the desk's minus sign.
 *
 * A hyphen where every other number on this screen carries a proper minus is
 * the kind of difference nobody names and everybody notices.
 */
const signed = (v: number | null, places = 2) =>
  v === null ? '—' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(places)}`;


/**
 * Is there a side today, and would the desk's gates take it?
 *
 * The board showed five windows — 24h +0.25%, 12h −0.13%, 6h −0.15%, 1h
 * −0.16%, 15m +0.27% — and left the adding-up to somebody at half past five in
 * the morning. Five facts are not a decision. This is the adding-up, with every
 * input it used, so the number can be argued with rather than believed.
 *
 * **It decides nothing.** The lots are still split by the tested 70/30 rule,
 * which has a 733-day record; this is the reading a person does before trusting
 * that split. The most common answer is *no side*, and that is the answer it was
 * built to give: a screen that names a direction every morning has not measured
 * anything.
 *
 * Four of five gates and a score past the bar is a confirmation. A gate with
 * nothing to read is never a pass — the same rule the sudden-move gate follows,
 * because an unread risk is not a small one.
 */
export function SideVerdict({ direction, containment, embedded = false }: {
  direction: DirectionVerdict;
  containment: Containment | null;
  /**
   * At the head of the horizon row rather than a card of its own. The two
   * read the same indicators and said it twice a screen apart; here the
   * verdict is the sentence the row below is the working for.
   */
  embedded?: boolean;
}) {
  const { score, side, confirmed } = direction;
  const tone = side === null ? 'wait' : side === 'bullish' ? 'up' : 'down';
  const Icon = side === null ? PauseCircle : side === 'bullish' ? TrendingUp : TrendingDown;
  const [showWorking, setShowWorking] = useState(false);

  const body = (
    <>

      <div className="sv-head">
        <span
          className={cn(
            'sv-badge',
            tone === 'up' && 'up',
            tone === 'down' && 'down',
            confirmed && 'confirmed',
          )}
        >
          <Icon className="h-4 w-4 flex-none" aria-hidden />
          {side === null ? 'No side' : side === 'bullish' ? 'Bullish' : 'Bearish'}
          {confirmed && <span className="sv-tick">confirmed</span>}
        </span>
        <span className="sv-score" aria-label="direction score">
          {signed(score)}
        </span>
      </div>
      <p className="sv-summary">
        {direction.summary}
        {embedded && (
          <button type="button" className="sv-toggle" onClick={() => setShowWorking((v) => !v)} aria-expanded={showWorking}>
            {showWorking ? 'hide the working' : `${direction.passed}/5 gates · show the working`}
          </button>
        )}
      </p>

      {(!embedded || showWorking) && <>
      {/*
        The inputs, each as its own reading. A weighted number nobody can take
        apart is a number nobody should act on.
      */}
      <ul className="sv-inputs" aria-label="what the score is made of">
        {direction.inputs.map((i) => (
          <li key={i.key}>
            <span className="sv-input-label">{i.label}</span>
            <span className="sv-bar" aria-hidden>
              <i
                className={cn('sv-fill', (i.value ?? 0) >= 0 ? 'up' : 'down')}
                style={{
                  width: `${Math.min(50, Math.abs(i.value ?? 0) * 50)}%`,
                  [(i.value ?? 0) >= 0 ? 'left' : 'right']: '50%',
                }}
              />
            </span>
            <span className={cn('sv-input-value', i.value === null && 'dim')}>
              {signed(i.value)}
            </span>
            <span className="sv-why">{i.why}</span>
          </li>
        ))}
      </ul>

      <ul className="sv-gates" aria-label="gates">
        {direction.gates.map((g) => (
          <li key={g.key} className={cn(g.pass === true && 'ok', g.pass === false && 'no')}>
            <span className="sv-gate-mark" aria-hidden>
              {g.pass === true ? <Check size={12} strokeWidth={3} />
                : g.pass === false ? <X size={12} strokeWidth={3} />
                  : <Minus size={12} strokeWidth={3} />}
            </span>
            <span className="sv-gate-label">{g.label}</span>
            <span className="sv-gate-why">
              {g.why}
              {g.pass === null && <span className="dim"> · nothing to read, so not a pass</span>}
            </span>
          </li>
        ))}
      </ul>

      {containment && (
        /*
          The one number a two-sided seller is actually betting on: not "the put
          is 97% safe" and "the call is 99% safe" as two separate comforts, but
          the chance the day finishes inside both of them.
        */
        <div className="sv-corridor" aria-label="containment">
          <span className="sv-corridor-figure">
            {containment.probability === null ? '—' : pct(containment.probability, 1)}
          </span>
          <span className="sv-corridor-words">
            chance BTC settles between <b>{containment.low.toLocaleString('en-IN')}</b> and{' '}
            <b>{containment.high.toLocaleString('en-IN')}</b>
            {containment.lowBuffer !== null && containment.highBuffer !== null && (
              <> — {containment.lowBuffer.toFixed(2)}× and {containment.highBuffer.toFixed(2)}× the expected move away</>
            )}
          </span>
        </div>
      )}

      <p className="sv-foot">
        Read before the lots are split, never instead of it: the 70/30 skew is the rule with
        733 days behind it. Cumulative delta and funding are not in this score — the desk does
        not fetch them, and a number that looks like order flow and is not would be worse than
        the gap.
      </p>
      </>}
    </>
  );

  if (embedded) return <div className="side-verdict embedded" aria-label="today’s side">{body}</div>;
  return (
    <Card className="side-verdict">
      <CardTitle right={<span className="dim">{direction.passed}/5 gates</span>}>
        Today’s side
      </CardTitle>
      {body}
    </Card>
  );
}
