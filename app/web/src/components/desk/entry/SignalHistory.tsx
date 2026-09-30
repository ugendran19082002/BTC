import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { getEntrySignals } from '@/api/entry';
import { cn } from '@/lib/utils';
import type { EntryMode, EntrySignal, EntryTf } from '@/types/entry';

/**
 * Every signal the server kept (the journal, entry_signals): when, which
 * method, which way and timeframe, BUY / SELL, WAIT or TRADE, how long it
 * stood, its levels, the gates it stood on -- and for a TRADE, what became of
 * it in the paper log. Newest first, refreshed every 15 s; the filters are
 * remembered per browser.
 */

const TFS: readonly EntryTf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmt = (v: number | null) => (v === null ? '–' : Math.round(v).toLocaleString('en-US'));

/** How long a signal stood: "just now", "4 min", "1 h 12 min". */
export function stood(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** What became of a TRADE, in words and a colour. */
export function outcomeOf(s: EntrySignal): { text: string; cls: string } {
  if (s.state === 'WAIT') return { text: 'waited', cls: 'text-muted-foreground' };
  const o = s.outcome;
  if (!o) return { text: 'not logged', cls: 'text-muted-foreground' };
  const r = o.rNet === null ? '' : ` ${o.rNet >= 0 ? '+' : '−'}${Math.abs(o.rNet).toFixed(2)}R`;
  switch (o.status) {
    case 'open': return { text: 'waiting for price', cls: 'text-[var(--warn)]' };
    case 'filled': return { text: `in the trade @ ${fmt(o.fillPrice)}`, cls: 'text-[#3b82f6]' };
    case 'tp1': return { text: `TP1 ✓${r}`, cls: 'text-[var(--up)]' };
    case 'stop': return { text: `stop ✗${r}`, cls: 'text-[var(--down)]' };
    case 'timeout': return { text: `timed out${r}`, cls: 'text-muted-foreground' };
    case 'expired': return { text: 'expired, never filled', cls: 'text-muted-foreground' };
    default: return { text: o.status, cls: 'text-muted-foreground' };
  }
}

type Filter = { mode: 'all' | EntryMode; tf: 'all' | EntryTf; state: 'all' | 'TRADE' | 'WAIT'; today: boolean };

export function SignalHistory() {
  const [f, setF] = usePersisted<Filter>('entry:history-filter', { mode: 'all', tf: 'all', state: 'all', today: true });
  const since = f.today ? startOfIstDay(Date.now()) : undefined;
  const { data, loading, error } = usePoll(
    () => getEntrySignals({
      mode: f.mode === 'all' ? undefined : f.mode, tf: f.tf === 'all' ? undefined : f.tf,
      state: f.state === 'all' ? undefined : f.state, since, limit: 200,
    }),
    15_000, { deps: [f.mode, f.tf, f.state, f.today] },
  );
  const rows = data?.signals ?? [];
  const trades = rows.filter((s) => s.state === 'TRADE');
  const chip = (on: boolean) => cn('px-2 py-0.5', on ? 'bg-[#2563eb] text-white' : 'text-muted-foreground');

  return (
    <section aria-label="signal history" className="mt-3 rounded-xl border border-border p-2.5 text-[12px]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="m-0 text-[13px] font-bold">Signal history</h3>
          <p className="m-0 text-[11px] text-muted-foreground">
            Every signal the server kept, whichever chart was on screen
            {rows.length ? ` · ${rows.length} shown · ${trades.length} TRADE${trades.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <div role="group" aria-label="history way" className="inline-flex overflow-hidden rounded border border-border">
            {(['all', 'single', 'mtf'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={f.mode === m} onClick={() => setF({ ...f, mode: m })} className={chip(f.mode === m)}>
                {m === 'all' ? 'Both' : m === 'single' ? 'Without TF' : 'With TF'}
              </button>
            ))}
          </div>
          <div role="group" aria-label="history state" className="inline-flex overflow-hidden rounded border border-border">
            {(['all', 'TRADE', 'WAIT'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={f.state === s} onClick={() => setF({ ...f, state: s })} className={chip(f.state === s)}>
                {s === 'all' ? 'All' : s}
              </button>
            ))}
          </div>
<div role="group" aria-label="history timeframe" className="inline-flex overflow-hidden rounded border border-border">
            {(['all', ...TFS] as const).map((t) => (
              <button key={t} type="button" aria-pressed={f.tf === t} onClick={() => setF({ ...f, tf: t })} className={chip(f.tf === t)}>
                {t === 'all' ? 'All TF' : t}
              </button>
            ))}
          </div>
          <button type="button" aria-pressed={f.today} onClick={() => setF({ ...f, today: !f.today })} className={cn('rounded border border-border', chip(f.today))}>
            {f.today ? 'Today' : 'All days'}
          </button>
        </div>
      </div>

      {error && !data ? <p role="alert" className="m-0 text-[var(--down)]">Could not read the history: {error.message}</p> : null}
      {!rows.length ? (
        <p className="m-0 py-3 text-center text-muted-foreground">
          {loading && !data ? 'Reading…' : 'No signals for these filters yet. The server keeps every WAIT and TRADE as it forms, once a minute.'}
        </p>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full border-collapse tabular-nums" aria-label="signals">
            <thead className="sticky top-0 bg-[var(--card,#0b0f17)] text-left text-[10.5px] text-muted-foreground">
              <tr>
                <th className="py-1 pr-2">Time (IST)</th>
                <th className="pr-2">Method</th>
                <th className="pr-2">Way · TF</th>
                <th className="pr-2">Signal</th>
                <th className="hidden pr-2 md:table-cell">Stood</th>
                <th className="pr-2">Entry</th>
                <th className="hidden pr-2 sm:table-cell">SL</th>
                <th className="hidden pr-2 sm:table-cell">TP1</th>
                <th className="hidden pr-2 lg:table-cell">R:R</th>
                <th className="hidden pr-2 lg:table-cell">Quality</th>
                <th className="pr-2">What became of it</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const out = outcomeOf(s);
                const side = s.dir === 1 ? 'BUY' : 'SELL';
                return (
                  <tr key={`${s.mode}:${s.tf}:${s.method}:${s.dir}:${s.triggerAt}:${s.state}`} className="border-t border-border align-top"
                      title={`${s.reason}${s.gatesOff.length ? ` -- gates off: ${s.gatesOff.join(', ')}` : ''}`}>
                    <td className="whitespace-nowrap py-1 pr-2">{TIME.format(s.firstSeen)}</td>
                    <td className="pr-2">#{s.n ?? '?'} {s.name}</td>
                    <td className="whitespace-nowrap pr-2 text-muted-foreground">{s.mode === 'mtf' ? 'With TF' : 'Without'} · {s.tf}</td>
                    <td className="whitespace-nowrap pr-2">
                      <span className={cn('rounded px-1 font-bold', s.state === 'WAIT' ? 'bg-[#b7791f] text-white' : s.dir === 1 ? 'bg-[#26a17b] text-white' : 'bg-[#e2504f] text-white')}>
                        {s.state === 'WAIT' ? `WAIT ${side}` : side}
                      </span>
                      {s.gatesOff.length ? <span className="ml-1 text-[10px] text-[var(--warn)]" title={`gates off: ${s.gatesOff.join(', ')}`}>gates off</span> : null}
                    </td>
                    <td className="hidden whitespace-nowrap pr-2 text-muted-foreground md:table-cell">{stood(s.lastSeen - s.firstSeen)}</td>
                    <td className="whitespace-nowrap pr-2">{s.entryLo === null ? '–' : `${fmt(s.entryLo)}–${fmt(s.entryHi)}`}</td>
                    <td className="hidden whitespace-nowrap pr-2 text-[var(--down)] sm:table-cell">{fmt(s.stop)}</td>
                    <td className="hidden whitespace-nowrap pr-2 text-[var(--up)] sm:table-cell">{fmt(s.tp1)}</td>
                    <td className="hidden pr-2 lg:table-cell">{s.rr === null ? '–' : s.rr.toFixed(2)}</td>
                    <td className="hidden pr-2 lg:table-cell">{s.score ?? '–'}</td>
                    <td className={cn('whitespace-nowrap pr-2', out.cls)}>{out.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Midnight in IST, as epoch ms: the desk's "today". */
export function startOfIstDay(now: number): number {
  const IST = 5.5 * 3_600_000;
  return Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST;
}
