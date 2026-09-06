import type { Forecast } from '../types';
import { Card, CardTitle, Note } from './ui/card';
import { Badge } from './ui/badge';

/**
 * How far BTC could move from here, per horizon.
 *
 * Deliberately not a direction forecast. Over 105,120 five-minute windows the
 * odds of finishing higher never leave 48-52% at any horizon, so the direction
 * column reads ~50% and says why. Distance is the part that can be measured,
 * and for someone selling options it is the part that matters.
 */
export function ForecastPanel({ forecast: f }: { forecast: Forecast }) {
  return (
    <Card className="lg:col-span-2">
      <CardTitle right={<Badge tone="neutral">{f.sampleDays} days measured</Badge>}>
        How far it could move
      </CardTitle>

      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-[11.8px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--dim)]">
              <th className="px-1.5 py-1 text-left font-normal">next</th>
              <th className="px-1.5 py-1 text-right font-normal">usually</th>
              <th className="px-1.5 py-1 text-right font-normal">2 times in 3</th>
              <th className="px-1.5 py-1 text-right font-normal">19 times in 20</th>
              <th className="px-1.5 py-1 text-right font-normal">worst seen</th>
              <th className="px-1.5 py-1 text-right font-normal">market says</th>
              <th className="px-1.5 py-1 text-right font-normal">likely range</th>
              <th className="px-1.5 py-1 text-right font-normal">up</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {f.rows.map((r) => (
              <tr
                key={r.label}
                className={`border-b border-[#ffffff08] ${r.isExpiry ? 'bg-[#58a6ff14]' : ''}`}
              >
                <td className="px-1.5 py-[3px] text-left font-sans">
                  {r.isExpiry ? <b>{r.label}</b> : <span className="text-muted-foreground">{r.label}</span>}
                </td>
                <td className="px-1.5 py-[3px] text-right">{r.typicalPct.toFixed(2)}%</td>
                <td className="px-1.5 py-[3px] text-right text-[var(--text)]">{r.likelyPct.toFixed(2)}%</td>
                <td className="px-1.5 py-[3px] text-right text-[var(--warn)]">{r.outerPct.toFixed(2)}%</td>
                <td className="px-1.5 py-[3px] text-right text-[var(--down)]">{r.worstPct.toFixed(1)}%</td>
                <td className="px-1.5 py-[3px] text-right text-muted-foreground">
                  {r.impliedPct === null ? '—' : `${r.impliedPct.toFixed(2)}%`}
                </td>
                <td className="px-1.5 py-[3px] text-right text-muted-foreground">
                  {Math.round(r.low).toLocaleString()} – {Math.round(r.high).toLocaleString()}
                </td>
                <td className="px-1.5 py-[3px] text-right text-[var(--dim)]">
                  {(r.pUp * 100).toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Note>
        <b>usually</b> is the middle of the pack — half of all past windows moved less
        than that. <b>2 times in 3</b> and <b>19 times in 20</b> are how far it stays
        inside most of the time. <b>market says</b> is what today's option prices imply
        over the same stretch, so you can see whether the market is pricing more or
        less movement than BTC has actually been delivering.
      </Note>

      <Note tone="warn">
        The <b>up</b> column is not a forecast and never will be. Across{' '}
        {f.sampleWindows.toLocaleString()} windows the chance of finishing higher never
        moved further than {f.directionEdgePts.toFixed(1)} points from a coin flip, at
        any horizon. Filtering by trend or by the last bar changed it by under a point.
        Nobody can tell you which way the next hour goes; how far it can travel is
        knowable, and that is what the rest of this table is.
      </Note>

      <Note tone="dim">
        Worst seen is a single real day out of {f.sampleDays}. It is the number to size
        against, not the ones next to it.
      </Note>
    </Card>
  );
}
