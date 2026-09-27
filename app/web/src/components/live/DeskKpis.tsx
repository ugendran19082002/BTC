import type { LiveResponse } from '@/types/live';
import { ARROW, WORD, toneOf, TONE_TEXT, pct0, usd0 } from './parts';
import { cn } from '@/lib/utils';

/**
 * The five answers, above everything that argues for them.
 *
 * A reader arriving at this desk asks the same five questions in the same order,
 * and until now each was a scroll away from the next: what is the market doing,
 * where does it settle, how big can the next hour be, may I act, and what kind
 * of day is it. One strip, one line of type each.
 *
 * Every tile is a *view* of a figure drawn in full further down — none of them
 * computes anything of its own. A summary that does its own arithmetic is a
 * summary that can disagree with the card it summarises, which is the failure
 * this desk has spent a week removing.
 */

function Tile({ label, value, sub, tone, icon, hint }: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'up' | 'down' | 'warn' | 'dim';
  icon?: string;
  hint?: string;
}) {
  return (
    <div className="dk-tile" title={hint}>
      {icon ? <span className="dk-icon" aria-hidden>{icon}</span> : null}
      <div className="dk-body">
        <span className="dk-label">{label}</span>
        <b className={cn('dk-value', tone && TONE_TEXT[tone])}>{value}</b>
        {sub ? <span className="dk-sub">{sub}</span> : null}
      </div>
    </div>
  );
}

export function DeskKpis({ data }: { data: LiveResponse }) {
  const { ladder, readiness, prediction, momentum, stability } = data;
  const tone = toneOf(ladder.bias);

  // The three tiers, as the ladder already decided them. Not recomputed here.
  const tiers: [string, typeof ladder.bias | undefined][] = [
    ['Direction', ladder.tiers.direction],
    ['Setup', ladder.tiers.setup],
    ['Trigger', ladder.tiers.trigger],
  ];

  const band = prediction?.band ?? null;

  return (
    <div className="dk" aria-label="Desk summary">
      <Tile
        label="Market state"
        value={<span className={TONE_TEXT[tone]}>{WORD[ladder.bias]}</span>}
        icon={ARROW[ladder.bias]}
        sub={(
          <span className="dk-tiers">
            {tiers.map(([name, way]) => (
              <span key={name} className={way ? TONE_TEXT[toneOf(way)] : TONE_TEXT.dim}>
                {name} {way ? ARROW[way] : '·'}
              </span>
            ))}
          </span>
        )}
        hint={ladder.text}
      />

      <Tile
        label="At expiry"
        value={band ? `${usd0(band.low)} – ${usd0(band.high)}` : '—'}
        sub={band?.pInside != null
          ? <>{pct0(band.pInside)} inside <span className="dk-dim">· modelled</span></>
          : 'no measured range'}
        hint={prediction?.note}
      />

      <Tile
        label="Big move"
        value={momentum.state === 'CONFIRMED'
          ? `${momentum.tf} ${momentum.side === 'UP' ? 'breakout' : 'breakdown'}`
          : momentum.state === 'COILED' ? 'Coiled' : 'Quiet'}
        tone={momentum.state === 'NONE' ? 'dim' : 'warn'}
        sub={momentum.measured
          ? <>net {momentum.measured.netR >= 0 ? '+' : ''}{momentum.measured.netR.toFixed(3)}R <span className="dk-dim">measured</span></>
          : momentum.state === 'NONE' ? 'no break this hour' : 'never graded'}
        hint={momentum.headline}
      />

      <Tile
        label="Decision"
        value={readiness.ready ? `Ready · ${readiness.side}` : 'No trade'}
        tone={readiness.ready ? 'up' : 'dim'}
        sub={readiness.ready
          ? `${pct0(ladder.alignment)} of the weight agrees`
          : readiness.blockers[0] ?? 'no side passes its gates'}
        hint={readiness.blockers.join(' · ')}
      />

      <Tile
        label="Signal stability"
        value={stability
          ? stability.verdict === 'STABLE' ? 'Holding'
            : stability.verdict === 'UNSTABLE' ? 'Low'
              : stability.verdict === 'CHOPPY' ? 'Mixed' : 'Too few'
          : '—'}
        tone={stability && (stability.verdict === 'UNSTABLE' || stability.verdict === 'CHOPPY') ? 'warn' : 'dim'}
        sub={stability && stability.flips > 0
          ? `${stability.flips} side change${stability.flips === 1 ? '' : 's'}/h`
          : stability?.verdict === 'STABLE' ? 'holding its direction' : 'not enough calls'}
        hint={stability?.text}
      />
    </div>
  );
}
