import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { getBestTradeSettings, setBestTradeSettings, type BestTradeSettings as Settings } from '@/api/trade';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';

/**
 * The best-pick card's own two controls.
 *
 * **Tell me when the pick changes.** A switch, off until asked for. The server
 * reads the whole board once a minute and sends one message when it names a
 * different strike from the last one it announced — not every minute, and not
 * when the same strike is still the pick. Nothing to do with the header's
 * phone-alerts switch, which governs fill messages and is on by default;
 * that one has to be on as well for this to reach the phone, and the line
 * under the switch says so when it is not.
 *
 * **Same strike, at most N×.** Once the switch is on: how many times one
 * strike may be announced for one contract, from 5:31 PM to 5:30 PM the next
 * day. One by default -- a pick that goes 78,800 → 79,000 → 78,800 is one piece
 * of news about 78,800. Steps rather than a box: the range is 1 to 10.
 *
 * **Only strikes paying at least $X.** The premium floor the pool is cut at.
 * On 17 September the card kept naming a put paying $2.60 — almost certain to
 * expire worthless and not worth selling, because the margin at risk does not
 * shrink when the option is cheaper. Five by default, the desk's own floor.
 *
 * Both are remembered on the server, so they survive a deploy and are the
 * same on every phone.
 */
export function BestTradeSettings({ onChanged }: { onChanged?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [floorText, setFloorText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    getBestTradeSettings()
      .then((s) => { setSettings(s); setFloorText(String(s.minPremiumUsd)); })
      .catch(() => {});
  }, []);

  const save = async (patch: { alertOn?: boolean; minPremiumUsd?: number; repeat?: number }) => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await setBestTradeSettings(patch);
      setSettings((s) => (s ? { ...s, alertOn: r.alertOn, minPremiumUsd: r.minPremiumUsd, repeat: r.repeat ?? s.repeat } : s));
      setFloorText(String(r.minPremiumUsd));
      onChanged?.();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const floor = Number(floorText);
  const floorOk = Number.isFinite(floor) && floor > 0;
  const floorChanged = settings !== null && floorOk && floor !== settings.minPremiumUsd;

  if (!settings) return null;
  const canReachPhone = settings.telegram.configured && settings.telegram.on;
  const repeat = settings.repeat ?? 1;
  const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

  return (
    <section aria-label="best pick settings" className="bt-settings">
      <Switch
        label="Tell me when the pick changes"
        description={
          !settings.alertOn ? 'Off — nothing is sent about this card.'
            : !settings.telegram.configured ? 'On, but no Telegram bot on this server — nothing can be sent.'
              : !settings.telegram.on ? 'On, but phone alerts are switched off in the header — nothing will be sent until they are on.'
                : `One message when the pick changes. The same strike is sent ${times(repeat)} at most, until the contract expires.`
        }
        checked={settings.alertOn}
        onCheckedChange={(on) => { if (!busy) void save({ alertOn: on }); }}
      />
      {settings.alertOn && (
        <span className="bt-settings-state" aria-label="alert state">
          {canReachPhone ? <Bell size={12} aria-hidden /> : <BellOff size={12} aria-hidden />}
          {canReachPhone ? 'watching' : 'watching, but not reaching the phone'}
        </span>
      )}

      {/*
        The two numbers side by side, each under its own label: the floor, and
        how often one strike may be sent. The stepper only exists while the
        switch is on -- with nothing being sent there is nothing to repeat.
      */}
      <div className="bt-controls">
        <label className="bt-alert-field">
          <span>Only strikes paying at least $</span>
          <Input
            aria-label="only strikes paying at least"
            inputMode="decimal"
            value={floorText}
            onChange={(e) => setFloorText(e.target.value)}
            onBlur={() => { if (floorChanged) void save({ minPremiumUsd: floor }); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && floorChanged) void save({ minPremiumUsd: floor }); }}
            className="h-9"
          />
        </label>
        {settings.alertOn && (
          <div className="bt-alert-field bt-repeat">
            <span>Same strike, at most</span>
            <div className="bt-stepper" role="group" aria-label="times the same strike is sent">
              <button
                type="button" aria-label="send the same strike fewer times"
                disabled={busy || repeat <= 1}
                onClick={() => void save({ repeat: repeat - 1 })}
              >−</button>
              <b aria-live="polite">{repeat}×</b>
              <button
                type="button" aria-label="send the same strike more times"
                disabled={busy || repeat >= 10}
                onClick={() => void save({ repeat: repeat + 1 })}
              >+</button>
            </div>
          </div>
        )}
        {busy && <Loader2 size={13} className="bt-busy animate-spin text-muted-foreground" aria-hidden />}
      </div>
      <p className="bt-alert-note">
        {!floorOk
          ? <span className="warn">A price above zero.</span>
          : floorChanged
            ? <span className="warn">Press Enter or tap away to keep ${floor}.</span>
            : <>Cheaper strikes are left out however safe they look — the margin at risk does not shrink when the option is cheaper.</>}
      </p>
      {settings.alertOn && (
        <p className="bt-alert-note">
          Same strike: per contract — from 5:31 PM to 5:30 PM the next day. After {times(repeat)}, that strike is not sent again until the next contract.
        </p>
      )}
      {failed && <p className="bt-alert-note warn" role="alert">{failed}</p>}
    </section>
  );
}
