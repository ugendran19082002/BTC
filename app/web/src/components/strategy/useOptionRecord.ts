import { useEffect, useMemo, useRef, useState } from 'react';
import { getMethodOptionRecord, getSignalBacktest } from '@/api/signal-backtest';
import { usePersisted } from '@/hooks/usePersisted';
import { rangeOf } from '@/lib/market-report';
import { BACKTEST_DEFAULTS, settingsWords } from '@/components/report/backtest-words';
import { actionOf, ruleTfs, type StrategyConfig } from '@/types/strategy';
import type { BacktestParams, MethodOptionRecord, SignalBacktestResponse } from '@/types/signal-backtest';

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
  /**
   * The same methods by the Backtest screen's own settings, as its Method filter lists them (owner, 13 Oct 2026:
   * "the backtest says 33 in profit and the strategy form 31 -- look at the backtest and copy it"). The two
   * differ wherever the strategy's rules do -- its strike rule, its lots, its SL and TGT distances -- so both are
   * offered, each said for what it is. `words` is those settings in a line.
   */
  screen?: { data: MethodOptionRecord | null; error: string | null; busy: boolean; words: string };
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
  const screen = useScreenRecord(c, on && ready);
  return { ...state, screen };
}

/** A backtest's answer as a record of methods: its pairs, added up by method, each with its timeframes. */
function recordOf(r: SignalBacktestResponse): MethodOptionRecord {
  const by = new Map<string, MethodOptionRecord['methods'][number]>();
  for (const p of r.pairs) {
    // A pair's key is its method, its way and its timeframe; with the chain the timeframe is the chain itself.
    const [method, mode, tf] = p.key.split('|') as [string, string, string];
    let m = by.get(method);
    if (!m) { m = { method, trades: 0, wins: 0, net: 0, byTf: [] }; by.set(method, m); }
    m.trades += p.n; m.wins += p.wins; m.net += p.net;
    m.byTf.push({ tf: mode === 'mtf' ? 'chain' : tf, trades: p.n, wins: p.wins, net: p.net });
  }
  return { from: r.from, to: r.to, priced: r.priced, caveats: [], signals: r.signals, trades: r.total.n, methods: [...by.values()] };
}

/**
 * The Backtest screen's own answer for the form's way and timeframes: its settings as this browser last left
 * them, since 1 Oct, every method -- what its Method filter shows with those timeframes chosen.
 */
function useScreenRecord(c: StrategyConfig, on: boolean): NonNullable<OptionRecordState['screen']> {
  const [stored] = usePersisted<BacktestParams>('signalBacktest.params', BACKTEST_DEFAULTS);
  const params = useMemo((): BacktestParams => ({ ...BACKTEST_DEFAULTS, ...stored }), [stored]);
  const rule = c.signal;
  const tfs = useMemo(() => (rule ? (rule.mode === 'mtf' ? ['chain'] : [...ruleTfs(rule)]) : []), [rule]);
  const key = JSON.stringify({ params, tfs });
  const [state, setState] = useState<{ data: MethodOptionRecord | null; error: string | null; busy: boolean }>({ data: null, error: null, busy: false });
  const asked = useRef(0);
  useEffect(() => {
    if (!on || tfs.length === 0) return;
    const mine = ++asked.current;
    setState((s) => ({ ...s, busy: true }));
    const timer = setTimeout(() => {
      getSignalBacktest({ ...rangeOf('all', Date.now()), params, tfs, methods: [], strategy: null }).then(
        (r) => { if (asked.current === mine) setState({ data: recordOf(r), error: null, busy: false }); },
        (e: unknown) => { if (asked.current === mine) setState({ data: null, error: e instanceof Error ? e.message : String(e), busy: false }); },
      );
    }, OPTION_RECORD_WAIT_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on]);
  return { ...state, words: settingsWords({ params, tfs: [], methods: [], strategy: null }, []) };
}
