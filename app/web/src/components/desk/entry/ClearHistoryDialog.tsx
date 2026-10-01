import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Checkbox } from '@/components/ui/checkbox';
import { clearHistory, previewClear, type ClearAnswer, type ClearCounts, type ClearRange } from '@/api/entry';
import { cn } from '@/lib/utils';

/**
 * Clear data (owner, 1 Oct 2026: "clear data button -- a dialog, from date-time
 * and to date-time, clears that signal history"). Both times are IST, to the
 * minute, the To minute included. What would go is counted first, live, and
 * the clear needs the box ticked: it cannot be undone. The server takes the
 * signals with their paper trades and alerts, and logs the clear itself.
 */

const IST_MS = 19_800_000;
const MIN = 60_000;
/** A time as a `datetime-local` value in IST, whatever the browser's own zone. */
export const istInput = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 16);
/** A `datetime-local` value read as IST; null when not a time. */
export const fromIstInput = (v: string): number | null => {
  const t = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(v) ? Date.parse(`${v}:00Z`) : NaN;
  return Number.isFinite(t) ? t - IST_MS : null;
};
const istDayStart = (ms: number) => Math.floor((ms + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;
const SHOWN = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const n = (x: number) => x.toLocaleString('en-US');

/** Quick ranges: [from, to-minute] as the inputs show them. */
const PRESETS: { label: string; of: (now: number) => [number, number] }[] = [
  { label: 'Last hour', of: (now) => [now - 60 * MIN, now] },
  { label: 'Today', of: (now) => [istDayStart(now), now] },
  { label: 'Yesterday', of: (now) => [istDayStart(now) - 86_400_000, istDayStart(now) - MIN] },
  { label: 'Last 7 days', of: (now) => [istDayStart(now) - 6 * 86_400_000, now] },
];

/** The range the inputs say: To's whole minute included. Or what is wrong with them. */
export function rangeOf(fromText: string, toText: string): ClearRange | { error: string } {
  const from = fromIstInput(fromText), toMin = fromIstInput(toText);
  if (from === null || toMin === null) return { error: 'Pick both times.' };
  if (toMin < from) return { error: 'From must be before To.' };
  return { from, to: toMin + MIN };
}

export function ClearHistoryDialog({ onCleared }: { onCleared: (c: ClearCounts) => void }) {
  const [open, setOpen] = useState(false);
  const [fromText, setFrom] = useState('');
  const [toText, setTo] = useState('');
  const [preview, setPreview] = useState<ClearAnswer | null>(null);
  const [checking, setChecking] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const range = rangeOf(fromText, toText);
  const bad = 'error' in range ? range.error : null;

  const pick = ([a, b]: [number, number]) => { setFrom(istInput(a)); setTo(istInput(b)); };
  const openWith = (on: boolean) => {
    setOpen(on);
    if (on) { pick(PRESETS[1]!.of(Date.now())); setSure(false); setError(null); setPreview(null); }
  };

  // What would go, counted as the times change (a moment after the last keystroke).
  useEffect(() => {
    if (!open || 'error' in range) { setPreview(null); return; }
    let live = true;
    setChecking(true);
    const t = setTimeout(() => {
      previewClear(range).then((p) => { if (live) { setPreview(p); setError(null); } }, (e: Error) => { if (live) setError(e.message); })
        .finally(() => { if (live) setChecking(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [open, fromText, toText]);

  const c = preview?.counts;
  const can = !bad && !!c && c.signals > 0 && sure && !busy && !checking;
  const clear = async () => {
    if ('error' in range) return;
    setBusy(true); setError(null);
    try {
      const done = await clearHistory(range);
      onCleared(done.counts);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={openWith}>
      <button type="button" onClick={() => openWith(true)} aria-label="clear data"
              title="Clear the signal history between two times"
              className="inline-flex items-center gap-1 rounded-md border border-[#e2504f] px-2.5 py-1 font-semibold text-[#e2504f] hover:bg-[#e2504f]/10">
        <Trash2 size={13} aria-hidden /> Clear data
      </button>
      {open ? (
        <SheetContent title="Clear signal history" description="Signals first seen between these times (IST) -- with their paper trades and alerts.">
          <div className="flex flex-col gap-3 text-[12.5px]">
            <div role="group" aria-label="quick ranges" className="flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => pick(p.of(Date.now()))}
                        className="rounded-md border border-border px-2.5 py-1 font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-muted-foreground">From (IST)</span>
                <input type="datetime-local" aria-label="from" value={fromText} max={toText || undefined} onChange={(e) => { setFrom(e.target.value); setSure(false); }}
                       className="h-9 rounded-md border border-border bg-muted px-2 text-foreground [color-scheme:dark]" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-muted-foreground">To (IST, this minute included)</span>
                <input type="datetime-local" aria-label="to" value={toText} min={fromText || undefined} onChange={(e) => { setTo(e.target.value); setSure(false); }}
                       className="h-9 rounded-md border border-border bg-muted px-2 text-foreground [color-scheme:dark]" />
              </label>
            </div>

            <div role="status" aria-live="polite" className="rounded-md bg-muted px-3 py-2">
              {bad ? <span className="text-[var(--down)]">{bad}</span>
                : !c ? <span className="text-muted-foreground">Counting…</span>
                : c.signals === 0 ? <span className="text-muted-foreground">Nothing in this range.</span>
                : (
                  <>
                    <div className="font-bold">{n(c.signals)} signal{c.signals === 1 ? '' : 's'} will be cleared</div>
                    <div className="text-[11.5px] text-muted-foreground">
                      {n(c.trades)} TRADE{c.trades === 1 ? '' : 's'} · {n(c.waits)} WAIT{c.waits === 1 ? '' : 's'} · {n(c.setups)} paper trade{c.setups === 1 ? '' : 's'} · {n(c.alerts)} alert{c.alerts === 1 ? '' : 's'}
                    </div>
                  </>
                )}
            </div>
            <p className="m-0 text-[11px] text-muted-foreground">
              Totals and tabs recount without them. A setup still on the board stays cleared; new signals keep coming.
            </p>

            {preview?.recent.length ? (
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">Last clears</summary>
                <ul className="m-0 mt-1 list-none p-0">
                  {preview.recent.map((r) => (
                    <li key={r.at}>{SHOWN.format(r.at)}: {SHOWN.format(r.from)} → {SHOWN.format(r.to - MIN)} · {n(r.signals)} signals, {n(r.setups)} paper trades, {n(r.alerts)} alerts</li>
                  ))}
                </ul>
              </details>
            ) : null}

            {error ? <p role="alert" className="m-0 text-[var(--down)]">Could not clear: {error}</p> : null}
            <Checkbox label="I understand this cannot be undone" checked={sure} disabled={!c || c.signals === 0}
                      onChange={(e) => setSure(e.target.checked)} />
          </div>
          <SheetFooter>
            <button type="button" onClick={() => setOpen(false)}
                    className="h-9 flex-1 rounded-md border border-border font-semibold text-muted-foreground hover:bg-muted">
              Cancel
            </button>
            <button type="button" onClick={clear} disabled={!can}
                    className={cn('h-9 flex-1 rounded-md font-semibold text-white', can ? 'bg-[#e2504f] hover:opacity-90' : 'cursor-not-allowed bg-[#e2504f]/40')}>
              {busy ? 'Clearing…' : c && c.signals > 0 ? `Clear ${n(c.signals)} signal${c.signals === 1 ? '' : 's'}` : 'Clear'}
            </button>
          </SheetFooter>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
