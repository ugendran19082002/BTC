import type { CSSProperties, ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import type { SideFlow } from '@/api/desk';
import { clock } from '@/lib/format';
import { deltaBars, sideRead, type SideRead } from '@/lib/pressure';
import { points, signedPct, signedPoints, type PriceMove } from '@/lib/price-change';
import { cn } from '@/lib/utils';
import { PRESSURE_WINDOWS, type Pressure, type PressureWindow } from '@/components/mobile/usePressure';

/**
 * Home's four cards, over today's P&L (owner, 7 Oct 2026): the call tape, the put tape, the big-move read, and
 * BTC itself. Two by two: the phone view is never wide enough for four of these side by side (at its widest,
 * 560px, a card would be 128px and its words cut off).
 *
 *  - CE flow, PE flow: what the side reads as, large; the share of the side that leads as a badge; its delta
 *    minute by minute as a few bars; and a line from SELL to BUY with a mark where the aggressors stand.
 *  - Big move: the band, the pressure as a percent and the way it leans, the perp's running delta as a line, and
 *    the window all of it is read over -- 5m, 15m, 1h, 4h -- which the two tapes share and say beside their names.
 *  - BTC: the index now, the perp against it, and the move since the desk's entry (or, holding nothing, since
 *    the last settlement): from what to what, in points and percent.
 *
 * A tap on a tape or the band opens Pressure; on BTC, Price changes.
 */

const TONE = {
  up: { text: 'text-[var(--up)]', fill: 'bg-[var(--up)]', css: 'var(--up)' },
  down: { text: 'text-[var(--down)]', fill: 'bg-[var(--down)]', css: 'var(--down)' },
  warn: { text: 'text-[var(--warn)]', fill: 'bg-[var(--warn)]', css: 'var(--warn)' },
  flat: { text: 'text-foreground', fill: 'bg-[var(--dim)]', css: 'var(--dim)' },
} as const;
type Tone = keyof typeof TONE;

/** A card: its edge and a wash of its tone, as the reading has one. */
const SHELL = 'block min-w-0 rounded-xl border border-solid p-2.5 text-left font-[inherit] text-foreground '
  + 'border-[color-mix(in_srgb,var(--t)_38%,var(--line))] bg-[linear-gradient(160deg,color-mix(in_srgb,var(--t)_13%,var(--panel)),var(--panel)_62%)]';
const shell = (tone: Tone): CSSProperties => ({ ['--t' as string]: TONE[tone].css });

export function PressureStrip({ pressure: x, window, onWindow, price, perp, onOpen, onOpenPrice }: {
  pressure: Pressure;
  window: PressureWindow;
  onWindow: (w: PressureWindow) => void;
  /** BTC's index now and the desk's marks against it; `read` false until the first answer. */
  price: { at: number | null; index: number | null; read: boolean; marks: PriceMove[] };
  /** The BTC perp now, as the shell reads it. */
  perp: number | null;
  onOpen: () => void;
  onOpenPrice: () => void;
}) {
  const w = x.warning;
  const windowLabel = PRESSURE_WINDOWS.find((o) => o.key === window)?.label ?? '1h';
  const bandTone: Tone = !w ? 'flat' : w.band === 'sudden' ? 'down' : w.band === 'high' || w.band === 'watch' ? 'warn' : 'up';
  const lean = !w || w.lean === 0 ? null : w.lean > 0 ? 'up' : 'down';
  // Since the desk's entry; holding nothing, since the last settlement.
  const mark = price.marks.find((m) => m.mark === 'entry') ?? price.marks.find((m) => m.mark === 'dayStart') ?? null;
  const gap = perp !== null && price.index !== null ? perp - price.index : null;
  const MoveIcon = mark?.way === 'up' ? ArrowUp : mark?.way === 'down' ? ArrowDown : null;

  return (
    <div className="grid grid-cols-2 !gap-1.5" role="group" aria-label="Pressure and price">
      <SideCard name="CE flow" window={windowLabel} flow={x.flow?.ce ?? null} read={x.perpRead} onOpen={onOpen} />
      <SideCard name="PE flow" window={windowLabel} flow={x.flow?.pe ?? null} read={x.perpRead} onOpen={onOpen} />

      <div className={SHELL} style={shell(bandTone)}>
        <button
          type="button" onClick={onOpen}
          aria-label={w ? `Big move: ${w.band}${w.pressure === null ? '' : `, ${w.pressure} percent`}${lean ? `, pressure ${lean}` : ''}, over ${windowLabel}. Open Pressure` : 'Big move: reading. Open Pressure'}
          className="block w-full border-0 bg-transparent p-0 text-left font-[inherit] text-foreground"
        >
          <Head label="Big move" badge={w ? w.band.toUpperCase() : null} tone={bandTone} />
          <span className="mt-1 flex items-end justify-between gap-1.5">
            <span className="min-w-0">
              <span className={cn('block truncate text-[19px] font-bold leading-none', TONE[bandTone].text)}>{w ? w.band.toUpperCase() : '…'}</span>
              <span className="mt-1 block truncate text-[12px] tabular-nums text-muted-foreground">
                {!w ? 'reading' : w.pressure === null ? '—' : <span className="font-semibold text-foreground">{w.pressure}%</span>}
                {lean && <span className={cn('ml-1 font-medium', lean === 'up' ? TONE.up.text : TONE.down.text)}>{lean} {lean === 'up' ? '↑' : '↓'}</span>}
              </span>
            </span>
            <Spark values={x.perpCvd} />
          </span>
        </button>
        {/* The window the three readings share. Each segment a finger wide: 36px, the card's own padding given up to it. */}
        <div role="radiogroup" aria-label="Window" className="-mx-1 mt-2 flex rounded-lg bg-[var(--panel-3)] p-0.5">
          {PRESSURE_WINDOWS.map((o) => (
            <button
              key={o.key} type="button" role="radio" aria-checked={window === o.key} aria-label={o.spoken} onClick={() => onWindow(o.key)}
              className={cn(
                'h-9 min-w-0 flex-1 rounded-md border-0 p-0 font-[inherit] text-[12px] font-semibold tabular-nums',
                window === o.key ? 'bg-[var(--panel)] text-foreground shadow-[0_0_0_1px_var(--line)]' : 'bg-transparent text-muted-foreground',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button" onClick={onOpenPrice} className={SHELL} style={shell(mark?.way === 'up' ? 'up' : mark?.way === 'down' ? 'down' : 'flat')}
        aria-label={!price.read ? 'BTC index: reading. Open Price changes'
          : `BTC index ${points(price.index)}${gap === null ? '' : `, perp ${signedPoints(gap)} to the index`}${mark && mark.pts !== null ? `; ${mark.label.toLowerCase()} ${signedPoints(mark.pts)} points, ${signedPct(mark.pct)}, from ${points(mark.from)} to ${points(mark.to)}` : ''}. Open Price changes`}
      >
        <span className="flex items-baseline justify-between gap-1.5">
          <span className="truncate text-[12px] text-muted-foreground">BTC index</span>
          {price.at !== null && <span className="shrink-0 text-[11px] tabular-nums text-[var(--time)]">{clock(price.at)}</span>}
        </span>
        <span className="mt-1 block truncate text-[19px] font-bold leading-none tabular-nums">{price.read ? points(price.index) : '…'}</span>
        <span className="mt-1 block truncate text-[12px] tabular-nums text-muted-foreground">
          {!price.read ? 'reading' : gap === null ? 'perp —' : <>perp <span className="font-medium text-foreground">{signedPoints(gap)}</span></>}
        </span>
        {mark && (
          <span className="mt-2 block border-0 border-t border-solid border-[var(--line-soft)] pt-1.5">
            <span className="block truncate text-[11px] text-muted-foreground">{mark.label} <span className="tabular-nums text-[var(--time)]">{clock(mark.at)}</span></span>
            <span className={cn('flex items-center gap-0.5 truncate text-[14px] font-bold leading-tight tabular-nums', TONE[mark.way === 'up' ? 'up' : mark.way === 'down' ? 'down' : 'flat'].text)}>
              {MoveIcon && <MoveIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
              {signedPoints(mark.pts)}
              <span className="ml-1 text-[11.5px] font-medium">{signedPct(mark.pct)}</span>
            </span>
            <span className="flex items-center gap-1 truncate text-[11.5px] tabular-nums text-muted-foreground">
              {points(mark.from)} <ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" /> <span className="text-foreground">{points(mark.to)}</span>
            </span>
          </span>
        )}
      </button>
    </div>
  );
}

/** A card's first line: its name, and at the right what stands out about it, in a small frame of its tone. */
function Head({ label, badge, tone }: { label: ReactNode; badge: string | null; tone: Tone }) {
  return (
    <span className="flex items-center justify-between gap-1.5">
      <span className="min-w-0 truncate text-[12px] text-muted-foreground">{label}</span>
      {badge !== null && (
        <span className={cn('shrink-0 rounded-md border border-solid border-[color-mix(in_srgb,var(--t)_55%,transparent)] bg-[color-mix(in_srgb,var(--t)_14%,transparent)] px-1.5 py-0.5 text-[11px] font-bold leading-none tabular-nums', TONE[tone].text)}>
          {badge}
        </span>
      )}
    </span>
  );
}

/** One side of the option tape. */
function SideCard({ name, window, flow, read, onOpen }: { name: string; window: string; flow: SideFlow | null; read: boolean; onOpen: () => void }) {
  const r: SideRead = read ? sideRead(flow) : { word: '—', sub: 'reading', tone: 'flat', buyShare: null, leadPct: null, leadWords: 'reading' };
  const bars = flow ? deltaBars(flow.cvd) : [];
  const at = r.buyShare === null ? null : Math.min(100, Math.max(0, r.buyShare * 100));
  return (
    <button
      type="button" onClick={onOpen} className={SHELL} style={shell(r.tone)}
      aria-label={`${name}, ${window}: ${read ? (r.word === '—' ? 'no prints' : `${r.word.toLowerCase()}${r.sub === 'pressure' ? ' pressure' : ''}, ${r.leadWords}`) : 'reading'}. Open Pressure`}
    >
      <Head label={<>{name} <span className="tabular-nums text-[var(--dim)]">· {window}</span></>} badge={r.leadPct === null ? null : `${r.leadPct}%`} tone={r.tone} />
      <span className="mt-1 flex items-end justify-between gap-1.5">
        <span className="min-w-0">
          <span className={cn('block truncate font-bold leading-none', r.word === 'BALANCED' ? 'text-[13px] tracking-[-0.2px]' : 'text-[19px]', TONE[r.tone].text)}>{read ? r.word : '…'}</span>
          <span className="mt-1 block truncate text-[12px] text-muted-foreground">{r.sub}</span>
        </span>
        {/* Its delta, minute by minute, as a few bars: bought more than sold in green. */}
        {bars.length > 1 && (
          <span aria-hidden="true" className="flex h-7 shrink-0 items-end gap-[2px]">
            {bars.map((b, i) => <span key={i} className={cn('w-[3px] rounded-sm', b.up ? TONE.up.fill : TONE.down.fill)} style={{ height: `${Math.max(8, b.size * 100)}%`, opacity: 0.35 + 0.65 * ((i + 1) / bars.length) }} />)}
          </span>
        )}
      </span>
      {/* From SELL to BUY, with a mark where the aggressors stand; the middle is level. */}
      <span aria-hidden="true" className="relative mt-2.5 block h-1.5 rounded-full bg-[var(--panel-3)]">
        {at !== null && (
          <>
            <span className={cn('absolute inset-y-0 rounded-full', at >= 50 ? TONE.up.fill : TONE.down.fill)} style={{ left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%` }} />
            <span className="absolute -top-[3px] h-3 w-[2px] rounded-sm bg-foreground" style={{ left: `calc(${at}% - 1px)` }} />
          </>
        )}
      </span>
      <span aria-hidden="true" className="mt-1 flex justify-between text-[11px] font-medium tracking-[0.4px] text-[var(--dim)]"><span>SELL</span><span>BUY</span></span>
    </button>
  );
}

/** A reading's last stretch as a line, a dot on where it is now: green where it ends above its start. */
function Spark({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const W = 56, H = 28, PAD = 3;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const last = values[values.length - 1]!;
  const colour = last >= values[0]! ? 'var(--up)' : 'var(--down)';
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} className="h-7 w-14 shrink-0">
      <path d={values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')} fill="none" stroke="var(--muted)" strokeWidth={1.25} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} fill={colour} />
    </svg>
  );
}
