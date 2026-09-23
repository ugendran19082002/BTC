import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  getAutoTrade, setAutoTrade, type AutoTradeSettings as AutoTrade, type AutoTradeState,
} from '@/api/trade';
import { getSettings, setWallWithinEm } from '@/api/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Every number the desk works to, in one screen.
 *
 * These used to be constants in the source — the most a rule may ask for, what
 * a new rule starts as, how many lots an automatic order may be. A ceiling
 * written into a file is a number standing between somebody and a trade they
 * meant to make, and changing it needs a deploy. So they live here, saved on the
 * server, and the only numbers left in the code are the hard ceilings each box
 * says out loud: what no setting may pass, whoever types it.
 *
 * Nothing here places an order. Raising a limit does not arm anything; it only
 * widens the range the other screens will accept.
 */
export function SettingsPanel() {
  return (
    <div className="grid gap-3">
      <AutoTradeLimitsCard />
      <LevelsCard />
      <p className="m-0 px-1 text-[11.5px] leading-relaxed text-[var(--dim)]">
        The switches that actually place orders are where the orders are: the best-pick card on the Live screen,
        and each strategy's own form. This screen sets the range those screens work inside.
      </p>
    </div>
  );
}

/** Lots, target, stop, seconds, trades per contract: the ceilings on the automatic order. */
function AutoTradeLimitsCard() {
  const [state, setState] = useState<AutoTradeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => { getAutoTrade().then(setState).catch((e: Error) => setFailed(e.message)); }, []);

  const save = async (limits: Partial<AutoTradeState['limits']>) => {
    setBusy(true);
    setFailed(null);
    try {
      await setAutoTrade({ limits } as Partial<AutoTrade> & { limits: typeof limits });
      setState(await getAutoTrade());
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <CollapsibleCard id="settings-auto-trade" title="Automatic best-pick trade — limits" ariaLabel="auto-trade limits">
        <p className="m-0 text-[12px] text-muted-foreground">{failed ?? 'Reading…'}</p>
      </CollapsibleCard>
    );
  }
  const ceilings = state.ceilings ?? {
    maxLots: 100_000, maxTargetPct: 99, maxStopPct: 10_000, maxChaseSec: 600, maxPerContract: 100,
  };

  return (
    <CollapsibleCard
      id="settings-auto-trade"
      title="Automatic best-pick trade — limits"
      ariaLabel="auto-trade limits"
      right={<span className="settings-note">{state.settings.on ? 'armed' : 'off'} · {state.mode}</span>}
    >
      <p className="settings-lead">
        The range the best-pick card will accept. It is at {state.settings.lots} lots and a {state.settings.targetPct}%
        target today; raising a limit here does not change that, or arm anything.
      </p>
      <div className="settings-grid">
        <Num label="Most lots per order" value={state.limits.maxLots} max={ceilings.maxLots} busy={busy}
             onSave={(v) => void save({ maxLots: v })} />
        <Num label="Smallest target %" value={state.limits.minTargetPct} max={ceilings.maxTargetPct} busy={busy}
             onSave={(v) => void save({ minTargetPct: v })} />
        <Num label="Largest target %" value={state.limits.maxTargetPct} max={ceilings.maxTargetPct} busy={busy}
             onSave={(v) => void save({ maxTargetPct: v })} />
        <Num label="Largest stop %" value={state.limits.maxStopPct} max={ceilings.maxStopPct} busy={busy} min={0}
             onSave={(v) => void save({ maxStopPct: v })} />
        <Num label="Longest walk to the bid (sec)" value={state.limits.maxChaseSec} max={ceilings.maxChaseSec} busy={busy} min={0}
             onSave={(v) => void save({ maxChaseSec: v })} />
        <Num label="Most trades per contract" value={state.limits.maxPerContract} max={ceilings.maxPerContract} busy={busy}
             onSave={(v) => void save({ maxPerContract: v })} />
      </div>
      {failed && <p className="settings-note warn" role="alert">{failed}</p>}
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

/**
 * One number, saved when the box is left rather than per keystroke, with the
 * ceiling it cannot pass said on its face.
 */
function Num({ label, value, max, min = 1, busy, onSave }: {
  label: string; value: number; max: number; min?: number; busy: boolean; onSave: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const n = Number(text);
  const ok = Number.isInteger(n) && n >= min && n <= max;
  const commit = () => { if (ok && n !== value && !busy) onSave(n); };
  return (
    <label className="settings-field">
      <span>{label}</span>
      <Input
        aria-label={label}
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        className={cn('h-8', !ok && 'border-[var(--down)]')}
      />
      <small className={cn(!ok && 'warn')}>{ok ? `up to ${max.toLocaleString('en-US')}` : `${min} to ${max.toLocaleString('en-US')}`}</small>
      {busy && <Loader2 size={11} className="animate-spin text-muted-foreground" aria-hidden />}
    </label>
  );
}
