import { useEffect, useState } from 'react';
import { CalendarX, X } from 'lucide-react';
import { getSkipDays, saveSkipDays } from '@/api/strategy';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { istToday } from '@/components/ui/date-range-picker';
import { cn } from '@/lib/utils';

/**
 * The days every pick skips (owner, 9 Nov 2026: "beside Pick now, skip Nov 4 and so on -- many dates chosen, saved on the
 * DB side; the pick runs skipping them"; then "use the date picker component"). One list for the desk, kept by the
 * server. "Choose days" opens the desk's own calendar with every saved day marked: a click on a day adds it or takes it
 * out, as many as wanted, and Save sends the lot at once; the × on a chip takes one day out straight away. The day's own
 * run, Pick now and the form's preview all leave these days out of their look-back -- which reaches one day further
 * back for each, so a 14-day look-back is still 14 days of record.
 */
const CHIP = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const label = (d: string) => CHIP.format(new Date(`${d}T00:00:00Z`));
/** Midday UTC, so no zone can move the day (as the range picker does). */
const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const fromDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sameList = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

/** `onDays`: told the list as it is read and after each save -- Pick now says it in its question (9 Nov 2026). */
export function SkipDays({ onDays }: { onDays?: (days: string[]) => void } = {}) {
  const [days, setDays] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const today = istToday();
  useEffect(() => { if (days) onDays?.(days); }, [days, onDays]);

  useEffect(() => {
    let live = true;
    getSkipDays().then((r) => { if (live) setDays(r.days); }, (e: Error) => { if (live) { setDays([]); setProblem(`Could not read the days to skip: ${e.message}`); } });
    return () => { live = false; };
  }, []);
  // The calendar opens on the list as saved; what is clicked stays a draft until Save.
  useEffect(() => { if (open) setDraft(days ?? []); }, [open, days]);

  const save = async (next: string[]): Promise<boolean> => {
    setSaving(true);
    setProblem(null);
    try {
      setDays((await saveSkipDays(next)).days);
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const chip = 'inline-flex h-7 items-center gap-1 rounded-full border border-solid px-2.5 text-[12px]';
  const btn = 'm-0 inline-flex h-7 appearance-none items-center gap-1.5 rounded-md border border-solid px-2.5 font-[inherit] text-[12px]';
  const changed = !sameList(draft, days ?? []);
  return (
    <div role="group" aria-label="Days every pick skips" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-[12px] text-muted-foreground">Skip days</span>
      {days === null ? <span className="text-[12px] text-muted-foreground">…</span> : days.length === 0 ? (
        <span className="text-[12px] text-muted-foreground">none, every day counts</span>
      ) : days.map((d) => (
        <span key={d} className={cn(chip, 'border-[var(--warn)] text-foreground')}>
          <span className="tabular-nums">{label(d)}</span>
          <button type="button" aria-label={`Stop skipping ${label(d)}`} disabled={saving} onClick={() => void save(days.filter((x) => x !== d))}
                  className="-mr-1 grid h-5 w-5 place-items-center rounded-full border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground disabled:opacity-50">
            <X aria-hidden className="h-3 w-3" />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger disabled={days === null || saving}
                        className={cn(btn, 'border-border bg-transparent text-muted-foreground hover:border-[var(--accent)] hover:text-foreground disabled:opacity-50')}>
          <CalendarX aria-hidden className="h-3.5 w-3.5" />
          Choose days
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-auto flex-col gap-2 p-3">
          <p className="m-0 max-w-[15rem] text-[12px] leading-snug text-muted-foreground">
            Click days to skip or to count again. Every pick leaves them out. IST expiry days.
          </p>
          <Calendar
            mode="multiple"
            selected={draft.map(toDate)}
            onSelect={(picked) => setDraft((picked ?? []).map(fromDate).filter((d) => d <= today))}
            defaultMonth={toDate(days?.[0] ?? today)}
            // A day to come has no record to skip.
            disabled={(d) => fromDate(d) > today}
            numberOfMonths={1}
          />
          <div className="flex items-center justify-between gap-2">
            <span aria-live="polite" className="text-[12px] tabular-nums text-muted-foreground">
              {draft.length === 0 ? 'No day skipped' : `${draft.length} ${draft.length === 1 ? 'day' : 'days'} skipped`}
            </span>
            <div className="flex gap-1.5">
              {draft.length > 0 && (
                <button type="button" onClick={() => setDraft([])} className={cn(btn, 'border-border bg-transparent text-muted-foreground')}>Clear</button>
              )}
              <button type="button" disabled={!changed || saving}
                      onClick={() => { void save(draft).then((ok) => { if (ok) setOpen(false); }); }}
                      className={cn(btn, 'border-primary bg-primary font-semibold text-primary-foreground disabled:opacity-50')}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {problem && <span role="alert" className="text-[12px] text-[var(--down)]">{problem}</span>}
    </div>
  );
}
