import { useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { setEntryAlert, sendEntryAlertTest } from '@/api/entry';
import { cn } from '@/lib/utils';
import type { EntryAlerts, EntryMode, EntryTf } from '@/types/entry';

const TFS: readonly EntryTf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
const HM = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * One way's Telegram alerts, on or off, in its panel's header: a TRADE is sent
 * once, when the paper log first writes it (the server does the sending, so it
 * works with no screen open). Off by default. When Telegram is not set up on
 * the server the switch says so instead of pretending.
 */
export function AlertSwitch({ mode, alerts, onChanged }: {
  mode: EntryMode;
  /** Both ways' switches and whether Telegram is set up; null while loading. */
  alerts: EntryAlerts | null;
  onChanged: (a: EntryAlerts) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const setting = alerts?.alerts.find((a) => a.mode === mode);
  const on = setting?.enabled ?? false;
  const tfs = setting?.tfs ?? ['5m'];
  // The last alert this way tried to send, from the server's log.
  const last = alerts?.recent?.find((a) => a.mode === mode) ?? null;
  const ready = alerts?.telegram ?? false;
  const way = mode === 'mtf' ? 'with timeframe' : 'without timeframe';

  const flip = async () => {
    setBusy(true);
    setNote(null);
    try {
      onChanged(await (mode === 'single' ? setEntryAlert(mode, !on, tfs) : setEntryAlert(mode, !on)));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pickTf = async (t: EntryTf) => {
    const next = tfs.includes(t) ? tfs.filter((x) => x !== t) : [...tfs, t];
    if (!next.length) { setNote('keep at least one timeframe'); return; }
    setBusy(true);
    setNote(null);
    try {
      onChanged(await setEntryAlert(mode, on, TFS.filter((x) => next.includes(x))));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setNote('sending…');
    try {
      await sendEntryAlertTest();
      setNote('test sent');
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11px]">
      <button type="button" role="switch" aria-checked={on} aria-label={`Telegram alerts ${way}`} disabled={busy || !alerts}
              onClick={() => void flip()}
              title={ready ? `Telegram a TRADE ${way}, once per setup${mode === 'single' ? ` -- on ${tfs.join(', ')}` : ' -- its 5m entry'}` : 'Telegram is not set up on the server (TG_TOKEN, TG_CHAT_ID): the switch is kept, nothing is sent'}
              className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-semibold',
                on ? 'border-[#26a17b] bg-[rgba(38,161,123,0.15)] text-[var(--up)]' : 'border-border text-muted-foreground',
                busy && 'opacity-50')}>
        {on ? <Bell size={12} aria-hidden /> : <BellOff size={12} aria-hidden />}
        Telegram {on ? 'on' : 'off'}
      </button>
      {on ? <button type="button" onClick={() => void test()} className="text-muted-foreground underline-offset-2 hover:underline">test</button> : null}
      {!ready && alerts ? <span className="text-[var(--warn)]">not set up</span> : null}
      {note ? <span role="status" className="text-muted-foreground">{note}</span> : null}
      {/* Without the chain: which timeframes reach the phone. With it, the entry is 5m. */}
      {on && mode === 'single' ? (
        <div role="group" aria-label="alert timeframes" className="flex basis-full flex-wrap justify-end gap-0.5">
          {TFS.map((t) => (
            <button key={t} type="button" aria-pressed={tfs.includes(t)} disabled={busy} onClick={() => void pickTf(t)}
                    className={cn('rounded border px-1 text-[10px]', tfs.includes(t) ? 'border-[#26a17b] text-[var(--up)]' : 'border-border text-muted-foreground')}>
              {t}
            </button>
          ))}
        </div>
      ) : null}
      {last ? (
        <span aria-label="last alert" className={cn('basis-full text-right text-[10.5px]', last.status === 'sent' ? 'text-muted-foreground' : 'text-[var(--down)]')}
              title={last.error ?? undefined}>
          last: {HM.format(last.at)} · #{last.n ?? '?'} {last.dir === 1 ? 'BUY' : 'SELL'} {last.tf} · {last.status === 'sent' ? 'sent ✓' : `failed ✗${last.error ? ` -- ${last.error}` : ''}`}
        </span>
      ) : null}
    </div>
  );
}
