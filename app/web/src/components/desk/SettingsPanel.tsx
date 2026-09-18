import { useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import {
  getAutoTrade, setAutoTrade, type AutoTradeSettings as AutoTrade, type AutoTradeState,
} from '@/api/trade';
import { getRebalanceSettings, setRebalanceSettings, type RebalanceSettings } from '@/api/strategy';
import type { RebalanceLimits, RebalanceRule } from '@/types/strategy';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
      <RebalanceDefaultsCard />
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

/** What a new rebalance rule starts as, and the range any rule may use. */
function RebalanceDefaultsCard() {
  const [state, setState] = useState<RebalanceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => { getRebalanceSettings().then(setState).catch((e: Error) => setFailed(e.message)); }, []);

  const save = async (patch: { defaults?: Partial<RebalanceRule>; limits?: Partial<RebalanceLimits> }) => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await setRebalanceSettings(patch);
      setState((s) => (s ? { ...s, defaults: r.defaults, limits: r.limits } : s));
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <CollapsibleCard id="settings-rebalance" title="One-sided rebalance — defaults and limits" ariaLabel="rebalance settings">
        <p className="m-0 text-[12px] text-muted-foreground">{failed ?? 'Reading…'}</p>
      </CollapsibleCard>
    );
  }
  const d = state.defaults;

  return (
    <CollapsibleCard
      id="settings-rebalance"
      title="One-sided rebalance — defaults and limits"
      ariaLabel="rebalance settings"
      right={
        <Button
          variant="ghost" className="h-7 px-2 text-[11.5px]" disabled={busy}
          onClick={() => void save({
            defaults: {
              lotsPerStep: 30, steps: 3, upStartPct: 30, downStartPct: 20, incrementPct: 10,
              confirmTicks: 2, endTime: '13:30', lockDirection: true, maxLotsPerSide: 200,
              allowPartial: true, maxSpreadPct: 0.15,
            },
          })}
        >
          <RotateCcw size={12} aria-hidden /> Reset defaults
        </Button>
      }
    >
      <p className="settings-lead">
        What a rule starts as when the switch is first turned on, and the range any rule may use.
        Today that is {d.steps} stages from +{d.upStartPct}% / −{d.downStartPct}%, going up
        by {d.incrementPct} points a stage, {d.lotsPerStep} lots each time, until {d.endTime}.
      </p>

      <div className="settings-sub">A new rule starts at</div>
      <div className="settings-grid">
        <Num label="Lots each stage" value={d.lotsPerStep} max={state.limits.maxLotsPerStep} busy={busy}
             onSave={(v) => void save({ defaults: { lotsPerStep: v } })} />
        <Num label="Stages" value={d.steps} max={state.limits.maxSteps} busy={busy}
             onSave={(v) => void save({ defaults: { steps: v } })} />
        <Num label="First up move %" value={d.upStartPct} max={state.limits.maxUpPct} busy={busy}
             onSave={(v) => void save({ defaults: { upStartPct: v } })} />
        <Num label="First down move %" value={d.downStartPct} max={state.limits.maxDownPct} busy={busy}
             onSave={(v) => void save({ defaults: { downStartPct: v } })} />
        <Num label="Step per stage %" value={d.incrementPct} max={state.limits.maxIncrementPct} busy={busy} min={0}
             onSave={(v) => void save({ defaults: { incrementPct: v } })} />
        <Num label="Confirming readings" value={d.confirmTicks} max={state.limits.maxConfirmTicks} busy={busy}
             onSave={(v) => void save({ defaults: { confirmTicks: v } })} />
      </div>

      <div className="settings-sub">No rule may go past</div>
      <div className="settings-grid">
        <Num label="Stages" value={state.limits.maxSteps} max={state.ceilings.maxSteps} busy={busy}
             onSave={(v) => void save({ limits: { maxSteps: v } })} />
        <Num label="Lots each stage" value={state.limits.maxLotsPerStep} max={state.ceilings.maxLotsPerStep} busy={busy}
             onSave={(v) => void save({ limits: { maxLotsPerStep: v } })} />
        <Num label="Up move %" value={state.limits.maxUpPct} max={state.ceilings.maxUpPct} busy={busy}
             onSave={(v) => void save({ limits: { maxUpPct: v } })} />
        <Num label="Down move %" value={state.limits.maxDownPct} max={state.ceilings.maxDownPct} busy={busy}
             onSave={(v) => void save({ limits: { maxDownPct: v } })} />
        <Num label="Step per stage %" value={state.limits.maxIncrementPct} max={state.ceilings.maxIncrementPct} busy={busy}
             onSave={(v) => void save({ limits: { maxIncrementPct: v } })} />
        <Num label="Lots on one side" value={state.limits.maxLotsPerSide} max={state.ceilings.maxLotsPerSide} busy={busy}
             onSave={(v) => void save({ limits: { maxLotsPerSide: v } })} />
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
