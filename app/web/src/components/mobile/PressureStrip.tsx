import { useState, type CSSProperties } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { clock } from '@/lib/format';
import type { SideFlow } from '@/api/desk';
import { deltaBars, sideRead, type SideRead } from '@/lib/pressure';
import { points, signedPct, signedPoints, type PriceMove } from '@/lib/price-change';
import { cn } from '@/lib/utils';
import { PRESSURE_WINDOWS, type Pressure, type PressureWindow } from '@/components/mobile/usePressure';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Home's four cards, in one row over today's P&L (owner, 7 Oct 2026): the call tape, the put tape, the big-move
 * read, and BTC itself. Four across at every width -- 79px a card on a 360px phone, about 80px tall -- so each is
 * four short lines, one under the other, and the four line up across the row:
 *
 *            CE flow / PE flow         Big move                  BTC index
 *   word     SELL · BUY · BALANCED     the band                  the index now
 *   figure   the share that leads      the pressure, its lean    the perp against it
 *   picture  SELL-to-BUY line, a mark  the perp's running delta  the move since entry
 *
 * Where the row has the room (from 520px: a card is then 118px or more) each card says a little more -- the
 * window beside a tape's name and its delta as a few bars, the lean in a word, the time of the price, the move
 * in percent too. Nothing is taken away to make room; narrower, those are a tap away on their own screens.
 *
 * The window all three readings share -- 5m, 15m, 1h, 4h -- is a small box at the top right of the big-move card.
 * A tap on a tape or the band opens Pressure; on BTC, Price changes. Type the size of the status tiles above.
 */

const TONE = {
  up: { text: 'text-[var(--up)]', fill: 'bg-[var(--up)]', css: 'var(--up)' },
  down: { text: 'text-[var(--down)]', fill: 'bg-[var(--down)]', css: 'var(--down)' },
  warn: { text: 'text-[var(--warn)]', fill: 'bg-[var(--warn)]', css: 'var(--warn)' },
  flat: { text: 'text-foreground', fill: 'bg-[var(--dim)]', css: 'var(--dim)' },
} as const;
type Tone = keyof typeof TONE;

/**
 * A card: its edge and a wash of its tone, as the reading has one. Four lines, each its own height, so the row
 * lines up. 4px of padding at the sides under 420px: the room is the words'.
 */
const SHELL = 'flex min-w-0 flex-col rounded-xl border border-solid px-1 py-1.5 text-left font-[inherit] text-foreground min-[420px]:px-2 '
  + 'border-[color-mix(in_srgb,var(--t)_38%,var(--line))] bg-[linear-gradient(160deg,color-mix(in_srgb,var(--t)_13%,var(--panel)),var(--panel)_62%)]';
const shell = (tone: Tone): CSSProperties => ({ ['--t' as string]: TONE[tone].css });
// The sizes of the status tiles above them on Home: an 11px label, a 14px semibold value.
const LABEL = 'block h-[14px] truncate text-[11px] leading-[14px] text-muted-foreground';
const WORD = 'mt-0.5 block h-[18px] truncate font-semibold leading-[18px]';
const FIGURE = 'block h-[15px] truncate text-[11.5px] leading-[15px] tabular-nums text-muted-foreground';
const PICTURE = 'mt-1 flex h-[15px] items-center';
/** Shown only where a card is wide enough for it. */
const WIDE = 'hidden min-[520px]:inline';

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
  const [picking, setPicking] = useState(false);
  const windowLabel = PRESSURE_WINDOWS.find((o) => o.key === window)?.label ?? '1h';
  const bandTone: Tone = !w ? 'flat' : w.band === 'sudden' ? 'down' : w.band === 'high' || w.band === 'watch' ? 'warn' : 'up';
  const lean = !w || w.lean === 0 ? null : w.lean > 0 ? 'up' : 'down';
  // Since the desk's entry; holding nothing, since the last settlement.
  const mark = price.marks.find((m) => m.mark === 'entry') ?? price.marks.find((m) => m.mark === 'dayStart') ?? null;
  const markTone: Tone = mark?.way === 'up' ? 'up' : mark?.way === 'down' ? 'down' : 'flat';
  const gap = perp !== null && price.index !== null ? perp - price.index : null;

  return (
    <div role="group" aria-label="Pressure and price">
      <div className="grid grid-cols-4 !gap-1 min-[420px]:!gap-1.5">
        <SideCard name="CE flow" window={windowLabel} flow={x.flow?.ce ?? null} read={x.perpRead} onOpen={onOpen} />
        <SideCard name="PE flow" window={windowLabel} flow={x.flow?.pe ?? null} read={x.perpRead} onOpen={onOpen} />

        <div className={cn(SHELL, 'relative')} style={shell(bandTone)}>
          <button
            type="button" onClick={onOpen}
            aria-label={w ? `Big move: ${w.band}${w.pressure === null ? '' : `, ${w.pressure} percent`}${lean ? `, pressure ${lean}` : ''}, over ${windowLabel}. Open Pressure` : 'Big move: reading. Open Pressure'}
            className="block w-full min-w-0 border-0 bg-transparent p-0 text-left font-[inherit] text-foreground"
          >
            {/* Its name, and at the right the window as a small box (the button for it lies over this corner). Under 520px the box needs the room and the name is its second word. */}
            <span className={cn(LABEL, 'flex items-center justify-between gap-1')}>
              <span className="truncate"><span className="min-[520px]:hidden">Move</span><span className={WIDE}>Big move</span></span>
              <span aria-hidden="true" className="flex h-[14px] shrink-0 items-center gap-px rounded bg-[var(--panel-3)] pl-1 pr-0.5 text-[11px] leading-none text-foreground">
                {windowLabel}<ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', picking && 'rotate-180')} />
              </span>
            </span>
            <span className={cn(w?.band === 'sudden' ? 'text-[13px]' : 'text-[14px]', WORD, TONE[bandTone].text)}>{w ? w.band.toUpperCase() : '…'}</span>
            <span className={FIGURE}>
              {!w ? 'reading' : w.pressure === null ? '—' : <span className="font-semibold text-foreground">{w.pressure}%</span>}
              {lean && <span className={cn('ml-1 font-semibold', lean === 'up' ? TONE.up.text : TONE.down.text)}><span className={WIDE}>{lean} </span>{lean === 'up' ? '↑' : '↓'}</span>}
            </span>
            <span className={PICTURE}><Spark values={x.perpCvd} /></span>
          </button>
          {/*
            The window the three readings share, as a small box at the card's top right (owner, 7 Oct 2026). What
            shows is a box a line tall; what a finger gets is the corner, 44 by 36px. The list is the desk's own,
            drawn in its colours: the browser's picker opened white, three of its four lines unreadable.
          */}
          <Popover open={picking} onOpenChange={setPicking}>
            <PopoverTrigger asChild>
              <button
                type="button" aria-haspopup="menu" aria-label={`Window: ${windowLabel}. Change`}
                className="absolute right-0 top-0 z-10 h-9 w-11 cursor-pointer rounded-tr-xl border-0 bg-transparent p-0"
              />
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={2} className="w-[148px] p-1" role="menu" aria-label="Window">
              {PRESSURE_WINDOWS.map((o) => (
                <button
                  key={o.key} type="button" role="menuitemradio" aria-checked={window === o.key}
                  onClick={() => { onWindow(o.key); setPicking(false); }}
                  className={cn(
                    'flex h-10 w-full items-center justify-between gap-2 rounded-md border-0 px-2.5 text-left font-[inherit] text-[14px]',
                    window === o.key ? 'bg-muted font-semibold text-foreground' : 'bg-transparent text-foreground active:bg-muted',
                  )}
                >
                  <span className="tabular-nums">{o.label}</span>
                  <span className="flex items-center gap-1.5 text-[12px] font-normal text-muted-foreground">
                    {o.spoken}{window === o.key && <Check aria-hidden="true" className="h-4 w-4 text-[var(--up)]" />}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>
        </div>

        <button
          type="button" onClick={onOpenPrice} className={SHELL} style={shell(markTone)}
          aria-label={!price.read ? 'BTC index: reading. Open Price changes'
            : `BTC index ${points(price.index)}${gap === null ? '' : `, perp ${signedPoints(gap)} to the index`}${mark && mark.pts !== null ? `; ${mark.label.toLowerCase()} ${signedPoints(mark.pts)} points, ${signedPct(mark.pct)}, from ${points(mark.from)} to ${points(mark.to)}` : ''}. Open Price changes`}
        >
          <span className={cn(LABEL, 'flex justify-between gap-1')}>
            <span className="truncate">BTC index</span>
            {price.at !== null && <span className={cn(WIDE, 'shrink-0 tabular-nums text-[var(--time)]')}>{clock(price.at)}</span>}
          </span>
          <span className={cn('text-[14px] tabular-nums', WORD)}>{price.read ? points(price.index) : '…'}</span>
          <span className={FIGURE}>
            {!price.read ? 'reading' : gap === null ? 'perp —' : <>perp <span className="font-semibold text-foreground">{signedPoints(gap)}</span></>}
          </span>
          {/* The move since the desk's entry -- holding nothing, since the day began at the 17:30 settlement -- named in a word, then said. */}
          <span className={cn(PICTURE, 'gap-1 truncate text-[12px] tabular-nums')}>
            {mark && mark.pts !== null ? (
              <>
                <span className="text-[11px] text-muted-foreground">{mark.mark === 'entry' ? 'entry' : 'day'}</span>
                <span className={cn('font-semibold', TONE[markTone].text)}>{signedPoints(mark.pts)}</span>
                <span className={cn(WIDE, 'text-[11px]', TONE[markTone].text)}>{signedPct(mark.pct)}</span>
              </>
            ) : <span className="text-muted-foreground">—</span>}
          </span>
        </button>
      </div>
    </div>
  );
}

/** One side of the option tape. */
function SideCard({ name, window, flow, read, onOpen }: { name: string; window: string; flow: SideFlow | null; read: boolean; onOpen: () => void }) {
  const r: SideRead = read ? sideRead(flow) : { word: '—', sub: 'reading', tone: 'flat', buyShare: null, leadPct: null, leadWords: 'reading' };
  const at = r.buyShare === null ? null : Math.min(100, Math.max(0, r.buyShare * 100));
  // Six bars, and BALANCED at 11px (66px wide): the longest word a side reads as fits a 79px card on a 360px
  // phone, and fits beside the bars in a 118px one. (A size class after `leading-*` drops the leading: size first.)
  const bars = flow ? deltaBars(flow.cvd, 6) : [];
  return (
    <button
      type="button" onClick={onOpen} className={SHELL} style={shell(r.tone)}
      aria-label={`${name}, ${window}: ${read ? (r.word === '—' ? 'no prints' : `${r.word.toLowerCase()}${r.sub === 'pressure' ? ' pressure' : ''}, ${r.leadWords}`) : 'reading'}. Open Pressure`}
    >
      <span className={LABEL}>{name}<span className={cn(WIDE, 'tabular-nums text-[var(--dim)]')}> · {window}</span></span>
      <span className="mt-0.5 flex h-[18px] items-end justify-between gap-1">
        <span className={cn('min-w-0 truncate font-semibold', r.word === 'BALANCED' ? 'text-[11px]' : 'text-[14px]', 'leading-[18px]', TONE[r.tone].text)}>{read ? r.word : '…'}</span>
        {/* Its delta, minute by minute, as a few bars: bought more than sold in green. */}
        {bars.length > 1 && (
          <span aria-hidden="true" className="hidden h-4 shrink-0 items-end gap-[2px] min-[520px]:flex">
            {bars.map((b, i) => <span key={i} className={cn('w-[3px] rounded-sm', b.up ? TONE.up.fill : TONE.down.fill)} style={{ height: `${Math.max(10, b.size * 100)}%`, opacity: 0.4 + 0.6 * ((i + 1) / bars.length) }} />)}
          </span>
        )}
      </span>
      {/* The share of the side that leads: "72% sells". */}
      <span className={FIGURE}>
        {r.leadPct === null ? r.sub : <><span className={cn('font-semibold', r.tone === 'flat' ? 'text-foreground' : TONE[r.tone].text)}>{r.leadPct}%</span> {r.leadWords.split(' ')[1]}</>}
      </span>
      {/* From SELL to BUY, with a mark where the aggressors stand; the middle is level. The ends are named on the line itself: a letter each, the word where there is room. */}
      <span aria-hidden="true" className={cn(PICTURE, 'gap-1 text-[11px] font-medium text-[var(--dim)]')}>
        <span className="shrink-0"><span className="min-[520px]:hidden">S</span><span className={WIDE}>SELL</span></span>
        <span className="relative block h-1.5 min-w-0 flex-1 rounded-full bg-[var(--panel-3)]">
          {at !== null && (
            <>
              <span className={cn('absolute inset-y-0 rounded-full', at >= 50 ? TONE.up.fill : TONE.down.fill)} style={{ left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%` }} />
              <span className="absolute -top-[3px] h-3 w-[2px] rounded-sm bg-foreground" style={{ left: `calc(${at}% - 1px)` }} />
            </>
          )}
        </span>
        <span className="shrink-0"><span className="min-[520px]:hidden">B</span><span className={WIDE}>BUY</span></span>
      </span>
    </button>
  );
}

/** A reading's last stretch as a line, a dot on where it is now: green where it ends above its start. */
function Spark({ values }: { values: readonly number[] }) {
  if (values.length < 2) return <span className="block h-px w-full bg-[var(--line)]" />;
  const W = 60, H = 18, PAD = 3;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const last = values[values.length - 1]!;
  const colour = last >= values[0]! ? 'var(--up)' : 'var(--down)';
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[18px] w-full">
      <path d={values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')} fill="none" stroke="var(--muted)" strokeWidth={1.25} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2} fill={colour} />
    </svg>
  );
}
