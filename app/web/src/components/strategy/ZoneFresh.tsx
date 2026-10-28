import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { ZONE_FRESH_DEFAULT_S, ZONE_FRESH_MAX_S, ZONE_FRESH_MIN_S, type SignalTf } from '@/types/strategy';

/**
 * The fill window (owner, 28 Oct 2026: "the zone-fill table on the screen -- dynamic: UI, backend, DB"): how late a perp
 * zone fill may still be entered as an option, seconds by time frame, this account's. A pill beside the strike limit --
 * "default", or how many are set -- opening to the seven figures, each with its default beside it. Saved, the next signal
 * is held to it; "Defaults" puts every time frame back.
 */
const TFS: readonly SignalTf[] = ['3m', '5m', '15m', '30m', '1h', '2h', '4h'];

/** "90 s", "2.5 min", "10 min": a window in words. */
export function freshWords(s: number): string {
  if (s < 120) return `${s} s`;
  const m = s / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/** Why a typed figure cannot be saved; null when it can. */
const problemOf = (tf: SignalTf, text: string): string | null => {
  const n = Number(text);
  return text.trim() !== '' && Number.isInteger(n) && n >= ZONE_FRESH_MIN_S && n <= ZONE_FRESH_MAX_S
    ? null : `${tf}: whole seconds from ${ZONE_FRESH_MIN_S} to ${ZONE_FRESH_MAX_S}.`;
};

export function ZoneFresh({ seconds, busy, onSave }: {
  /** The account's window as saved: every time frame, the defaults included. */
  seconds: Record<SignalTf, number>;
  busy?: boolean;
  /** Only the time frames off their default; null, all of them back to it. */
  onSave: (changed: Partial<Record<SignalTf, number>> | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<Record<SignalTf, string>>(() => Object.fromEntries(TFS.map((tf) => [tf, String(seconds[tf])])) as Record<SignalTf, string>);
  useEffect(() => { if (!open) setText(Object.fromEntries(TFS.map((tf) => [tf, String(seconds[tf])])) as Record<SignalTf, string>); }, [open, seconds]);
  const changedNow = TFS.filter((tf) => seconds[tf] !== ZONE_FRESH_DEFAULT_S[tf]);
  const problems = TFS.map((tf) => problemOf(tf, text[tf])).filter((p): p is string => p !== null);
  const typed = Object.fromEntries(TFS.map((tf) => [tf, Number(text[tf])])) as Record<SignalTf, number>;
  const edited = TFS.some((tf) => typed[tf] !== seconds[tf]);
  const save = async (changed: Partial<Record<SignalTf, number>> | null) => { if (await onSave(changed)) setOpen(false); };
  const field = 'm-0 h-7 w-16 rounded border border-solid border-border bg-[var(--bg)] px-1.5 text-right font-[inherit] text-[12px] tabular-nums text-foreground';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="desk-badge-pill inline-flex cursor-pointer items-center gap-1.5"
        title="How late a perp zone fill may still be entered as an option, by time frame, this account's. Past it the signal is skipped as too late."
        style={{ background: 'color-mix(in_srgb,_var(--text)_5%,_transparent)', color: 'var(--text)', border: '1px solid var(--line)' }}
      >
        <span>Fill window</span>
        <span className="text-muted-foreground">{changedNow.length ? `${changedNow.length} set` : 'default'}</span>
      </PopoverTrigger>
      <PopoverContent aria-label="Fill window by time frame" className="w-[17rem]">
        <p className="m-0 mb-2 text-[12px] leading-snug text-muted-foreground">
          After the perp fills in the zone, the option order must go within this. Later, the signal is skipped as too late.
        </p>
        <div className="grid grid-cols-[2.5rem_auto_1fr] items-center gap-x-2 gap-y-1">
          {TFS.map((tf) => (
            <label key={tf} className="contents">
              <span className="text-[12px] font-medium">{tf}</span>
              <input
                aria-label={`${tf} fill window, seconds`} inputMode="numeric" value={text[tf]} disabled={busy}
                onChange={(e) => setText({ ...text, [tf]: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })}
                className={cn(field, problemOf(tf, text[tf]) && 'border-[var(--down)]')}
              />
              <span className={cn('text-[11px]', typed[tf] !== ZONE_FRESH_DEFAULT_S[tf] ? 'text-[var(--accent)]' : 'text-[var(--dim)]')}>
                {Number.isFinite(typed[tf]) && text[tf] !== '' ? freshWords(typed[tf]) : '--'} · default {freshWords(ZONE_FRESH_DEFAULT_S[tf])}
              </span>
            </label>
          ))}
        </div>
        {problems.length > 0 && <p role="alert" className="m-0 mt-2 text-[11.5px] text-[var(--down)]">{problems[0]}</p>}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" disabled={busy || problems.length > 0 || !edited}
                  onClick={() => { const ch = Object.fromEntries(TFS.filter((tf) => typed[tf] !== ZONE_FRESH_DEFAULT_S[tf]).map((tf) => [tf, typed[tf]])); void save(Object.keys(ch).length ? ch : null); }}
                  className="m-0 h-8 appearance-none rounded-md border-0 bg-primary px-3 font-[inherit] text-[12px] font-semibold text-primary-foreground disabled:opacity-50">
            Save
          </button>
          <button type="button" disabled={busy || changedNow.length === 0} onClick={() => void save(null)}
                  className="m-0 h-8 appearance-none rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[12px] text-muted-foreground disabled:opacity-50">
            Defaults
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
