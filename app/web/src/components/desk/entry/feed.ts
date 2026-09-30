import { useEffect, useMemo, useRef, useState } from 'react';
import { getCandles, getFlowBars, getHeatmap, getLargePrints, type HeatColumn, type PerpOiChange, type Wall } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import type { LiveLtp } from '@/hooks/useStream';
import { TF_SECONDS, withLiveBar, withLtp } from '@/lib/live-bar';
import { aggregate, closedBars, readTf, type TfRead } from '@/lib/smc/context';
import type { Candle, Leg } from '@/types/desk';
import type { EntryTf } from '@/types/entry';

/**
 * What the entry section's price charts are drawn from, read once and shared
 * by both panels and the twelve-chart grid (the desk's main chart used to read
 * all of this for itself; it went on 30 Sep 2026).
 *
 * Three candle series cover every timeframe: the desk's live 5m (App.tsx),
 * 1m (eight hours) and 1H (fourteen days). 3m is folded from 1m, 15m and 30m
 * from 5m, 4H from 1H -- the forming candle included, carried to the last
 * trade. The book heatmap and the per-candle flow exist for 1m and 5m only,
 * and are read only while a chart shows that timeframe.
 */

/** What the desk hands down: its live 5m candles, the stream's last trade, the option board and positioning. */
export type DeskFeed = {
  bars5m: readonly Candle[];
  ltp?: LiveLtp | null;
  strikes?: { legs: readonly Leg[]; maxPain: number | null } | null;
  derivs?: { oi: PerpOiChange | null; funding: number | null } | null;
};

type Heat = { tf: string; step: number; columns: HeatColumn[]; walls: Wall[] };

const H1 = 3600;
const M5 = 300;
const M1 = 60;
const NO_BARS: readonly Candle[] = [];

/**
 * Fold candles into a longer timeframe for display: whole buckets, and the
 * newest bucket even while it is still forming (the chart draws it; the
 * engine reads closed candles only). A partial bucket at the start of the
 * history is dropped -- its open is not known.
 */
export function foldForChart(bars: readonly Candle[], fromSec: number, toSec: number): Candle[] {
  const whole = aggregate(bars, fromSec, toSec);
  const last = bars[bars.length - 1];
  if (!last) return whole;
  const bucket = Math.floor(last.time / toSec) * toSec;
  if (whole[whole.length - 1]?.time === bucket) return whole;
  const inIt = bars.filter((b) => b.time >= bucket);
  const first = inIt[0];
  if (!first || bars[0]!.time > bucket) return whole;
  return [...whole, {
    time: bucket, open: first.open, close: last.close,
    high: Math.max(...inIt.map((b) => b.high)), low: Math.min(...inIt.map((b) => b.low)),
    volume: inIt.reduce((s, b) => s + b.volume, 0),
  }];
}

/**
 * The book heatmap: every column once, then only from the newest one on (it
 * is still filling), merged in. Starts over when it is switched back on.
 */
function useHeatmap(tf: '1m' | '5m', enabled: boolean): Heat | null {
  const [heat, setHeat] = useState<Heat | null>(null);
  const ref = useRef(heat);
  ref.current = heat;
  const { data } = usePoll(() => {
    const cur = ref.current;
    return getHeatmap(tf, cur ? cur.columns[cur.columns.length - 1]?.time : undefined);
  }, 20_000, { enabled });
  useEffect(() => {
    if (!data) return;
    setHeat((cur) => {
      if (!cur || cur.step !== data.step) return data;
      const from = data.columns[0]?.time ?? Infinity;
      const oldest = Date.now() / 1000 - 48 * 3600;
      return { ...data, columns: [...cur.columns.filter((c) => c.time < from && c.time >= oldest), ...data.columns] };
    });
  }, [data]);
  return enabled ? heat : null;
}

/** Everything a PriceChart takes, for one timeframe. */
export type ChartFeed = ReturnType<ReturnType<typeof useEntryFeed>>;

/**
 * The shared reads, and a function giving one chart's props for a timeframe.
 * `shown`: the timeframes on screen now, so the 1m-only and 5m-only reads run
 * only while wanted.
 */
export function useEntryFeed(desk: DeskFeed, shown: readonly EntryTf[]) {
  const want1m = shown.includes('1m') || shown.includes('3m');
  const heat1On = shown.includes('1m');
  const heat5On = shown.includes('5m');
  const { data: h1 } = usePoll(() => getCandles('1h'), 60_000);
  const { data: m1 } = usePoll(() => getCandles('1m'), want1m ? 10_000 : 60_000, { deps: [want1m] });
  const { data: big } = usePoll(() => getLargePrints(36), 15_000);
  const { data: flow1 } = usePoll(() => getFlowBars('1m', 8), 10_000, { enabled: heat1On });
  const { data: flow5 } = usePoll(() => getFlowBars('5m', 36), 10_000, { enabled: heat5On });
  const heat1 = useHeatmap('1m', heat1On);
  const heat5 = useHeatmap('5m', heat5On);
  const bigTrades = useMemo(() => ({ prints: big?.prints ?? [], min: big?.min ?? 200, basis: big?.basis }), [big]);

  const { bars5m, ltp = null, strikes = null, derivs = null } = desk;
  const now = Date.now();
  // The tape's forming candle where the stream has one; else the last price carried onto the polled bars.
  const live1m = useMemo(
    () => (ltp?.bars['1m'] ? withLiveBar(m1?.bars ?? NO_BARS, ltp.bars['1m'], M1, now) : withLtp(m1?.bars ?? NO_BARS, ltp?.price ?? null, M1, now)),
    [m1, ltp],
  );
  const live1h = useMemo(() => withLtp(h1?.bars ?? NO_BARS, ltp?.price ?? bars5m[bars5m.length - 1]?.close ?? null, H1, now), [h1, ltp, bars5m]);

  const minute = Math.floor(now / 60_000);
  const context = useMemo<TfRead[]>(() => {
    const at = minute * 60;
    const out: TfRead[] = [];
    const hour = closedBars(live1h, H1, at);
    const five = closedBars(bars5m, M5, at);
    const one = closedBars(live1m, M1, at);
    if (hour.length) out.push(readTf('1H', 'Regime', hour, H1));
    if (five.length) {
      out.push(readTf('30M', 'Bias', aggregate(five, M5, 1800), 1800));
      out.push(readTf('15M', 'Structure', aggregate(five, M5, 900), 900));
      out.push(readTf('5M', 'Setup', five, M5));
    }
    if (one.length) out.push(readTf('1M', 'Trigger', one, M1));
    return out;
  }, [live1h, bars5m, live1m, minute]);

  const higher = useMemo(() => [
    ...(live1h.length ? [{ tf: '1H', tfSec: H1, bars: live1h, show: 'zones' as const }] : []),
    ...(bars5m.length ? [{ tf: '15m', tfSec: 900, bars: foldForChart(bars5m, M5, 900), show: 'structure' as const }] : []),
  ], [live1h, bars5m]);

  const barsOf = useMemo(() => {
    const cache = new Map<EntryTf, readonly Candle[]>();
    return (tf: EntryTf): readonly Candle[] => {
      let b = cache.get(tf);
      if (!b) {
        b = tf === '1m' ? live1m
          : tf === '3m' ? foldForChart(live1m, M1, 180)
          : tf === '5m' ? bars5m
          : tf === '15m' || tf === '30m' ? foldForChart(bars5m, M5, TF_SECONDS[tf]!)
          : tf === '1h' ? live1h
          : foldForChart(live1h, H1, 14_400);
        cache.set(tf, b);
      }
      return b;
    };
  }, [live1m, bars5m, live1h]);

  return useMemo(() => (tf: EntryTf) => ({
    bars: barsOf(tf),
    loading: tf === '1m' || tf === '3m' ? !m1 : tf === '1h' || tf === '4h' ? !h1 : false,
    context,
    higher,
    bigTrades,
    flowBars: tf === '1m' ? flow1?.bars : tf === '5m' ? flow5?.bars : undefined,
    heat: tf === '1m' ? heat1 : tf === '5m' ? heat5 : null,
    strikes,
    derivs,
    ltp,
  }), [barsOf, m1, h1, context, higher, bigTrades, flow1, flow5, heat1, heat5, strikes, derivs, ltp]);
}
