import type { ExpiryDirection, MtfConsensus, SideChoice } from '@/lib/overview';

type Way = 'UP' | 'DOWN' | 'SIDE' | 'RANGE' | null;

const ARROW: Record<string, string> = { UP: '↑', DOWN: '↓', SIDE: '↔', RANGE: '↔' };
const WORD: Record<string, string> = { UP: 'Up', DOWN: 'Down', SIDE: 'Sideways', RANGE: 'Range' };
const toneOf = (w: Way) => (w === 'UP' ? 'up' : w === 'DOWN' ? 'down' : 'muted');
const pct = (v: number) => `${Math.round(v * 100)}%`;

// Green means a side passes its gates, not a direction: selling a CE is a bet against up.
const DECISION: Record<SideChoice['side'], { text: string; tone: 'up' | 'muted' }> = {
  CE: { text: 'Sell CE', tone: 'up' },
  PE: { text: 'Sell PE', tone: 'up' },
  BOTH: { text: 'Sell both', tone: 'up' },
  NO_TRADE: { text: 'No trade', tone: 'muted' },
};

/** Where each tile's full panel lives on the page. */
export const SIGNAL_ANCHORS = { trend: 'ov-sig-trend', expiry: 'ov-sig-expiry', decision: 'ov-sig-decision' } as const;

function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The screen's answers first (26 Sep 2026).
 *
 * On a phone the trend, the expiry read and the side decision sat 2,500 to
 * 8,500 pixels down, under the header, nine KPI tiles and the chart. This is
 * the three of them in one row at the top, each a button to its full panel.
 * It computes nothing: every figure is the panel's own, so the strip and the
 * panel cannot disagree.
 *
 * The trend tile reads the tiers the way docs/New.md orders them --
 * direction (12H-4H), setup (2H-30M), trigger (15M-5M) -- rather than as a
 * flat count of timeframes, so one bullish minute cannot outvote the day.
 */
export function SignalStrip({ mtf, direction, choice, hoursLeftText }: {
  mtf: MtfConsensus;
  direction: ExpiryDirection | null;
  choice: SideChoice;
  hoursLeftText: string;
}) {
  const tiers: { label: string; way: Way }[] = [
    { label: 'Direction', way: mtf.tiers.macro },
    { label: 'Setup', way: mtf.tiers.setup },
    { label: 'Trigger', way: mtf.tiers.trigger },
  ];
  const decision = DECISION[choice.side];
  return (
    <nav className="ov-sig" aria-label="Signals">
      <button type="button" className="ov-sig-tile" onClick={() => jump(SIGNAL_ANCHORS.trend)}>
        <span className="ov-sig-label">Trend</span>
        <b className={`ov-sig-head ov-${toneOf(mtf.way)}`}>
          {mtf.way ? `${ARROW[mtf.way]} ${WORD[mtf.way]}` : '—'}
        </b>
        <span className="ov-sig-tiers">
          {tiers.map((t) => (
            <span key={t.label} className={`ov-${toneOf(t.way)}`} title={`${t.label}: ${t.way ? WORD[t.way] : 'no reading'}`}>
              {t.label} {t.way ? ARROW[t.way] : '·'}
            </span>
          ))}
        </span>
      </button>

      <button type="button" className="ov-sig-tile" onClick={() => jump(SIGNAL_ANCHORS.expiry)}>
        <span className="ov-sig-label">At expiry · {hoursLeftText}</span>
        {direction ? (
          <>
            <b className={`ov-sig-head ov-${toneOf(direction.bias)}`}>
              {ARROW[direction.bias]} {WORD[direction.bias]}
              <small className="ov-sig-conf">{direction.confidence.toLowerCase()}</small>
            </b>
            <span className="ov-sig-sub">
              <span className="ov-up">↑ {pct(direction.pUp)}</span>
              <span className="ov-muted">↔ {pct(direction.pRange)}</span>
              <span className="ov-down">↓ {pct(direction.pDown)}</span>
            </span>
          </>
        ) : <b className="ov-sig-head ov-muted">—</b>}
      </button>

      <button type="button" className="ov-sig-tile" onClick={() => jump(SIGNAL_ANCHORS.decision)}>
        <span className="ov-sig-label">Decision</span>
        <b className={`ov-sig-head ov-${decision.tone}`}>{decision.text}</b>
        <span className="ov-sig-sub ov-sig-why" title={choice.why}>{choice.why}</span>
      </button>
    </nav>
  );
}
