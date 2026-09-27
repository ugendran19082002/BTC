import type { ExpiryPath, MomentumSignal } from '@/types/live';
import { cn } from '@/lib/utils';

const price = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 0 });

/** The two decisions the trader should be able to read before the detail cards. */
export function FocusSummary({ path, momentum }: { path: ExpiryPath | null; momentum: MomentumSignal }) {
  const settlement = path?.settlement ?? null;
  const hasPlan = momentum.plan !== null;
  const canTrade = momentum.verdict === 'TRADEABLE' && hasPlan;
  const momentumTone = momentum.side === 'UP' ? 'text-[var(--up)]' : momentum.side === 'DOWN' ? 'text-[var(--down)]' : 'text-foreground';

  return (
    <section className="desk-focus-summary grid gap-2 md:grid-cols-2" aria-label="Decision focus" aria-live="polite">
      <article className="desk-focus-summary__card min-w-0 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">Expiry path</p>
            <h2 className="m-0 mt-1 text-[16px] font-semibold">Where price can travel</h2>
          </div>
          <span className="rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {path ? `${path.hoursToExpiry.toFixed(1)}h left` : 'not read'}
          </span>
        </div>
        {settlement ? (
          <>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[21px]">{price(settlement.low95)} – {price(settlement.high95)}</span>
              <span className="text-[12px] text-muted-foreground">95% measured range</span>
            </div>
            <p className="m-0 mt-1 text-[12px] text-muted-foreground">
              Typical move ±{price(settlement.medianUsd)} · direction edge {path!.directionEdgePct.toFixed(2)} pts from 50%
            </p>
          </>
        ) : (
          <p className="m-0 mt-3 text-[12.5px] text-muted-foreground">No measured settlement band. Do not infer a direction.</p>
        )}
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          This is a calibrated range, not a guaranteed arrow. The range helps decide whether a strike is far enough away.
        </p>
      </article>

      <article className="desk-focus-summary__card min-w-0 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">Big momentum</p>
            <h2 className={cn('m-0 mt-1 text-[16px] font-semibold', momentumTone)}>{momentum.headline}</h2>
          </div>
          <span className={cn('rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide', canTrade ? 'bg-[var(--up)]/15 text-[var(--up)]' : 'bg-[var(--warn)]/15 text-[var(--warn)]')}>
            {canTrade ? 'tradeable' : 'wait / information'}
          </span>
        </div>
        {momentum.plan ? (
          <dl className="desk-focus-summary__plan mt-3 grid grid-cols-3 gap-2 text-[12px]">
            <div><dt className="text-muted-foreground">Entry</dt><dd className="m-0 mt-0.5 font-mono text-[15px]">{price(momentum.plan.entry)}</dd></div>
            <div><dt className="text-muted-foreground">Stop</dt><dd className="m-0 mt-0.5 font-mono text-[15px] text-[var(--down)]">{price(momentum.plan.stop)}</dd></div>
            <div><dt className="text-muted-foreground">Target</dt><dd className="m-0 mt-0.5 font-mono text-[15px] text-[var(--up)]">{price(momentum.plan.target)}</dd></div>
          </dl>
        ) : (
          <p className="m-0 mt-3 text-[12.5px] text-muted-foreground">No confirmed break, so there is no responsible entry, stop, or target yet.</p>
        )}
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          A large move is not automatically a profitable trade. The measured record and every blocker below must agree first.
        </p>
      </article>
    </section>
  );
}
