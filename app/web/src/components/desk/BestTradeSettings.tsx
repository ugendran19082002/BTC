import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getBestTradeSettings, setBestTradeSettings, type BestTradeSettings as Settings } from '@/api/trade';
import { Input } from '@/components/ui/input';

/**
 * The best-pick card's own control.
 *
 * **Only strikes paying at least $X.** The premium floor the pool is cut at.
 * On 17 September the card kept naming a put paying $2.60 — almost certain to
 * expire worthless and not worth selling, because the margin at risk does not
 * shrink when the option is cheaper. Five by default, the desk's own floor.
 *
 * Remembered on the server, so it survives a deploy and is the same on every
 * phone. The card's phone alert and its automatic trade went on 4 Oct 2026:
 * the signal strategies do the trading, and both had been switched off.
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

  const save = async (patch: { minPremiumUsd?: number }) => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await setBestTradeSettings(patch);
      setSettings((s) => (s ? { ...s, minPremiumUsd: r.minPremiumUsd } : s));
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

  return (
    <section aria-label="best pick settings" className="bt-settings">
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
        {busy && <Loader2 size={13} className="bt-busy animate-spin text-muted-foreground" aria-hidden />}
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
