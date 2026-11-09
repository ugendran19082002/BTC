import { ChevronRight } from 'lucide-react';
import { getLedgerDay, type DayTrade } from '@/api/ledger';
import { signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePoll } from '@/hooks/usePoll';

/**
 * A day's trades, won and lost (owner, 2 Nov 2026: "a tap on Won or Lost opens that list of trades -- strike, CE or
 * PE, exit by SL or TGT, and each trade's loss -- the ledger day popup, filtered to winners or losers"). Read from the
 * same list the popup shows (`/api/ledger/day`) and split the way its Won and Lost chips split it -- each trade's net
 * after its charges, closed trades only -- so "Lost 5 · −₹1,480" opens on exactly those five and that sum.
 */

export type Outcome = 'win' | 'loss';
/** Won or lost after charges; an open trade, or one that came out at nothing, is neither. */
export const outcomeOf = (t: DayTrade): Outcome | null => (t.open ? null : t.netUsd > 0 ? 'win' : t.netUsd < 0 ? 'loss' : null);

const money = (usd: number) => signedInr(usdToInr(usd));

export function WonLost({ day, account, every, onOpen, unfiltered = false }: {
  day: string; account: number | null; every: number; onOpen: (o: Outcome) => void;
  /** The screen's strategy, method or time frame filter is on, and these are every trade of the day all the same. */
  unfiltered?: boolean;
}) {
  const r = usePoll(() => getLedgerDay(day, account), every, { deps: [day, account] });
  // Another day's answer, still held while this day's is asked for, is not this day's.
  if (!r.data || r.data.day !== day) {
    return r.error
      ? <p className="m-0 mt-3 text-[12.5px] text-muted-foreground">The day&apos;s trades could not be read.</p>
      : <div aria-hidden="true" className="mt-3 h-[76px] animate-pulse rounded-lg bg-muted" />;
  }
  const won = r.data.trades.filter((t) => outcomeOf(t) === 'win');
  const lost = r.data.trades.filter((t) => outcomeOf(t) === 'loss');
  const open = r.data.trades.filter((t) => t.open).length;
  return (
    <WonLostView
      won={{ n: won.length, usd: won.reduce((n, t) => n + t.netUsd, 0) }}
      lost={{ n: lost.length, usd: lost.reduce((n, t) => n + t.netUsd, 0) }}
      onOpen={onOpen}
      note={`Each trade after its charges${open ? ` · ${open} still open, in neither` : ''}${unfiltered ? ' · every trade of the day, whatever the filters' : ''}. Tap one to see its trades.`}
    />
  );
}

/**
 * The Won and Lost card itself, from counts already made: a bar of how the swing split, a button each side, a line
 * under them. `picked` makes the two a toggle (History, 9 Nov 2026: the list shown only the won, or only the lost,
 * a tap again for all); without it each opens its trades elsewhere.
 */
export function WonLostView({ won, lost, onOpen, note, picked }: {
  won: { n: number; usd: number }; lost: { n: number; usd: number }; onOpen: (o: Outcome) => void; note: string;
  picked?: Outcome | null;
}) {
  const scale = won.usd - lost.usd;
  const toggle = picked !== undefined;
  return (
    <section aria-label="Won and lost" className="mt-3">
      {/* How much of the swing the winners made and the losers gave back; the words below carry it, not the colour. */}
      {scale > 0 && (
        <div aria-hidden="true" className="mb-2 flex h-2 overflow-hidden rounded-full bg-muted">
          <span className="bg-[var(--up)]" style={{ width: `${(won.usd / scale) * 100}%` }} />
          <span className="bg-[var(--down)]" style={{ width: `${(-lost.usd / scale) * 100}%` }} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Side word="Won" tone="up" n={won.n} usd={won.usd} onOpen={() => onOpen('win')} pressed={toggle ? picked === 'win' : undefined} />
        <Side word="Lost" tone="down" n={lost.n} usd={lost.usd} onOpen={() => onOpen('loss')} pressed={toggle ? picked === 'loss' : undefined} />
      </div>
      <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">{note}</p>
    </section>
  );
}

function Side({ word, tone, n, usd, onOpen, pressed }: { word: string; tone: 'up' | 'down'; n: number; usd: number; onOpen: () => void; pressed?: boolean }) {
  const trades = `${n} trade${n === 1 ? '' : 's'}`;
  const verb = pressed === undefined ? 'Show them' : pressed ? 'Showing only these; show all' : 'Show only these';
  return (
    <button
      type="button" onClick={onOpen} disabled={n === 0 && !pressed} aria-pressed={pressed}
      aria-label={n ? `${word}: ${trades}, ${money(usd)}. ${verb}` : `${word}: none`}
      className={cn('flex min-h-[56px] min-w-0 items-center justify-between gap-1 rounded-lg border border-solid px-2.5 py-2 text-left font-[inherit] text-foreground active:bg-muted disabled:opacity-60',
        pressed ? 'border-[var(--chosen-line)] bg-[var(--chosen-soft)]' : 'border-border bg-transparent')}
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-[12px] text-muted-foreground">{word} · {trades}</span>
        <span className={cn('truncate text-[16px] font-semibold tabular-nums', n > 0 && (tone === 'up' ? 'text-[var(--up)]' : 'text-[var(--down)]'))}>
          {n ? money(usd) : '—'}
        </span>
      </span>
      {n > 0 && <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </button>
  );
}
