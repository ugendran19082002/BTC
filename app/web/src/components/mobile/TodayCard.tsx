import type { TradeStatus } from '@/types/trade';
import type { MtmReport, MtmSample } from '@/types/report';
import { Card, CardTitle, Note } from '@/components/ui/card';
import { clock, inr, pnlTone, signedInr, signedUsd, usdToInr } from '@/lib/format';
import { lossBudget } from '@/lib/position-risk';
import { cn } from '@/lib/utils';

/**
 * Today, since 05:30 IST: the net first and large, then what it is made of, then how much of the day's loss
 * limit is left -- the number the order gate stops at -- then the day as a line, minute by minute.
 */
export function TodayCard({ status, mtm, allAccounts }: { status: TradeStatus | null; mtm: MtmReport | null; allAccounts: boolean }) {
  if (!status) {
    return (
      <Card aria-busy="true">
        <CardTitle>Today</CardTitle>
        <p className="m-0 text-[14px] text-muted-foreground">Reading today's figures…</p>
      </Card>
    );
  }
  const today = status.today;
  const net = today?.netUsd ?? (status.realisedTodayUsd ?? 0) + (status.unrealisedPnlUsd ?? 0);
  const budget = lossBudget(status);
  return (
    <Card>
      <CardTitle right={<span className="text-[11.5px] text-muted-foreground">since 05:30 IST</span>}>Today</CardTitle>
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] text-muted-foreground">Net, if everything closed now</span>
        <span className="flex items-baseline gap-1.5 whitespace-nowrap tabular-nums">
          <span className={cn('text-[24px] font-semibold', toneClass(net))}>{signedInr(usdToInr(net))}</span>
          <span className="text-[12px] text-muted-foreground">{signedUsd(net)}</span>
        </span>
      </div>
      {today && (
        <dl className="m-0 mt-2.5 grid grid-cols-3 gap-2">
          <Part label="Booked" usd={today.realisedUsd} />
          <Part label="Open" usd={today.unrealisedUsd} />
          <Part label="Charges" usd={-today.chargesUsd} />
        </dl>
      )}
      {budget && <LossMeter {...budget} />}
      {mtm && mtm.samples.length >= 2 ? (
        <>
          <Spark samples={mtm.samples} />
          <div className="mt-1 flex justify-between text-[11.5px] text-muted-foreground tabular-nums">
            <span>{clock(mtm.samples[0]!.at)}</span>
            {mtm.stats.min && mtm.stats.max && (
              <span>low {inr(usdToInr(mtm.stats.min.netUsd))} · high {inr(usdToInr(mtm.stats.max.netUsd))}</span>
            )}
            <span>{clock(mtm.samples[mtm.samples.length - 1]!.at)}</span>
          </div>
          {allAccounts && <Note tone="dim">The line is the default account's: two accounts' lines do not add up to one.</Note>}
        </>
      ) : (
        <Note tone="dim">The day's line starts with the first minute the desk records.</Note>
      )}
    </Card>
  );
}

const toneClass = (usd: number) => {
  const t = pnlTone(usd);
  return t === 'up' ? 'text-[var(--up)]' : t === 'down' ? 'text-[var(--down)]' : 'text-foreground';
};

function Part({ label, usd }: { label: string; usd: number }) {
  return (
    <div className="rounded-md bg-muted px-2.5 py-2">
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 whitespace-nowrap text-[14px] font-semibold tabular-nums', toneClass(usd))}>{signedInr(usdToInr(usd))}</dd>
    </div>
  );
}

function LossMeter({ limitUsd, leftUsd, usedPct }: { limitUsd: number; leftUsd: number; usedPct: number }) {
  const tone = usedPct >= 0.8 ? 'var(--down)' : usedPct >= 0.5 ? 'var(--warn)' : 'var(--up)';
  return (
    <div className="mt-3">
      <div className="flex justify-between text-[13px]">
        <span className="text-muted-foreground">Daily loss limit</span>
        <span className="tabular-nums"><b>{inr(usdToInr(leftUsd))}</b> <span className="text-muted-foreground">left of {inr(usdToInr(limitUsd))}</span></span>
      </div>
      <div
        role="meter" aria-label="Daily loss limit used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usedPct * 100)}
        className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.max(2, usedPct * 100)}%`, background: tone }} />
      </div>
      {usedPct >= 1 && <p className="m-0 mt-1.5 text-[13px] font-medium text-[var(--down)]">The limit is reached: the desk takes no new order today.</p>}
    </div>
  );
}

/** The day's net, minute by minute, with the zero line. An SVG of a few hundred points: no chart library on the phone. */
function Spark({ samples }: { samples: MtmSample[] }) {
  const W = 320, H = 84, PAD = 4;
  const xs = samples.map((s) => s.at);
  const ys = samples.map((s) => s.netUsd);
  const x0 = xs[0]!, x1 = xs[xs.length - 1]!;
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const span = hi - lo || 1;
  const x = (t: number) => PAD + ((t - x0) / (x1 - x0 || 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const d = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.at).toFixed(1)},${y(s.netUsd).toFixed(1)}`).join('');
  const last = ys[ys.length - 1]!;
  const colour = last > 0 ? 'var(--up)' : last < 0 ? 'var(--down)' : 'var(--muted)';
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label={`Net today, minute by minute: now ${inr(usdToInr(last))}`}
      className={cn('mt-3 block h-[84px] w-full rounded-md bg-muted')}
    >
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={colour} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
