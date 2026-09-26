import type { ExpiryPath, Way } from '@/types/live';
import { Card, Row, Nothing, Provenance, usd0, TONE_TEXT } from './parts';
import { cn } from '@/lib/utils';

/**
 * Where BTC can be by the 17:30 settlement.
 *
 * `docs/New.md` asks for a path — "Next 5m ↓ −45 · Expiry ↓ −550" — and in the
 * same breath insists the numbers come from historical calibration rather than
 * from an assumption. They do, and the calibration refuses to draw the arrow:
 * across 105,000+ windows over 364 days, the measured share of windows closing
 * higher is 49.4–50.6% at *every* horizon, and conditioning on the trend makes
 * it slightly worse.
 *
 * So this card draws the **band**, which is measured tightly, and prints the
 * lean beside it as the nothing it is. A seller does not need to know which
 * way it goes; they need to know how far it can get, because that is what
 * decides whether a strike is far enough away.
 *
 * The bar is drawn to the widest row so the cone visibly opens with time,
 * which is the one intuition about this table worth building.
 */

const WATCH_WORD: Record<ExpiryPath['watch'], string> = {
  UPPER: 'The ladder leans up, so the upper edge is the one to watch',
  LOWER: 'The ladder leans down, so the lower edge is the one to watch',
  BOTH: 'No side from the ladder — watch both edges',
};

export function ExpiryCone({ path, bias, id }: { path: ExpiryPath | null; bias: Way; id?: string }) {
  if (!path || !path.rows.length) {
    return (
      <Card id={id} title="Where it can be at settlement">
        <Nothing>No measured horizons are loaded, so the band cannot be drawn.</Nothing>
      </Card>
    );
  }

  const widest = Math.max(...path.rows.map((r) => r.p95Usd)) || 1;

  return (
    <Card
      id={id}
      title="Where it can be at settlement"
      hint="The measured distribution of how far price travels in a given time. Not a forecast of direction."
      right={<span className="font-mono">{path.hoursToExpiry.toFixed(1)}h left</span>}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[15px]">{usd0(path.spot)}</span>
        <span className="text-[11px] text-muted-foreground">
          {WATCH_WORD[path.watch]}
          <Provenance kind="observed" note="Which edge to watch comes from the hierarchy; it never moves the band." />
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[400px] border-collapse text-[12px]">
          <caption className="sr-only">Measured move by horizon, as a band around the current price</caption>
          <thead>
            <tr className="text-left text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">
              <th scope="col" className="py-1 pr-2 font-semibold">In</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold">Typical</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold" title="Two windows in three stayed inside this">68%</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold" title="Nineteen windows in twenty stayed inside this">95%</th>
              <th scope="col" className="py-1 font-semibold">Range at 95%</th>
            </tr>
          </thead>
          <tbody>
            {path.rows.map((r) => (
              <tr key={r.label} className="border-t border-border/60">
                <th scope="row" className="py-1.5 pr-2 text-left font-mono font-normal">
                  {r.label}
                  {r.interpolated && (
                    <span
                      className="ml-1 text-[9.5px] text-muted-foreground"
                      title="Not measured at this horizon — scaled by root-time between the two that were."
                    >
                      ~
                    </span>
                  )}
                </th>
                <td className="py-1.5 pr-2 text-right font-mono text-muted-foreground">±{usd0(r.medianUsd)}</td>
                <td className="py-1.5 pr-2 text-right font-mono">±{usd0(r.p68Usd)}</td>
                <td className="py-1.5 pr-2 text-right font-mono">±{usd0(r.p95Usd)}</td>
                <td className="py-1.5">
                  {/* The bar is the point: the cone opens with the square root of time. */}
                  <div className="flex items-center gap-2">
                    <div className="relative h-1.5 flex-1 rounded-full bg-border/60" aria-hidden>
                      <div
                        className="absolute inset-y-0 rounded-full bg-[var(--dim)]/50"
                        style={{
                          left: `${50 - (r.p95Usd / widest) * 50}%`,
                          right: `${50 - (r.p95Usd / widest) * 50}%`,
                        }}
                      />
                      <div className="absolute inset-y-[-2px] left-1/2 w-px bg-foreground/60" />
                    </div>
                    <span className="flex-none font-mono text-[10.5px] text-muted-foreground">
                      {usd0(r.low95)}–{usd0(r.high95)}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        The honesty row. It is not a footnote: it is the reason the table has
        no arrow, and it is printed in the same type as the table.
      */}
      <div className="mt-3 rounded border border-border bg-background/40 p-2">
        <Row
          label="Measured lean, best case"
          value={`${path.directionEdgePct.toFixed(2)} pts from a coin flip`}
          tone={path.directionEdgePct >= 2 ? 'warn' : 'dim'}
          hint="The largest |P(up) − 50%| anywhere in the measured table."
        />
        <Row
          label="Ladder now says"
          value={bias === 'SIDE' ? 'no side' : bias.toLowerCase()}
          tone={bias === 'UP' ? 'up' : bias === 'DOWN' ? 'down' : 'dim'}
        />
        <p className={cn('mt-1.5 text-[11.5px] leading-snug', TONE_TEXT.dim)}>{path.note}</p>
      </div>
    </Card>
  );
}
