import { MAX_NO_ENTRY_WINDOWS, type NoEntry, type NoEntryWindow, type StrategyConfig } from '@/types/strategy';
import { isHhmm, minutesForward, minutesOf, time12 } from '@/lib/time';

/**
 * A signal strategy's no-entry windows (owner, 9 Oct 2026: "no entry window ... from time to time"; "trades
 * taken before must not be closed, no new entry inside the range"): the browser's copy of the server's rules,
 * word for word (app/server/src/strategy/types.ts `noEntryProblems`, `noEntryWindowAt`). The server stays the
 * authority.
 */

/** "5:00 PM – 6:00 PM". */
export const noEntryWords = (w: NoEntryWindow): string => `${time12(w.from)} – ${time12(w.to)}`;

/** The window `istMinute` falls in, when the switch is on; null when entries are open. */
export function noEntryWindowAt(c: Pick<StrategyConfig, 'noEntry'>, istMinute: number): NoEntryWindow | null {
  if (!c.noEntry?.on) return null;
  return c.noEntry.windows.find((w) => isHhmm(w.from) && isHhmm(w.to)
    && minutesForward(minutesOf(w.from), istMinute) < minutesForward(minutesOf(w.from), minutesOf(w.to))) ?? null;
}

/**
 * What is wrong with the windows, in the server's words; an empty list when nothing is. Signal strategies only.
 * Held to the strategy's own entry and exit (owner, 9 Oct 2026): each wholly inside them, none all of them, no
 * two over the same minutes.
 */
export function noEntryProblems(n: NoEntry | null | undefined, entryTime: string, exitTime: string): string[] {
  if (!n || !n.on) return [];
  if (n.windows.length === 0) return ['Add a no-entry window, or switch it off.'];
  if (n.windows.length > MAX_NO_ENTRY_WINDOWS) return [`At most ${MAX_NO_ENTRY_WINDOWS} no-entry windows.`];
  const bad: string[] = [];
  const several = n.windows.length > 1;
  const timesOk = isHhmm(entryTime) && isHhmm(exitTime) && entryTime !== exitTime;
  const entry = timesOk ? minutesOf(entryTime) : 0;
  const span = timesOk ? minutesForward(entry, minutesOf(exitTime)) : 0;
  const placed: { i: number; at: number; end: number }[] = [];
  n.windows.forEach((w, i) => {
    const which = several ? `No-entry window ${i + 1}` : 'The no-entry window';
    if (!isHhmm(w.from) || !isHhmm(w.to)) { bad.push(`${which} needs a from and an until time, like 5:00 PM.`); return; }
    if (w.from === w.to) { bad.push(`${which} is empty: from and until are both ${time12(w.from)}.`); return; }
    if (!timesOk) return;
    const at = minutesForward(entry, minutesOf(w.from));
    const end = at + minutesForward(minutesOf(w.from), minutesOf(w.to));
    if (at >= span || end > span) {
      bad.push(`${which} (${noEntryWords(w)}) must lie inside this strategy's ${time12(entryTime)} – ${time12(exitTime)}: `
        + `from ${time12(entryTime)} or later, until ${time12(exitTime)} or earlier.`);
      return;
    }
    if (at === 0 && end === span) {
      bad.push(`${which} (${noEntryWords(w)}) covers all of ${time12(entryTime)} – ${time12(exitTime)}: no signal could be taken. Switch the strategy off instead.`);
      return;
    }
    placed.push({ i, at, end });
  });
  placed.sort((a, b) => a.at - b.at);
  for (let k = 1; k < placed.length; k++) {
    const a = placed[k - 1]!, b = placed[k]!;
    if (b.at < a.end) bad.push(`No-entry windows ${Math.min(a.i, b.i) + 1} and ${Math.max(a.i, b.i) + 1} overlap: make them one window.`);
  }
  return bad;
}

/**
 * The window "+ Add another" offers: the half hour (or what is left) just before the earliest one already set,
 * so it never starts out overlapping it; the first one's suggestion when there is no room before it.
 */
export function nextWindow(existing: readonly NoEntryWindow[], entryTime: string, exitTime: string): NoEntryWindow {
  const set = existing.filter((w) => isHhmm(w.from) && isHhmm(w.to));
  if (!set.length || !isHhmm(entryTime) || !isHhmm(exitTime)) return suggestedWindow(entryTime, exitTime);
  const entry = minutesOf(entryTime);
  const first = Math.min(...set.map((w) => minutesForward(entry, minutesOf(w.from))));
  const len = Math.min(30, first);
  const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  return len >= 1 ? { from: hhmm(entry + first - len), to: hhmm(entry + first) } : suggestedWindow(entryTime, exitTime);
}

/** The bounds a window's pickers offer: from the entry to a minute before the exit; until, a minute after its from to the exit. */
export function pickerBounds(entryTime: string, exitTime: string, from: string): { fromMin: string | null; fromMax: string | null; toMin: string | null; toMax: string | null } {
  const ok = isHhmm(entryTime) && isHhmm(exitTime);
  const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  return {
    fromMin: ok ? entryTime : null,
    fromMax: ok ? hhmm(minutesOf(exitTime) - 1) : null,
    toMin: ok && isHhmm(from) ? hhmm(minutesOf(from) + 1) : null,
    toMax: ok ? exitTime : null,
  };
}

/**
 * A first window that makes sense for this strategy: the last half hour before its exit, which is when a new
 * entry has the least time left to work -- inside the strategy's own hours, so it is never "outside".
 */
export function suggestedWindow(entryTime: string, exitTime: string): NoEntryWindow {
  if (!isHhmm(entryTime) || !isHhmm(exitTime)) return { from: '16:30', to: '17:00' };
  const span = minutesForward(minutesOf(entryTime), minutesOf(exitTime));
  const len = Math.min(30, Math.max(1, Math.floor(span / 2)));
  const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  return { from: hhmm(minutesOf(exitTime) - len), to: exitTime };
}
