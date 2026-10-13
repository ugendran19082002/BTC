import { useEffect, useMemo, useRef, useState } from 'react';
import { getMethodOptionRecord } from '@/api/signal-backtest';
import { actionOf, ruleTfs, type StrategyConfig } from '@/types/strategy';
import type { MethodOptionRecord } from '@/types/signal-backtest';

/**
 * Every method's record as options under the strategy on the form (owner, 13 Oct 2026: "in the strategy form the
 * signal filter's profit and loss must be by the option's TGT and SL, not the perp's").
 *
 * Asked again a moment after the rules stop changing -- the strike rule, the lots, the hours, the option's target
 * and stop all change what a method made -- but not when a method is ticked or "at most open" is typed: the
 * record is of every method on all its signals, whichever are picked.
 */
export type OptionRecordState = {
  /** The last record that arrived; kept on the screen while the next is worked out. */
  data: MethodOptionRecord | null;
  /** Why there is none, in words: the desk's own refusal, or a strategy that buys. */
  error: string | null;
  busy: boolean;
};

/** A change is asked about after this long without another. */
export const OPTION_RECORD_WAIT_MS = 400;

export function useOptionRecord(c: StrategyConfig, on: boolean): OptionRecordState {
  const [state, setState] = useState<OptionRecordState>({ data: null, error: null, busy: false });
  const asked = useRef(0);
  const rule = c.signal;
  const sells = actionOf(rule) === 'sell';
  // What the record depends on: the rules, without which methods are ticked and how many may be open.
  const key = useMemo(
    () => (rule ? JSON.stringify({ ...c, liveOrders: false, signal: { ...rule, methods: [], maxOpen: 1 } }) : ''),
    [c, rule],
  );
  const ready = on && Boolean(rule) && sells && (rule!.mode === 'mtf' || ruleTfs(rule!).length > 0);
  useEffect(() => {
    if (!on) return;
    if (!rule || !sells) {
      asked.current++;
      setState({ data: null, error: rule ? 'A record as options is worked out for strategies that sell.' : null, busy: false });
      return;
    }
    if (!ready) { asked.current++; setState((s) => ({ ...s, busy: false })); return; }
    const mine = ++asked.current;
    setState((s) => ({ ...s, busy: true }));
    const timer = setTimeout(() => {
      getMethodOptionRecord(JSON.parse(key) as StrategyConfig).then(
        (data) => { if (asked.current === mine) setState({ data, error: null, busy: false }); },
        (e: unknown) => { if (asked.current === mine) setState({ data: null, error: e instanceof Error ? e.message : String(e), busy: false }); },
      );
    }, OPTION_RECORD_WAIT_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, on, sells]);
  return state;
}
