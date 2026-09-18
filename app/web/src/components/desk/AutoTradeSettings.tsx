import { useEffect, useState } from 'react';
import { Bot, Loader2, RotateCcw } from 'lucide-react';
import { clearAutoTrade, getAutoTrade, setAutoTrade, type AutoTradeState } from '@/api/trade';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Selling the best pick by itself.
 *
 * The card names one trade and the numbers it was chosen on; this is the switch
 * that lets the desk act on it without anybody at the screen — 5 lots, a 95%
 * target, once per contract by default.
 *
 * **Everything about it is written to be read twice before it is armed.** The
 * switch is off by default and after every deploy, arming it in live mode says
 * in words that real orders will be placed with nobody watching, and the popup
 * shows exactly what the next order would be rather than a set of fields. The
 * server refuses anything outside the same limits, so a number typed here can
 * never become a bigger order than the box allows.
 *
 * What it will not do lives in `trading/auto-trade.ts`: never a morning where
 * nothing clears the rules, never the same strike twice on one contract, never
 * on top of a position the desk already carries, and never again after the
 * gates have refused a strike. The list under the switch says which of those
 * have happened today, and "consider them again" is the one way back.
 */
export function AutoTradeSettings({ pick }: {
  /** The strike on the card right now, so the popup can say what it would sell. */
  pick?: { side: 'CE' | 'PE'; strike: number; premiumUsd: number } | null;
}) {
  const [state, setState] = useState<AutoTradeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => { getAutoTrade().then(setState).catch(() => {}); }, []);

  const save = async (patch: Partial<AutoTradeState['settings']>) => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await setAutoTrade(patch);
      setState((s) => (s ? { ...s, settings: r.settings } : s));
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const s = state.settings;
  const done = Object.entries(state.done ?? {});
  const placed = done.filter(([, e]) => e.status === 'placed');
  const refused = done.filter(([, e]) => e.status === 'refused');
  // What the next order would actually be, in the words the ticket uses.
  const sentence = pick
    ? `Sell ${pick.side} ${pick.strike.toLocaleString('en-IN')} — ${s.lots} lot${s.lots === 1 ? '' : 's'}, `
      + `target ${s.targetPct}% (buy back near ${(pick.premiumUsd * (1 - s.targetPct / 100)).toFixed(2)})`
      + `${s.stopPct > 0 ? `, stop ${s.stopPct}%` : ', no stop'}.`
    : 'Nothing on the card to sell right now.';

  return (
    <section aria-label="auto-trade settings" className="auto-trade">
      <Switch
        label="Sell this pick automatically"
        description={
          !s.on
            ? 'Off — the card only names the trade; nothing is placed.'
            : state.mode === 'live'
              ? `On — the desk places a real order for the pick, ${s.lots} lots, target ${s.targetPct}%, once per contract.`
              : `On — paper mode, so the order is simulated. ${s.lots} lots, target ${s.targetPct}%.`
        }
        checked={s.on}
        onCheckedChange={(on) => { if (!busy) void save({ on }); }}
      />

      <div className="auto-trade-row">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-8 px-2.5 text-[12px]">
              <Bot size={13} aria-hidden /> Settings
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[310px]" aria-label="auto-trade options">
            <div className="auto-trade-grid">
              <Field
                label="Lots" value={s.lots} min={1} max={state.limits.maxLots}
                onSave={(v) => void save({ lots: v })} busy={busy}
              />
              <Field
                label="Target %" value={s.targetPct} min={state.limits.minTargetPct} max={state.limits.maxTargetPct}
                onSave={(v) => void save({ targetPct: v })} busy={busy}
              />
              <Field
                label="Stop % (0 = none)" value={s.stopPct} min={0} max={state.limits.maxStopPct}
                onSave={(v) => void save({ stopPct: v })} busy={busy}
              />
              <Field
                label="Sell at bid after (sec)" value={s.chaseSeconds} min={0} max={state.limits.maxChaseSec}
                onSave={(v) => void save({ chaseSeconds: v })} busy={busy}
              />
              <Field
                label="Trades per contract" value={s.maxPerContract} min={1} max={state.limits.maxPerContract}
                onSave={(v) => void save({ maxPerContract: v })} busy={busy}
              />
            </div>
            <p className="auto-trade-note">{sentence}</p>
            <p className="auto-trade-note dim">
              The same strike is never sold twice on one contract, never on top of a position already held,
              and never on a morning where nothing clears the hard rules. Every order runs the desk's own
              checks first — margin, the short cap, the day's loss limit and the spread.
            </p>
          </PopoverContent>
        </Popover>

        {busy && <Loader2 size={13} className="animate-spin text-muted-foreground" aria-hidden />}
        {s.on && (
          <span className={cn('auto-trade-state', state.mode === 'live' && 'live')}>
            {state.mode === 'live' ? 'armed — real orders' : 'armed — paper'}
          </span>
        )}
      </div>

      {(placed.length > 0 || refused.length > 0) && (
        <div className="auto-trade-done" aria-label="already decided on this contract">
          {placed.length > 0 && <span>Sold automatically: {placed.map(([k]) => k).join(', ')}.</span>}
          {refused.length > 0 && (
            <span className="warn">
              {' '}Refused: {refused.map(([k, e]) => `${k} (${e.detail ?? 'turned down'})`).join(', ')}.
            </span>
          )}
          <button
            type="button"
            className="auto-trade-clear"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              clearAutoTrade()
                .then(() => setState((v) => (v ? { ...v, done: {} } : v)))
                .catch((e: Error) => setFailed(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <RotateCcw size={11} aria-hidden /> consider them again
          </button>
        </div>
      )}

      {failed && <p className="auto-trade-note warn" role="alert">{failed}</p>}
    </section>
  );
}

/** A number that saves when it is left, never per keystroke. */
function Field({ label, value, min, max, onSave, busy }: {
  label: string; value: number; min: number; max: number; onSave: (v: number) => void; busy: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const n = Number(text);
  const ok = Number.isInteger(n) && n >= min && n <= max;
  const commit = () => { if (ok && n !== value && !busy) onSave(n); };
  return (
    <label className="auto-trade-field">
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
      {!ok && <small className="warn">{min} to {max}</small>}
    </label>
  );
}
