import { useEffect, useState } from 'react';
import { Bell, BellRing, Loader2, X } from 'lucide-react';
import type { PremiumAlert as Alert } from '@/types/trade';
import { addPremiumAlert, deletePremiumAlert, getPremiumAlerts } from '@/api/trade';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { clock, price } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * "Tell me when this strike pays 5."
 *
 * Lives on the best-trade card, for the strike the card names. A doorbell,
 * not a siren: set a bid, and the phone hears once when the bid gets there.
 * It is its own switch — nothing to do with the header's alerts toggle, which
 * governs the desk's fill messages and stays on by default. This one is off
 * until a level is typed, because an alert nobody asked for is noise.
 *
 * Three things the control says without being asked, because each has bitten
 * somebody: it fires on the **bid** (what a seller receives, not the mark);
 * it fires **once** (set another for the next level); and it needs the header
 * switch on to actually reach the phone — with it off, the alert still fires
 * on the record and the row here says so.
 */
export function PremiumAlert({ symbol, bidNow, defaultThreshold = 5 }: {
  symbol: string;
  bidNow: number | null;
  /** What the box opens on. Five, because that is the desk's premium floor. */
  defaultThreshold?: number;
}) {
  const [text, setText] = useState(String(defaultThreshold));
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [telegram, setTelegram] = useState<{ configured: boolean; on: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = () =>
    getPremiumAlerts()
      .then((r) => { setAlerts(r.alerts); setTelegram(r.telegram); })
      .catch(() => {});

  useEffect(() => { void refresh(); }, [symbol]);

  const mine = alerts.filter((a) => a.symbol === symbol);
  const live = mine.filter((a) => a.firedAt === null);
  const fired = mine.filter((a) => a.firedAt !== null);
  const threshold = Number(text);
  const valid = Number.isFinite(threshold) && threshold > 0;
  // An alert already met is not an alert: say so instead of setting it.
  const alreadyThere = valid && bidNow !== null && bidNow >= threshold;

  const set = async () => {
    if (!valid || alreadyThere) return;
    setBusy(true);
    setFailed(null);
    try {
      await addPremiumAlert(symbol, threshold);
      await refresh();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="premium alert" className="bt-alert">
      <div className="bt-alert-row">
        <label className="bt-alert-field">
          <span>Tell me when this pays</span>
          <Input
            aria-label="alert when the bid reaches"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-9"
          />
        </label>
        <Button
          variant="outline"
          className="h-9 flex-none"
          disabled={!valid || alreadyThere || busy}
          onClick={() => void set()}
          title={alreadyThere ? `The bid is already ${price(bidNow)} — that level is here now.` : undefined}
        >
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Bell size={13} aria-hidden />}
          Set reminder
        </Button>
      </div>

      <p className="bt-alert-note">
        {alreadyThere
          ? <span className="warn">The bid is already {price(bidNow)}. Pick a higher level, or take the trade.</span>
          : !valid
            ? <span className="warn">A price above zero.</span>
            : telegram && !telegram.configured
              ? <span className="warn">No Telegram bot on this server — the alert will fire on the record but nothing will be sent.</span>
              : telegram && !telegram.on
                ? <span className="warn">Alerts are switched off in the header: this will fire on the record and not be sent.</span>
                : <>You’ll get one message when a seller can get this price. The desk keeps trading either way.</>}
      </p>
      {failed && <p className="bt-alert-note warn" role="alert">{failed}</p>}

      {(live.length > 0 || fired.length > 0) && (
        <ul aria-label="alerts on this strike" className="bt-alert-list">
          {live.map((a) => (
            <li key={a.id} className="live">
              <Bell size={12} aria-hidden />
              <span>waiting for <b>{price(a.threshold)}</b>{bidNow !== null && <span className="dim"> · now {price(bidNow)}</span>}</span>
              <button
                type="button"
                aria-label={`Remove the alert at ${price(a.threshold)}`}
                onClick={() => { void deletePremiumAlert(a.id).then(refresh).catch(() => {}); }}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
          {fired.map((a) => (
            <li key={a.id} className={cn('fired')}>
              <BellRing size={12} aria-hidden />
              <span>
                sent at <b>{price(a.firedBid)}</b> · {clock(a.firedAt)}
                <span className="dim"> · asked for {price(a.threshold)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
