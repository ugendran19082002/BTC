import type { MomentumSignal } from '@/types/live';
import { Card, Row, Warnings, Nothing, Provenance, pct0, usd0, TONE_TEXT } from './parts';
import { MeasuredRecord } from './MeasuredRecord';
import { cn } from '@/lib/utils';

/**
 * "A big move is coming — here is the stop and the target."
 *
 * The card the whole Live rebuild exists for, and the one
 * `docs/FULL-STUDY.md` §7.5 filed a finding against: the old screen showed
 * this call's 80% hit rate with no cost beside it, while the replay of every
 * one of these that ever fired said net negative after fees at every
 * timeframe.
 *
 * So the rule here is one line long: **the verdict is drawn from the
 * measurement, not from the setup.** A CONFIRMED break with a beautiful
 * 3:1 plan and a measured −0.15R still prints as "not a trade", in the same
 * size type as the plan. There is no prop that turns that off, and the
 * measured row is not collapsible.
 */

const STATE_WORD = {
  CONFIRMED: 'Break confirmed',
  COILED: 'Coiled — expansion likely',
  NONE: 'Nothing',
} as const;

export function MomentumCard({ signal, id }: { signal: MomentumSignal; id?: string }) {
  const { state, plan, measured, verdict } = signal;
  const tradeable = verdict === 'TRADEABLE';

  if (state === 'NONE') {
    return (
      <Card id={id} title="Big move" hint="A break that has just happened, or a range tight enough that one is due.">
        <Nothing>{signal.headline}</Nothing>
        {signal.compression !== null && (
          <Row
            label="Range against its recent average"
            value={pct0(signal.compression)}
            hint="Under 80% is contracting; an expansion usually follows one."
          />
        )}
      </Card>
    );
  }

  return (
    <Card
      id={id}
      title="Big move"
      hint="A break that has just happened, or a range tight enough that one is due."
      right={signal.tf ? <span className="font-mono">{signal.tf}</span> : null}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(
            'text-[15px] font-semibold',
            signal.side === 'UP' ? TONE_TEXT.up : signal.side === 'DOWN' ? TONE_TEXT.down : TONE_TEXT.dim,
          )}
        >
          {STATE_WORD[state]}
        </span>
        {/*
          The verdict sits beside the state, not under the plan. Someone who
          reads two words of this card must read this one.
        */}
        <span
          className={cn(
            'rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide',
            tradeable ? 'bg-[var(--up)]/15 text-[var(--up)]' : 'bg-[var(--warn)]/15 text-[var(--warn)]',
          )}
        >
          {tradeable ? 'Tradeable' : 'Not a trade — information only'}
        </span>
      </div>

      <p className="mt-1.5 text-[12.5px] leading-snug text-muted-foreground">{signal.headline}</p>

      {plan && (
        <div className="mt-3 rounded border border-border bg-background/40 p-2">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
            Plan
            <Provenance kind="modelled" note={`Levels from the ${plan.policy} rule — the least-bad of the six the replay graded.`} />
          </div>
          <Row label="Entry" value={usd0(plan.entry)} tone="plain" />
          <Row label="Stop" value={usd0(plan.stop)} tone="down" hint={`${plan.riskPts} points of risk`} />
          <Row label="Target" value={usd0(plan.target)} tone="up" hint={`${plan.rewardPts} points sought`} />
          <Row
            label="Risk : reward"
            value={`1 : ${plan.rr.toFixed(2)}`}
            tone={plan.rr >= 1 ? 'plain' : 'warn'}
            hint={`Risking ${plan.riskPts} to seek ${plan.rewardPts}.`}
          />
        </div>
      )}

      {/*
        What this exact shape actually did -- drawn by the same component the
        Live screen's signal history uses, so the two screens cannot quote
        different numbers about one shape. Never collapsed: this is the row
        that was missing when the screen showed an 80% hit rate and a net loss.
      */}
      {/* `showVerdict={false}`: this card already carries the verdict beside the state, above. */}
      <MeasuredRecord measured={measured} tf={signal.tf ?? undefined} className="mt-3" showVerdict={false} />

      <Warnings items={signal.warnings} />
    </Card>
  );
}
