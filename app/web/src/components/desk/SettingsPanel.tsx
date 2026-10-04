import { useEffect, useState } from 'react';
import { TelegramLogCard } from '@/components/desk/TelegramLogCard';
import { Loader2 } from 'lucide-react';
import { getSettings, setWallWithinEm } from '@/api/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { BestTradeSettings } from '@/components/desk/BestTradeSettings';
import { DeskMetricsCard } from '@/components/desk/DeskMetricsCard';

/**
 * Every number the desk works to, in one screen.
 *
 * These used to be constants in the source. A number written into a file
 * stands between somebody and what they meant to do, and changing it needs a
 * deploy. So they live here, saved on the server.
 *
 * Nothing here places an order. The best pick's automatic trade, and the
 * limits card that set its range, went on 4 Oct 2026: the signal strategies
 * do the trading, each with its own switch on its own form.
 */
export function SettingsPanel() {
  return (
    <div className="grid gap-3">
      <BestPickCard />
      <LevelsCard />
      <DeskMetricsCard />
      <TelegramLogCard />
      <p className="m-0 px-1 text-[11.5px] leading-relaxed text-[var(--dim)]">
        Nothing on this screen places an order. Each strategy has its own switch, on its form.
      </p>
    </div>
  );
}

/** The best-pick card's premium floor: the one setting the card still has. */
function BestPickCard() {
  return (
    <CollapsibleCard id="settings-best-pick" title="Best pick — premium floor" ariaLabel="best pick settings card">
      <BestTradeSettings />
    </CollapsibleCard>
  );
}

/**
 * Support and resistance: how far a wall may sit and still be drawn.
 *
 * "Resistance 89,000" on 18 September was the heaviest call open interest on
 * the whole board, sixteen percent away. The screens now draw the heaviest
 * wall within this many expected moves of spot, and name the heavier one
 * outside it. Two by default; a fraction is allowed, because half an expected
 * move is a fair band on a quiet afternoon.
 */
function LevelsCard() {
  const [value, setValue] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((r) => {
        const raw = Number(r.settings.wall_within_em);
        const v = Number.isFinite(raw) && raw > 0 ? raw : 2;
        setValue(v);
        setText(String(v));
      })
      .catch((e: Error) => setFailed(e.message));
  }, []);

  const n = Number(text);
  const ok = Number.isFinite(n) && n >= 0.25 && n <= 20;
  const commit = () => {
    if (!ok || n === value || busy) return;
    setBusy(true);
    setFailed(null);
    setWallWithinEm(n)
      .then(() => setValue(n))
      .catch((e: Error) => setFailed(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <CollapsibleCard id="settings-levels" title="Support and resistance — how far a wall may sit" ariaLabel="level settings">
      <p className="settings-lead">
        The heaviest open interest within this many expected moves of spot is drawn as the level; anything
        further out is named, not drawn. Two expected moves by default.
      </p>
      <div className="settings-grid">
        <label className="settings-field">
          <span>Band, in expected moves</span>
          <Input
            aria-label="level band in expected moves"
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            className={cn('h-8', !ok && 'border-[var(--down)]')}
          />
          <small className={cn(!ok && 'warn')}>{ok ? 'from 0.25 to 20' : '0.25 to 20'}</small>
          {busy && <Loader2 size={11} className="animate-spin text-muted-foreground" aria-hidden />}
        </label>
      </div>
      {failed && <p className="settings-note warn" role="alert">{failed}</p>}
    </CollapsibleCard>
  );
}
