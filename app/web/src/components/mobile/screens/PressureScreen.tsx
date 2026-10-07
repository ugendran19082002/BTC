import type { SideFlow } from '@/api/desk';
import type { Leg } from '@/types/desk';
import { pct } from '@/lib/format';
import type { Trigger } from '@/lib/overview';
import { atmLeg, bookOf, buySellShare, kct, spreadOf } from '@/lib/pressure';
import { cn } from '@/lib/utils';
import { AreaChart, Empty, Loading, Panel, Pill } from '@/components/mobile/parts';
import { usePressure } from '@/components/mobile/usePressure';

/**
 * Pressure (owner, 7 Oct 2026): the desk's two pressure cards, made for a phone.
 *
 *  - Option flow, CE and PE: who crossed the spread on the calls and on the puts over the last hour -- bought
 *    against sold as one bar, the delta, the running delta as a line, the aggressor share, the at-the-money
 *    option's book and spread, the busiest strikes -- and what each side and the two together read as.
 *  - Big move catch: the nine readings that tend to run ahead of a move, each with how far it has come towards
 *    its own trigger out of 100, its lamp, and -- there being no hover on a phone -- the reading and its
 *    threshold written under it.
 *
 * Read-only, from what the desk's Live screen reads (`usePressure`). Home wears three words of it in a row.
 */

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const signed = (v: number, places = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })}`;
const toneOf = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]');

export function PressureScreen() {
  const x = usePressure();
  const data = x.chain;
  if (!data) return <Panel><Loading error={x.chainError} what="the market" /></Panel>;
  const snap = data.snapshot;
  const f = x.flow;
  const w = x.warning!;
  const { leg, shock } = x;
  const bias = f?.combined.bias ?? null;
  const biasTone = bias === null || bias === 'MIXED' ? 'dim' : /CALL BUYING|PUT SELLING/.test(bias) ? 'up' : 'down';
  const bandTone = w.band === 'sudden' ? 'down' : w.band === 'high' ? 'warn' : w.band === 'watch' ? 'accent' : 'up';

  return (
    <>
      <Panel title="Option flow · CE / PE" right={f ? <span className={cn('text-[11.5px] tabular-nums', f.minutesCovered < f.windowMin ? 'text-[var(--warn)]' : 'text-muted-foreground')}>{f.minutesCovered} of {f.windowMin} min · {f.expiry}</span> : undefined}>
        {!x.perpRead ? <Loading error={x.perpError} what="the option tape" />
          : !f ? <Empty>No option prints in the last hour: the tape recorder is not connected, or has only just begun.</Empty> : (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-muted-foreground">Overall option flow</span>
                <Pill tone={biasTone}>{bias ?? '—'}</Pill>
              </div>
              <BuySell buy={f.combined.buyVolume} sell={f.combined.sellVolume} />
              <div className="mt-1 flex items-baseline justify-between text-[12.5px] text-muted-foreground">
                <span>Delta, calls and puts together</span>
                <span className={cn('font-semibold tabular-nums', toneOf(f.combined.deltaVolume) || 'text-foreground')}>{signed(f.combined.deltaVolume)}</span>
              </div>
            </>
          )}
      </Panel>

      {f && (
        <>
          <FlowCard name="CE flow" side="CALL" flow={f.ce} leg={atmLeg(data.legs, 'C', snap.atm)} />
          <FlowCard name="PE flow" side="PUT" flow={f.pe} leg={atmLeg(data.legs, 'P', snap.atm)} />
        </>
      )}

      <Panel title="Big move catch" right={<Pill tone={bandTone}>{w.band.toUpperCase()}{w.pressure === null ? '' : ` · ${w.pressure}/100`}</Pill>}>
        {w.lean !== 0 && (
          <div className={cn('mb-1 text-[14px] font-semibold', w.lean > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
            Pressure {w.lean > 0 ? 'up ↑' : 'down ↓'}
          </div>
        )}
        <p className="m-0 rounded-md bg-muted px-2.5 py-2 text-[13px] leading-snug">
          {w.action}{shock && shock.score !== null ? ` Measured sudden-move score ${shock.score.toFixed(0)} (${shock.band}).` : ''}
        </p>
        <ul className="m-0 mt-2 list-none p-0" aria-label="Big move readings">
          {w.triggers.map((t) => <TriggerRow key={t.name} trigger={t} />)}
        </ul>
        <p className="m-0 mt-2 text-[12px] text-muted-foreground">
          Score is how far each reading has come towards its own trigger, out of 100: not a chance of a move. The band is set by what has actually crossed.
          {leg && ` Premium and IV changes are read on ${n0(leg.strike)} ${leg.cp === 'C' ? 'CE' : 'PE'}, the desk's own pick.`}
        </p>
      </Panel>
    </>
  );
}

/** Bought against sold, as one bar with its two figures at the ends. */
function BuySell({ buy, sell }: { buy: number; sell: number }) {
  const share = buySellShare(buy, sell);
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-2 text-[13px] tabular-nums">
        <span><span className="text-muted-foreground">Buy </span><span className="font-semibold text-[var(--up)]">{kct(buy)}</span></span>
        <span><span className="font-semibold text-[var(--down)]">{kct(sell)}</span><span className="text-muted-foreground"> Sell</span></span>
      </div>
      <div role="img" aria-label={`${pct(share.buy, 0)} bought, ${pct(share.sell, 0)} sold`} className="mt-1 flex h-2 overflow-hidden rounded-full bg-[var(--panel-3)]">
        <span className="h-full bg-[var(--up)]" style={{ width: `${share.buy * 100}%` }} />
        <span className="ml-auto h-full bg-[var(--down)]" style={{ width: `${share.sell * 100}%` }} />
      </div>
    </div>
  );
}

function FlowCard({ name, side, flow: x, leg }: { name: string; side: 'CALL' | 'PUT'; flow: SideFlow; leg: Leg | null }) {
  const book = bookOf(leg);
  const spread = spreadOf(leg);
  const cvd = x.cvd.map((c) => c.cvd);
  const pressureTone = x.pressure === 'BUY PRESSURE' ? 'up' : x.pressure === 'SELL PRESSURE' ? 'down' : 'dim';
  return (
    <Panel
      title={<span className="flex items-center gap-2">{name} <Pill tone={side === 'CALL' ? 'up' : 'down'}>{side}</Pill></span>}
      right={<Pill tone={pressureTone}>{x.pressure ?? 'no prints'}</Pill>}
    >
      <BuySell buy={x.buyVolume} sell={x.sellVolume} />
      <dl className="m-0 mt-3 grid grid-cols-3 !gap-x-2 !gap-y-2.5">
        <Figure label="Delta" className={toneOf(x.deltaVolume)}>{signed(x.deltaVolume)}</Figure>
        <Figure label="Aggressor buys">{pct(x.aggressorBuyPct, 1)}</Figure>
        <Figure label="Trades">{n0(x.trades)}</Figure>
        <Figure label={leg ? `Book · ATM ${n0(leg.strike)}` : 'Book · ATM'} className={toneOf(book)}>{book === null ? '—' : `${signed(book * 100)}%`}</Figure>
        <Figure label="Spread">{pct(spread, 1)}</Figure>
        <Figure label="CVD" className={toneOf(cvd[cvd.length - 1])}>{cvd.length ? signed(cvd[cvd.length - 1]!) : '—'}</Figure>
      </dl>
      {cvd.length >= 2 && <div className="mt-2"><AreaChart values={cvd} label={`${name}: cumulative volume delta, minute by minute`} height={44} /></div>}
      <div className="mt-2 text-[12px] text-muted-foreground">Busiest strikes</div>
      {x.strikes.length === 0 ? <div className="text-[13px]">—</div> : (
        <ul className="m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0">
          {x.strikes.map((k) => (
            <li key={k.strike} className="rounded-md bg-muted px-2 py-1 text-[12.5px] tabular-nums">
              <span className="font-semibold">{n0(k.strike)}</span> <span className="text-muted-foreground">{kct(k.buyVolume + k.sellVolume)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Figure({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn('m-0 whitespace-nowrap text-[14px] font-semibold tabular-nums', className)}>{children}</dd>
    </div>
  );
}

const LAMP = {
  TRIGGERED: { tone: 'down', bar: 'bg-[var(--down)]', row: 'bg-[color-mix(in_srgb,var(--down)_12%,transparent)]' },
  WATCH: { tone: 'warn', bar: 'bg-[var(--warn)]', row: 'bg-[color-mix(in_srgb,var(--warn)_10%,transparent)]' },
  NORMAL: { tone: 'up', bar: 'bg-[var(--dim)]', row: '' },
} as const;

/** One reading: its name and lamp, how far it has come, then the reading and its threshold in words. */
function TriggerRow({ trigger: t }: { trigger: Trigger }) {
  const look = t.state ? LAMP[t.state] : null;
  const score = t.score === null ? null : Math.round(t.score);
  return (
    <li className={cn('-mx-1.5 rounded-md px-1.5 py-2', look?.row)}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[14px] font-medium">{t.name}</span>
        {look ? <Pill tone={look.tone}>{t.state}</Pill> : <Pill tone="dim">NOT READ</Pill>}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span role="meter" aria-label={`${t.name} score`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={score ?? 0} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-3)]">
          <span className={cn('block h-full rounded-full', look?.bar ?? 'bg-[var(--dim)]')} style={{ width: `${score ?? 0}%` }} />
        </span>
        <span className="w-[52px] shrink-0 text-right text-[13px] font-semibold tabular-nums">{score === null ? '—' : `${score}/100`}</span>
      </div>
      <div className="mt-0.5 text-[12px] text-muted-foreground">{t.value} · triggers {t.threshold}</div>
    </li>
  );
}
