import { useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { setEntryAlert, sendEntryAlertTest } from '@/api/entry';
import { cn } from '@/lib/utils';
import type { EntryAlerts, EntryMode } from '@/types/entry';

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
  const on = alerts?.alerts.find((a) => a.mode === mode)?.enabled ?? false;
  const ready = alerts?.telegram ?? false;
  const way = mode === 'mtf' ? 'with timeframe' : 'without timeframe';

  const flip = async () => {
    setBusy(true);
    setNote(null);
    try {
      onChanged(await setEntryAlert(mode, !on));
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
              title={ready ? `Telegram a TRADE ${way}, once per setup -- read on 5m, the paper log's timeframe, whatever the chart shows` : 'Telegram is not set up on the server (TG_TOKEN, TG_CHAT_ID): the switch is kept, nothing is sent'}
              className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-semibold',
                on ? 'border-[#26a17b] bg-[rgba(38,161,123,0.15)] text-[var(--up)]' : 'border-border text-muted-foreground',
                busy && 'opacity-50')}>
        {on ? <Bell size={12} aria-hidden /> : <BellOff size={12} aria-hidden />}
        Telegram {on ? 'on' : 'off'}
      </button>
      {on ? <button type="button" onClick={() => void test()} className="text-muted-foreground underline-offset-2 hover:underline">test</button> : null}
      {!ready && alerts ? <span className="text-[var(--warn)]">not set up</span> : null}
      {note ? <span role="status" className="text-muted-foreground">{note}</span> : null}
    </div>
  );
}
