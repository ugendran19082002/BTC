import { useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import type { TradeStatus } from '@/types/trade';
import { setAlerts } from '@/api/trade';
import { cn } from '@/lib/utils';

/**
 * Fill alerts on or off, from the header.
 *
 * Two different facts, and the switch keeps them apart: whether Telegram is
 * *configured* — a bot token on the server, a deployment question — and whether
 * messages are *wanted right now*. Conflating them is how a screen ends up
 * offering a switch that does nothing, so with no token there is no switch,
 * only a greyed bell that says why.
 *
 * **It silences messages, not the desk.** Positions still open, protect and
 * close exactly as before; the engine never reads this. That has to be obvious
 * from the control, because a bell in a trading header looks like it might turn
 * something off that matters.
 *
 * The choice is remembered on the server rather than in this browser: a silence
 * chosen on a quiet afternoon should survive a deploy, and should not be
 * undone by opening the desk on a different phone.
 */
export function AlertSwitch({ status, onChanged }: {
  status: TradeStatus | null;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Absent on a server that predates the switch: alerts were always on there.
  const alerts = status?.alerts ?? null;
  if (!status) return null;

  const configured = alerts?.configured ?? false;
  const on = alerts?.on ?? true;

  if (!configured) {
    return (
      <span
        className="alertswitch off"
        title="No Telegram bot on this server. Set TG_TOKEN and TG_CHAT_ID to get fill alerts."
        aria-label="Fill alerts: not set up on this server"
      >
        <BellOff size={13} aria-hidden />
        <span className="alertswitch-label">No alerts</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={cn('alertswitch', on ? 'on' : 'muted', failed && 'failed')}
      aria-pressed={on}
      aria-label={on ? 'Fill alerts are on. Turn them off.' : 'Fill alerts are off. Turn them on.'}
      title={on
        ? 'Telegram gets a message on every fill. Turning this off silences the messages — the desk goes on trading, protecting and closing exactly as it does now.'
        : 'Alerts are off: nothing is being sent. The desk is still trading, protecting and closing.'}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        setFailed(false);
        void setAlerts(!on)
          .then(() => onChanged?.())
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden />
        : on ? <Bell size={13} aria-hidden />
          : <BellOff size={13} aria-hidden />}
      <span className="alertswitch-label">
        {failed ? 'Try again' : on ? 'Alerts on' : 'Alerts off'}
      </span>
    </button>
  );
}
