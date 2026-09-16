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

  const save = async (patch: { alertOn?: boolean; minPremiumUsd?: number }) => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await setBestTradeSettings(patch);
      setSettings((s) => (s ? { ...s, alertOn: r.alertOn, minPremiumUsd: r.minPremiumUsd } : s));
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

  return (
    <section aria-label="best pick settings" className="bt-settings">
      <Switch
        label="Tell me when the pick changes"
        description={
          !settings.alertOn ? 'Off — nothing is sent about this card.'
            : !settings.telegram.configured ? 'On, but no Telegram bot on this server — nothing can be sent.'
              : !settings.telegram.on ? 'On, but phone alerts are switched off in the header — nothing will be sent until they are on.'
                : 'One message when a different strike becomes the pick. Never a repeat of the same one.'
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

      <div className="bt-settings-floor">
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
        {busy && <Loader2 size={13} className="animate-spin text-muted-foreground" aria-hidden />}
      </div>
      <p className="bt-alert-note">
        {!floorOk
          ? <span className="warn">A price above zero.</span>
          : floorChanged
            ? <span className="warn">Press Enter or tap away to keep ${floor}.</span>
            : <>Cheaper strikes are left out however safe they look — the margin at risk does not shrink when the option is cheaper.</>}
      </p>
      {failed && <p className="bt-alert-note warn" role="alert">{failed}</p>}
    </section>
  );
}
