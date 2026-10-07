import type { SideFlow } from '@/api/desk';
import { cn } from '@/lib/utils';
import type { Pressure } from '@/components/mobile/usePressure';

/**
 * Home's row of three, over today's P&L (owner, 7 Oct 2026): what the call tape reads as, what the put tape reads
 * as, and the big-move band with its pressure as a percent and the way it leans. Three words of the Pressure
 * screen, and a tap opens the rest.
 */

const UP = 'text-[var(--up)]', DOWN = 'text-[var(--down)]', WARN = 'text-[var(--warn)]', DIM = 'text-muted-foreground';

/** A side's pressure as a tile: the word that matters large, the rest of it small. */
function sideWords(p: SideFlow['pressure'] | undefined, read: boolean): { word: string; sub: string; tone: string } {
  if (!read) return { word: '…', sub: 'reading', tone: DIM };
  if (p === 'BUY PRESSURE') return { word: 'BUY', sub: 'pressure', tone: UP };
  if (p === 'SELL PRESSURE') return { word: 'SELL', sub: 'pressure', tone: DOWN };
  if (p === 'BALANCED') return { word: 'BALANCED', sub: 'both sides', tone: 'text-foreground' };
  return { word: '—', sub: 'no prints', tone: DIM };
}

export function PressureStrip({ pressure: x, onOpen }: { pressure: Pressure; onOpen: () => void }) {
  const ce = sideWords(x.flow?.ce.pressure, x.perpRead);
  const pe = sideWords(x.flow?.pe.pressure, x.perpRead);
  const w = x.warning;
  const bandTone = !w ? DIM : w.band === 'sudden' ? DOWN : w.band === 'high' || w.band === 'watch' ? WARN : UP;
  const lean = !w || w.lean === 0 ? null : w.lean > 0 ? 'up ↑' : 'down ↓';
  const said = [
    `CE flow ${x.flow?.ce.pressure?.toLowerCase() ?? 'not read'}`, `PE flow ${x.flow?.pe.pressure?.toLowerCase() ?? 'not read'}`,
    w ? `big move ${w.band}${w.pressure === null ? '' : `, ${w.pressure} percent`}${lean ? `, pressure ${lean.slice(0, -2)}` : ''}` : 'big move not read',
  ].join('; ');
  return (
    <button
      type="button" onClick={onOpen} aria-label={`Pressure: ${said}. Open`}
      className="grid grid-cols-3 !gap-1.5 border-0 bg-transparent p-0 text-left font-[inherit]"
    >
      <Cell label="CE flow" word={ce.word} tone={ce.tone} sub={ce.sub} />
      <Cell label="PE flow" word={pe.word} tone={pe.tone} sub={pe.sub} />
      <Cell
        label="Big move" word={w ? w.band.toUpperCase() : '…'} tone={bandTone}
        sub={!w ? 'reading' : (
          <>
            {w.pressure === null ? '—' : `${w.pressure}%`}
            {lean && <span className={cn('ml-1', w.lean > 0 ? UP : DOWN)}>{lean}</span>}
          </>
        )}
      />
    </button>
  );
}

function Cell({ label, word, tone, sub }: { label: string; word: string; tone: string; sub: React.ReactNode }) {
  return (
    <span className="block min-w-0 rounded-lg bg-[var(--panel)] px-2 py-2">
      <span className="block truncate text-[11.5px] text-muted-foreground">{label}</span>
      <span className={cn('block truncate text-[14px] font-semibold leading-tight', tone)}>{word}</span>
      <span className="block truncate text-[11.5px] tabular-nums text-muted-foreground">{sub}</span>
    </span>
  );
}
