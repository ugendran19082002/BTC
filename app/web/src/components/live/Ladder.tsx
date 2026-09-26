import type { Ladder as LadderT, LadderRow, Tier } from '@/types/live';
import { Card, ARROW, WORD, toneOf, TONE_TEXT, Provenance, pct0, Nothing } from './parts';
import { cn } from '@/lib/utils';

/**
 * The 12H → 1M ladder, weighted by what each frame is *for*.
 *
 * `docs/New.md` names the failure this table exists to prevent:
 *
 *   > Wrong approach: 1D UP / 4H DOWN / 1H DOWN / 15M UP / 5M UP —
 *   > எல்லாவற்றையும் equal vote பண்ணுவது.
 *
 * The screen this replaced did exactly that: one vote per readable row, flat
 * majority, so five fast frames outvoted four slow ones and a one-minute
 * candle could turn the day's read. Here the weight column is on screen beside
 * every row, the execution frame's weight is a visible zero, and the frames
 * that disagree with the answer are listed under it rather than averaged away.
 *
 * The tiers are drawn as groups because they are not a ranking — the 4H is not
 * "better" than the 15M, it is answering a different question — and a flat
 * list of nine rows invites reading it as one.
 */

const TIER_LABEL: Record<Tier, string> = {
  direction: 'Direction',
  structure: 'Structure',
  setup: 'Setup',
  pattern: 'Pattern',
  trigger: 'Trigger',
  execution: 'Execution',
};

const TIER_JOB: Record<Tier, string> = {
  direction: 'Where the market is going. No entry is read here.',
  structure: 'Which prices matter — the levels the next move is measured against.',
  setup: 'What is forming.',
  pattern: 'Whether the pattern confirmed.',
  trigger: 'Whether the move actually started.',
  execution: 'Entry timing only. Carries no weight in the read, by design.',
};

const ORDER: readonly Tier[] = ['direction', 'structure', 'setup', 'pattern', 'trigger', 'execution'];

function RowLine({ r }: { r: LadderRow }) {
  const tone = toneOf(r.way);
  return (
    <tr className="border-t border-border/50">
      <th scope="row" className="py-1.5 pr-2 text-left font-mono text-[12px] font-normal">{r.tf}</th>
      <td className={cn('py-1.5 pr-2 text-center text-[14px]', TONE_TEXT[tone])} title={WORD[r.way]}>
        {ARROW[r.way]}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono text-[11.5px] text-muted-foreground">
        {r.weight === 0 ? (
          <span title="Execution frames do not vote. This is the whole point of the table.">0</span>
        ) : (
          r.weight
        )}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono text-[11.5px] text-muted-foreground" title="How many of this frame's own reads agreed">
        {r.way === 'SIDE' ? '—' : pct0(r.conviction)}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono text-[11.5px] text-muted-foreground" title="ADX(14) — trend strength, saying nothing about direction">
        {r.adx === null ? '—' : r.adx.toFixed(0)}
      </td>
      <td className="py-1.5 text-right font-mono text-[11.5px] text-muted-foreground" title="Price against this frame's VWAP">
        {r.vwapDistPct === null ? '—' : `${r.vwapDistPct > 0 ? '+' : ''}${r.vwapDistPct.toFixed(2)}%`}
      </td>
    </tr>
  );
}

export function Ladder({ ladder, id }: { ladder: LadderT; id?: string }) {
  if (!ladder.rows.length) {
    return (
      <Card id={id} title="Timeframes">
        <Nothing>No timeframe could be read — the candle feed returned nothing.</Nothing>
      </Card>
    );
  }

  const tone = toneOf(ladder.bias);
  const groups = ORDER
    .map((tier) => ({ tier, rows: ladder.rows.filter((r) => r.tier === tier) }))
    .filter((g) => g.rows.length > 0);

  return (
    <Card
      id={id}
      title="Timeframes"
      hint="Each frame weighted by the job it does. The one-minute frame carries no weight."
      right={
        <span className={TONE_TEXT[tone]}>
          {ARROW[ladder.bias]} {WORD[ladder.bias]}
          <Provenance kind="observed" note="Read from the live candles at the timestamp on the bar." />
        </span>
      }
    >
      <p className="mb-2 text-[12px] text-muted-foreground">{ladder.text}</p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[360px] border-collapse">
          <caption className="sr-only">Timeframes grouped by their job, with the weight each carries</caption>
          <thead>
            <tr className="text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">
              <th scope="col" className="py-1 pr-2 text-left font-semibold">TF</th>
              <th scope="col" className="py-1 pr-2 text-center font-semibold">Way</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold">Wt</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold">Conv</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold">ADX</th>
              <th scope="col" className="py-1 text-right font-semibold">VWAP</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.tier}>
              <tr>
                <td colSpan={6} className="pt-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.8px]" title={TIER_JOB[g.tier]}>
                      {TIER_LABEL[g.tier]}
                    </span>
                    <span className={cn('text-[11px]', TONE_TEXT[toneOf(ladder.tiers[g.tier] ?? null)])}>
                      {ladder.tiers[g.tier] ? WORD[ladder.tiers[g.tier]!] : '—'}
                    </span>
                  </div>
                </td>
              </tr>
              {g.rows.map((r) => <RowLine key={r.tf} r={r} />)}
            </tbody>
          ))}
        </table>
      </div>

      {/*
        Dissent, named. An average that hides which frames disagreed is an
        average that cannot be argued with.
      */}
      {ladder.against.length > 0 && (
        <p className="mt-2.5 text-[12px] leading-snug text-[var(--warn)]">
          Against this read: {ladder.against.join(', ')}.
        </p>
      )}
    </Card>
  );
}
