import { useEffect, useState } from 'react';
import { CalendarX, Plus, X } from 'lucide-react';
import { getSkipDays, saveSkipDays } from '@/api/strategy';
import { cn } from '@/lib/utils';

/**
 * The days every pick skips (owner, 9 Nov 2026: "beside Pick now, skip Nov 4 and so on -- many dates chosen, saved on the
 * DB side; the pick runs skipping them"). One list for the desk, kept by the server: a day added or taken out is saved
 * at once, and the day's own run, Pick now and the form's preview all leave those days out of their look-back -- which
 * reaches one day further back for each, so a 14-day look-back is still 14 days of record.
 */
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const label = (d: string) => DAY.format(new Date(`${d}T00:00:00Z`));
/** Today in IST: no later day can be chosen (the server refuses days to come). */
const lastDay = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function SkipDays() {
  const [days, setDays] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSkipDays().then((r) => { if (live) setDays(r.days); }, (e: Error) => { if (live) { setDays([]); setProblem(`Could not read the days to skip: ${e.message}`); } });
    return () => { live = false; };
  }, []);

  const save = async (next: string[]) => {
    setSaving(true);
    setProblem(null);
    try {
      setDays((await saveSkipDays(next)).days);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const add = (d: string) => {
    setAdding(false);
    if (!d || !days || days.includes(d)) return;
    void save([...days, d]);
  };

  const chip = 'm-0 inline-flex h-7 appearance-none items-center gap-1 rounded-full border border-solid px-2.5 font-[inherit] text-[12px]';
  return (
    <div role="group" aria-label="Days every pick skips" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
        <CalendarX aria-hidden className="h-3.5 w-3.5" />
        Skip days
      </span>
      {days === null ? <span className="text-[12px] text-muted-foreground">…</span> : days.length === 0 && !adding ? (
        <span className="text-[12px] text-muted-foreground">none, every day counts</span>
      ) : days.map((d) => (
        <span key={d} className={cn(chip, 'border-[var(--warn)] bg-transparent text-foreground')}>
          <span className="tabular-nums">{label(d)}</span>
          <button type="button" aria-label={`Stop skipping ${label(d)}`} disabled={saving} onClick={() => void save(days.filter((x) => x !== d))}
                  className="-mr-1 grid h-5 w-5 place-items-center rounded-full border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground disabled:opacity-50">
            <X aria-hidden className="h-3 w-3" />
          </button>
        </span>
      ))}
      {adding ? (
        <input type="date" autoFocus aria-label="Day to skip" max={lastDay()} disabled={saving}
               onChange={(e) => add(e.target.value)} onBlur={() => setAdding(false)}
               onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }}
               className="h-7 rounded-md border border-solid border-border bg-[var(--bg)] px-2 text-[12px] text-foreground" />
      ) : (
        <button type="button" onClick={() => setAdding(true)} disabled={saving || days === null}
                className={cn(chip, 'border-border bg-transparent text-muted-foreground hover:text-foreground disabled:opacity-50')}>
          <Plus aria-hidden className="h-3 w-3" /> Add day
        </button>
      )}
      {problem && <span role="alert" className="text-[12px] text-[var(--down)]">{problem}</span>}
    </div>
  );
}
