import { useEffect, useMemo, useRef, useState } from 'react';
import { getMethodOptionRecord, getSignalBacktest } from '@/api/signal-backtest';
import { usePersisted } from '@/hooks/usePersisted';
import { rangeOf } from '@/lib/market-report';
import { BACKTEST_DEFAULTS, settingsWords } from '@/components/report/backtest-words';
import { exitRules } from '@/lib/strategy-exits';
import { time12 } from '@/lib/time';
import { CHAIN_PTS, ruleTfs, type StrategyConfig } from '@/types/strategy';
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
  screen?: {
    data: MethodOptionRecord | null; error: string | null; busy: boolean; words: string;
    /** Each setting of the strategy on the form that is not what the Backtest screen is set to, in words (`rulesApart`). */
    apart: string[];
  };
};

/** A change is asked about after this long without another. */
export const OPTION_RECORD_WAIT_MS = 400;

export function useOptionRecord(c: StrategyConfig, on: boolean): OptionRecordState {
  const [state, setState] = useState<OptionRecordState>({ data: null, error: null, busy: false });
  const asked = useRef(0);
  const rule = c.signal;
  // What the record depends on: the rules, without which methods are ticked and how many may be open.
  const key = useMemo(
    () => (rule ? JSON.stringify({ ...c, liveOrders: false, signal: { ...rule, methods: [], maxOpen: 1 } }) : ''),
    [c, rule],
  );
  const ready = on && Boolean(rule) && (rule!.mode === 'mtf' || ruleTfs(rule!).length > 0);
  useEffect(() => {
    if (!on) return;
    if (!rule) {
      asked.current++;
      setState({ data: null, error: null, busy: false });
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
  }, [key, ready, on]);
  const screen = useScreenRecord(c, on && ready);
  return { ...state, screen };
}

/**
 * Where a strategy's rules and the Backtest screen's settings part, in words (owner, 13 Oct 2026: "I changed every
 * strategy to delta and it still does not match"): each setting that changes what a method makes and is not the
 * same in both -- the strike, the option's target and stop and their time steps, the SL and TGT distances, the
 * least premium, the hours. With none, the two lists are one list. The lots are left out: they change the money
 * and not which methods are in profit.
 *
 * Found the evening it was asked: every strategy had been set to the Backtest's delta, lots, target and stop, and
 * still carried a target by the clock (70% → 97% in nine steps) and nearer SL and TGT distances (100 to 200
 * points for the Backtest's 250). With those two made the same, all eight lists matched to the trade.
 */
export function rulesApart(c: StrategyConfig, p: BacktestParams): string[] {
  const rule = c.signal;
  if (!rule) return [];
  const out: string[] = [];
  const pc = (v: number) => `${Math.round(v * 1000) / 10}%`;
  // the strike
  const mine = c.strikeRule === 'delta' ? `delta ≤ ${(c.delta?.max ?? 0).toFixed(2)}` : c.strikeRule === 'premium' ? `premium ${c.premium.mode === 'atMost' ? '≤' : '≥'} $${c.premium.usd}` : `by ${c.strikeRule}`;
  const theirs = p.rule === 'delta' ? `delta ≤ ${p.value.toFixed(2)}` : `premium ≤ $${p.value}`;
  if (mine !== theirs) out.push(`the strike (strategy: ${mine}; Backtest: ${theirs})`);
  if ((c.strikeBlocks?.length ?? 0) > 0) out.push(`the strike changes by time here (${c.strikeBlocks!.length} blocks); the Backtest has one rule all day`);
  // the option's own target and stop, and their steps by the clock
  const x = exitRules(c);
  const stepsOf = (xs: readonly { at: string; value: number }[]) => xs.map((s) => `${s.at}=${Math.round(s.value * 10_000)}`).join(',');
  const theirSteps = (p.targetSteps ?? []).map((s) => `${s.at}=${Math.round(s.pct * 10_000)}`).join(',');
  if (x.target.mode !== 'pct') out.push('the option target is in points or a price here; the Backtest takes a per cent');
  else {
    if (Math.abs(x.target.value - p.targetPct) > 1e-9) out.push(`the option target (strategy: ${x.target.value > 0 ? pc(x.target.value) : 'none'}; Backtest: ${p.targetPct > 0 ? pc(p.targetPct) : 'none'})`);
    if (stepsOf(x.target.steps) !== theirSteps) {
      const last = x.target.steps[x.target.steps.length - 1];
      out.push(x.target.steps.length
        ? `the target by time (strategy: ${x.target.steps.length} step${x.target.steps.length === 1 ? '' : 's'}, to ${pc(last!.value)} from ${time12(last!.at)}; Backtest: ${p.targetSteps?.length ? `${p.targetSteps.length} other step${p.targetSteps.length === 1 ? '' : 's'}` : `fixed at ${pc(p.targetPct)}`})`
        : `the target by time (strategy: fixed; Backtest: ${p.targetSteps!.length} steps)`);
    }
  }
  if (x.stop.mode !== 'pct') out.push('the option stop is in points or a price here; the Backtest takes a per cent');
  else {
    if (Math.abs(x.stop.value - p.stopPct) > 1e-9) out.push(`the option stop (strategy: ${x.stop.value > 0 ? `+${pc(x.stop.value)}` : 'none'}; Backtest: ${p.stopPct > 0 ? `+${pc(p.stopPct)}` : 'none'})`);
    if (x.stop.steps.length) out.push(`the stop moves by time here (${x.stop.steps.length} steps); the Backtest's does not`);
  }
  // the SL and TGT distances, on the form's own timeframes
  const keys: string[] = rule.mode === 'mtf' ? [CHAIN_PTS] : ruleTfs(rule);
  const range = (min = 0, max = 0) => (min > 0 && max > 0 ? `${min} to ${max}` : min > 0 ? `≥ ${min}` : max > 0 ? `≤ ${max}` : 'any');
  const of = (by: Partial<Record<string, number>> | undefined, k: string) => by?.[k] ?? 0;
  for (const [name, minBy, maxBy, min, max] of [['SL', rule.minSlPts, rule.maxSlPts, p.slMin ?? 0, p.slMax ?? 0], ['TGT', rule.minTgtPts, rule.maxTgtPts, p.tgtMin ?? 0, p.tgtMax ?? 0]] as const) {
    const off = keys.filter((k) => of(minBy, k) !== min || of(maxBy, k) !== max);
    if (off.length) out.push(`the ${name} distance (strategy: ${off.map((k) => `${keys.length > 1 ? `${k} ` : ''}${range(of(minBy, k), of(maxBy, k))}`).join(', ')} pts; Backtest: ${range(min, max)} pts)`);
  }
  if (rule.target && rule.target !== 'tp1') out.push(`the perp target (strategy: ${rule.target === 'tp2' ? 'TGT2' : 'TGT3'}; Backtest: TGT1)`);
  // the least premium
  const floor = c.minPremiumUsd ?? 10, theirFloor = p.minPremium ?? 10;
  if (floor !== theirFloor) out.push(`the minimum premium (strategy: $${floor}; Backtest: ${theirFloor > 0 ? `$${theirFloor}` : 'off'})`);
  // the hours signals are taken in: the strategy's entry time to its first no-entry window or its exit; the Backtest's window
  const stop = c.noEntry?.on ? c.noEntry.windows.map((w) => w.from).sort()[0] : undefined;
  const myHours = `${c.entryTime}–${stop && c.noEntry!.windows.some((w) => w.from === stop && w.to >= c.exitTime) ? stop : c.exitTime}`;
  const theirHours = p.window === 'desk' ? '21:30–15:59' : p.window === 'all' ? '17:30–17:25' : `${p.hoursFrom ?? ''}–${p.hoursTo ?? ''}`;
  if (myHours !== theirHours) out.push(`the hours (strategy: ${myHours}; Backtest: ${theirHours})`);
  if ((c.weekdays?.length ?? 7) < 7) out.push('the days of the week (the Backtest takes every day)');
  return out;
}

/**
 * A backtest's answer as a record of methods: the figures of its own Method list (`choices.methods` -- each method
 * on the timeframes asked for, with no limit on open trades, which is what that list shows), so this is that list
 * to the rupee; each method's timeframes come from its pairs.
 */
function recordOf(r: SignalBacktestResponse): MethodOptionRecord {
  const tfs = new Map<string, MethodOptionRecord['methods'][number]['byTf']>();
  for (const p of r.pairs) {
    // A pair's key is its method, its way and its timeframe; with the chain the timeframe is the chain itself.
    const [method, mode, tf] = p.key.split('|') as [string, string, string];
    const xs = tfs.get(method) ?? [];
    tfs.set(method, xs);
    xs.push({ tf: mode === 'mtf' ? 'chain' : tf, trades: p.n, wins: p.wins, net: p.net });
  }
  const methods = r.choices.methods.filter((m) => m.n > 0).map((m) => ({ method: m.key, trades: m.n, wins: m.wins, net: m.net, byTf: tfs.get(m.key) ?? [] }));
  return { from: r.from, to: r.to, priced: r.priced, caveats: [], signals: r.signals, trades: r.total.n, methods };
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const apart = useMemo(() => rulesApart(c, params), [JSON.stringify(c), params]);
  return { ...state, words: settingsWords({ params, tfs: [], methods: [], strategy: null }, []), apart };
}
