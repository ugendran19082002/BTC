import { cn } from '@/lib/utils';
import type { TimeframeRow } from '@/types/entry';
import { Panel } from './parts';

/**
 * The timeframe chain at a glance, under the Big move catch: each of 4H-1M,
 * its trend (EMA stack and swings agreeing) and what its last swings did --
 * the same reading every "with timeframe" entry step uses. From the entry
 * board (the entry section hands it up), so it is one read, not two.
 */
export function TimeframeAnalysisPanel({ rows }: { rows: readonly TimeframeRow[] }) {
  const arrow = (t: -1 | 0 | 1, label: string) => (label === 'Not read' ? '?' : t === 1 ? '↑' : t === -1 ? '↓' : '→');
  const cls = (t: -1 | 0 | 1) => (t === 1 ? 'text-[var(--up)]' : t === -1 ? 'text-[var(--down)]' : 'text-muted-foreground');
  return (
    <Panel title="Timeframe analysis">
      <div aria-label="timeframe analysis" className="text-[12px]">
        {rows.length ? (
          <>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-1 pr-2 font-medium">TF</th>
                  <th className="pb-1 pr-2 font-medium">Direction</th>
                  <th className="pb-1 pr-2 font-medium">Swings</th>
                  <th className="pb-1 text-right font-medium">Role</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.tf} className="border-t border-border">
                    <td className="py-1 pr-2 font-semibold">{r.tf.toUpperCase()}</td>
                    <td className={cn('pr-2', cls(r.trend))}>{arrow(r.trend, r.label)} {r.label}</td>
                    <td className="pr-2 text-muted-foreground">{r.structure}</td>
                    <td className="text-right text-[11px] text-muted-foreground">{r.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1.5 flex flex-wrap gap-1" aria-label="timeframe trend view">
              {rows.map((r) => (
                <span key={r.tf} className={cn('rounded border border-border px-1 text-[10.5px]', cls(r.trend))}>{r.tf.toUpperCase()} {arrow(r.trend, r.label)}</span>
              ))}
            </div>
          </>
        ) : (
          <p className="m-0 text-muted-foreground">Reading the timeframes…</p>
        )}
      </div>
    </Panel>
  );
}
