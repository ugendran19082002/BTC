import { Lightbulb, ScanLine, Gauge as GaugeIcon } from 'lucide-react';
import type { StateIndicator, StatePattern } from '@/api/desk';
import { cn } from '@/lib/utils';

/**
 * The strip under the chart: what shape the bars are in, how the readings sit,
 * and the one sentence a person can act on.
 *
 * Three things, in the order somebody reads them. The patterns are what you
 * would see if you drew on the chart; the readings are the numbers behind
 * them; the insight is what both of them add up to, said the way it would be
 * said out loud. Nothing here decides anything -- the rules are all on the
 * server, in `domain/patterns.ts` and `domain/market-state.ts`.
 *
 * Deliberately short. Four patterns and six readings, chosen by the server for
 * the state price is actually in, because a strip with everything true on it
 * is a strip nobody reads.
 */

/** A tiny drawing of each shape, so the card is scannable without reading it. */
function Glyph({ name, bias }: { name: string; bias: StatePattern['bias'] }) {
  const stroke = bias === 'BULLISH' ? 'var(--up)' : bias === 'BEARISH' ? 'var(--down)' : 'var(--muted)';
  const path = glyphFor(name);
  return (
    <svg viewBox="0 0 48 24" className="bt-readout__glyph" aria-hidden>
      {path.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/**
 * The line each pattern is drawn as.
 *
 * Matched on what the name starts with rather than on an exact string, because
 * a level test carries its touch count in the name ("Resistance Test (3x)")
 * and a glyph that disappeared when a level was touched a third time would be
 * a small, silly bug.
 */
function glyphFor(name: string): string[] {
  if (name.startsWith('Ascending Triangle')) return ['M 2 20 L 44 4', 'M 2 4 L 44 4'];
  if (name.startsWith('Descending Triangle')) return ['M 2 4 L 44 20', 'M 2 20 L 44 20'];
  if (name.startsWith('Symmetrical Triangle')) return ['M 2 3 L 44 12', 'M 2 21 L 44 12'];
  if (name.startsWith('Rectangle')) return ['M 2 5 L 44 5', 'M 2 19 L 44 19'];
  if (name.startsWith('Higher Lows')) return ['M 2 21 L 12 9 L 20 16 L 30 6 L 38 12 L 46 2'];
  if (name.startsWith('Lower Highs')) return ['M 2 3 L 12 15 L 20 8 L 30 18 L 38 12 L 46 22'];
  if (name.startsWith('Resistance Test')) return ['M 2 6 L 44 6', 'M 6 18 L 14 7 L 22 17 L 30 7 L 38 19'];
  if (name.startsWith('Support Test')) return ['M 2 18 L 44 18', 'M 6 6 L 14 17 L 22 7 L 30 17 L 38 5'];
  if (name.startsWith('Volume Buildup')) return ['M 6 22 L 6 17', 'M 14 22 L 14 14', 'M 22 22 L 22 10', 'M 30 22 L 30 7', 'M 38 22 L 38 3'];
  if (name.startsWith('Compression')) return ['M 2 2 L 44 10', 'M 2 22 L 44 14'];
  // Anything candle-shaped: one bar with its wicks, which is honest for all of them.
  return ['M 24 2 L 24 22', 'M 20 7 L 28 7 L 28 17 L 20 17 Z'];
}

export function PatternStrip({ patterns }: { patterns: readonly StatePattern[] }) {
  return (
    <section className="bt-card bt-readout" aria-label="Pattern detection">
      <h3><ScanLine size={14} aria-hidden /> Pattern detection</h3>
      {patterns.length === 0 ? (
        <p className="bt-muted">Nothing named on these bars.</p>
      ) : (
        <ul className="bt-readout__patterns">
          {patterns.map((p) => (
            <li key={p.name} className={cn(p.bias === 'BULLISH' && 'is-up', p.bias === 'BEARISH' && 'is-down')}>
              <strong>{p.name}</strong>
              <span className="bt-readout__bias">
                {p.bias === 'BULLISH' ? 'Bullish' : p.bias === 'BEARISH' ? 'Bearish' : 'Neutral'}
              </span>
              <Glyph name={p.name} bias={p.bias} />
              <span className="bt-readout__note">{p.note}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A half-circle for the readings that have natural bounds, and the number
 * alone for the ones that do not.
 *
 * RSI runs 0 to 100 and a dial says where in that it sits at a glance. MACD's
 * histogram has no top, so a dial would be inventing one -- those get the
 * figure and the word, which is all they can honestly carry.
 */
function Dial({ value, bias }: { value: number; bias: StateIndicator['bias'] }) {
  const R = 22;
  const CIRC = Math.PI * R;
  const colour = bias === 'BULLISH' ? 'var(--up)' : bias === 'BEARISH' ? 'var(--down)' : 'var(--accent, var(--text))';
  return (
    <svg viewBox="0 0 56 32" className="bt-readout__dial" aria-hidden>
      <path d="M 6 28 A 22 22 0 0 1 50 28" fill="none" stroke="var(--line)" strokeWidth="5" strokeLinecap="round" />
      <path
        d="M 6 28 A 22 22 0 0 1 50 28" fill="none" stroke={colour} strokeWidth="5" strokeLinecap="round"
        strokeDasharray={`${CIRC * Math.max(0, Math.min(1, value))} ${CIRC}`}
      />
    </svg>
  );
}

export function IndicatorSummary({ items }: { items: readonly StateIndicator[] }) {
  return (
    <section className="bt-card bt-readout" aria-label="Indicator summary">
      <h3><GaugeIcon size={14} aria-hidden /> Indicator summary</h3>
      {items.length === 0 ? (
        <p className="bt-muted">No readings yet.</p>
      ) : (
        <ul className="bt-readout__dials">
          {items.map((i) => (
            <li key={i.key}>
              <span className="bt-readout__dial-label">{i.label}</span>
              {i.gauge !== null ? <Dial value={i.gauge} bias={i.bias} /> : <span className="bt-readout__dial-gap" aria-hidden />}
              <strong>{i.text}</strong>
              <span className={cn('bt-readout__dial-read',
                i.bias === 'BULLISH' && 'is-up', i.bias === 'BEARISH' && 'is-down')}>{i.read}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The whole reading in one sentence, both branches in it.
 *
 * The last thing on the strip and the first thing most people will read. It
 * comes from the server (`insightFor`) rather than being assembled here, so
 * the sentence, the card and the journal can never drift apart.
 */
export function ChartInsight({ insight }: { insight: string }) {
  return (
    <section className="bt-card bt-insight" aria-label="What this means">
      <Lightbulb size={16} aria-hidden />
      <div>
        <h3>What this means</h3>
        <p>{insight}</p>
      </div>
    </section>
  );
}
