import { cn } from '@/lib/utils';
import type { MethodRead } from '@/types/entry';
import { MINS, SECS, TF_SEC, clockText, lag, span, useNow } from './clock';
import { fmt } from './parts';

/**
 * The selected TRADE's clock, from the moment its signal came: when the
 * trigger bar closed, when the server saw it and when the alert went (each
 * with its lag), then a counter -- the fill window closing, then the time in
 * the trade and to its time-out. The windows are the paper log's own
 * (server: paper.ts), so this counts to what the record will do.
 */
export function TradeClock({ read }: { read: MethodRead }) {
  const c = read.paper ?? null;
  const now = useNow(true);
  const barClose = read.triggerTime === null ? null : (read.triggerTime + TF_SEC[read.tf]) * 1000;
  const state = c ? clockText(c, now) : null;
  // How long after the bar closed something happened: the latency, said plainly.
  const after = (ms: number) => (barClose === null ? '' : ` (${lag(ms - barClose)})`);
  const row = (k: string, v: React.ReactNode, cls?: string) => (
    <><dt className="text-muted-foreground">{k}</dt><dd className={cn('m-0 text-right', cls)}>{v}</dd></>
  );
  return (
    <section aria-label="entry clock" className="mx-2 mb-1.5 rounded border border-border px-2 py-1 text-[11.5px] tabular-nums">
      {state ? (
        <div aria-label="counter" className={cn('flex items-baseline justify-between gap-2 font-semibold',
          state.tone === 'wait' ? 'text-[var(--warn)]' : state.tone === 'live' ? 'text-[#3b82f6]' : 'text-muted-foreground')}>
          <span>{state.label}</span><span className="text-[13px]">{state.value}</span>
        </div>
      ) : (
        <div aria-label="counter" className="flex items-baseline justify-between gap-2 font-semibold text-[var(--warn)]">
          <span>Since the signal bar closed</span><span className="text-[13px]">{barClose === null ? '–' : span(now - barClose)}</span>
        </div>
      )}
      <dl className="m-0 mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 text-[11px]">
        {barClose !== null ? row('Bar closed', SECS.format(barClose)) : null}
        {c ? row('Seen', `${SECS.format(c.firstSeen)}${after(c.firstSeen)}`) : null}
        {c ? row('Alert', c.alertAt === null ? 'not sent' : `${SECS.format(c.alertAt)}${after(c.alertAt)}`) : null}
        {c?.filledAt != null ? row('Filled', `~${MINS.format(c.filledAt * 1000)} @ ${c.fillPrice === null ? '–' : fmt(c.fillPrice)}`, 'text-[#3b82f6]') : null}
        {c?.exitAt != null ? row('Out', `~${MINS.format(c.exitAt * 1000)} @ ${c.exitPrice === null ? '–' : fmt(c.exitPrice)}`) : null}
      </dl>
      {!c ? <p className="m-0 mt-0.5 text-[10.5px] text-muted-foreground">Being written to the paper log -- its fill window starts within the minute.</p> : null}
    </section>
  );
}

