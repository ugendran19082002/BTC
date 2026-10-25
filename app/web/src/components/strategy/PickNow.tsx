import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { getMethodPicks, runMethodPicks } from '@/api/strategy';
import { usePoll } from '@/hooks/usePoll';
import { cn } from '@/lib/utils';

/**
 * Pick now (owner, 25 Oct 2026: "a Pick now button: whatever is there now, the strategies pick now and update"): the
 * methods' daily update, run at once -- every strategy with it on for the account shown, or the one strategy chosen.
 * It replaces lists that live signals read, so it asks once more before it starts. A run is a backtest a strategy:
 * the server answers at once and this asks every two seconds until it is done, then `onDone` refreshes the log.
 */
const istTime = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const strategies = (n: number) => `${n} ${n === 1 ? 'strategy' : 'strategies'}`;

export function PickNow({ strategy, account = null, onDone }: {
  strategy: { id: string; name: string } | null; account?: { id: number; name: string } | null; onDone: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // Started here: until the server's answer says it is done, asked often.
  const [mine, setMine] = useState<number | null>(null);
  const { data, refresh } = usePoll(() => getMethodPicks(account?.id ?? null), mine !== null ? 2_000 : 60_000, { deps: [mine, account?.id] });
  const last = data?.last ?? null;
  const running = !!last?.running || sending;
  const n = strategy ? 1 : data?.strategies ?? 0;
  const whom = strategy ? strategy.name : `${strategies(n)}${account ? ` of ${account.name}` : ''}`;

  const told = useRef<number | null>(null);
  useEffect(() => {
    if (mine === null || !last || last.at !== mine || last.running || told.current === mine) return;
    told.current = mine;
    setMine(null);
    onDone();
  }, [last, mine, onDone]);

  const start = async () => {
    setAsking(false);
    setRefused(null);
    setSending(true);
    try {
      const r = await runMethodPicks({ strategyId: strategy?.id ?? null, account: account?.id ?? null });
      setMine(r.at);
    } catch (e) {
      setRefused((e as Error).message);
    } finally {
      setSending(false);
      void refresh();
    }
  };

  const btn = 'm-0 inline-flex h-8 appearance-none items-center gap-1.5 rounded-md border border-solid px-2.5 font-[inherit] text-[12px]';
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {!asking && (
          <button type="button" onClick={() => setAsking(true)} disabled={running || (!strategy && n === 0)}
                  title={!strategy && n === 0 ? 'Switch on Auto-update methods in a signal strategy\'s Signals tab first' : undefined}
                  className={cn(btn, 'border-[var(--accent)] bg-transparent font-semibold text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50')}>
            {running ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw aria-hidden className="h-3.5 w-3.5" />}
            {running ? 'Picking…' : 'Pick now'}
          </button>
        )}
        {!asking && (
          <span aria-live="polite" className="text-[12px] text-muted-foreground">
            {running && last
              ? `Picking for ${strategies(last.strategies)} since ${istTime(last.at)}: the changes come in below when it is done.`
              : last?.doneAt
                ? last.error
                  ? <span className="text-[var(--down)]">The pick at {istTime(last.at)} stopped: {last.error}</span>
                  : `Last picked now at ${istTime(last.at)}: ${strategies(last.updated)} of ${last.strategies} saved.`
                : strategy ? `For ${strategy.name}.` : `${strategies(n)} with the daily update on${account ? ` in ${account.name}` : ' across every account'}.`}
          </span>
        )}
      </div>
      {asking && (
        <div role="alertdialog" aria-label="Pick the methods now" className="grid gap-2 rounded-md border border-solid border-[var(--accent)] bg-muted p-2.5 text-[12.5px] leading-snug">
          <p className="m-0">
            Pick the methods now for <b>{whom}</b>? Each list is replaced by its rule&apos;s pick from the finished expiry days,
            and new signals read it at once; trades already open keep their exits. Today&apos;s expiry counts once it settles at 5:30 PM IST.
            The day&apos;s own run still comes at its time.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => void start()} className={cn(btn, 'border-primary bg-primary font-semibold text-primary-foreground')}>
              Pick now for {whom}
            </button>
            <button type="button" onClick={() => setAsking(false)} className={cn(btn, 'border-border bg-transparent text-muted-foreground')}>Cancel</button>
          </div>
        </div>
      )}
      {refused && <p role="alert" className="m-0 text-[12px] text-[var(--down)]">Not picked: {refused}</p>}
    </div>
  );
}
