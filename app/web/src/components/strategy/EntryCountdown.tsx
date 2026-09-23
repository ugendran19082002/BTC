import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { cn } from '@/lib/utils';

/** "2h 05m 09s", "12m 34s", "45s"; a day or more reads "1d 3h". */
export function countdownText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${two(m)}m ${two(sec)}s`;
  if (m > 0) return `${m}m ${two(sec)}s`;
  return `${sec}s`;
}

/** "10:35 PM" in IST, whatever the phone's own time zone. */
const istClock = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();

/**
 * The time left until an armed strategy enters, ticking every second.
 *
 * The server says when (`nextEntryAt`, refreshed every five seconds); this
 * counts down between those reads so the number moves like a timer. It says
 * plainly when nothing will happen however the timer reads -- auto-trading off
 * -- because a countdown to an entry that cannot fire is worse than none.
 */
export function EntryCountdown({ nextEntryAt, schedulerOn, now: fixedNow }: {
  nextEntryAt: number | null;
  schedulerOn: boolean;
  /** For tests: a fixed clock instead of a ticking one. */
  now?: number;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixedNow !== undefined || nextEntryAt === null) return;
    const id = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [fixedNow, nextEntryAt]);
  if (nextEntryAt === null) return null;
  const now = fixedNow ?? tick;
  const left = nextEntryAt - now;
  const at = istClock(nextEntryAt);

  if (!schedulerOn) {
    return (
      <p role="status" className="m-0 mt-1.5 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md bg-[var(--warn)]/10 px-2 py-1 text-[12px] text-[var(--warn)]">
        <Timer className="h-3.5 w-3.5 flex-none" aria-hidden />
        <span>Auto-trading is off -- it will not enter at {at} IST. Turn auto-trading on above.</span>
      </p>
    );
  }
  return (
    <p role="timer" aria-live="off"
       className={cn('m-0 mt-1.5 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md px-2 py-1 text-[12px]',
         left <= 0 ? 'bg-[var(--up)]/15 text-[var(--up)]' : 'bg-[var(--up)]/10 text-foreground')}>
      <Timer className="h-3.5 w-3.5 flex-none text-[var(--up)]" aria-hidden />
      {left <= 0
        ? <b>Entering now…</b>
        : <span>Entry in <b className="tabular-nums">{countdownText(left)}</b> <span className="text-muted-foreground">· {at} IST</span></span>}
    </p>
  );
}
