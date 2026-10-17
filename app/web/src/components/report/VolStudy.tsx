import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import { pct } from '@/lib/format';
import { dayLabel, moneyText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { VolAsk, VolBy, VolLevel, VolStudyLevel, VolStudyLine, VolStudyResult } from '@/types/signal-backtest';
import { Empty, Panel } from '@/components/mobile/parts';
import { Switch } from '@/components/ui/switch';
import { count, netClass } from '@/components/report/backtest-parts';

/**
 * The option's SL, the strike's delta and the lots by volatility, as research on the desk's own trades (owner, 17 Oct
 * 2026: "Volatility by ATR 2h / ATM IV; SL, delta and lots -- Low, Normal and High for all three; backtest and
 * portfolio"). The settings above -- or the saved backtests of a run -- traded twice on the same signals: as set, and
 * with what is switched on here set by the level at each fill; read by the candles (ATR 2h) and by the board's ATM
 * IV. Report only: nothing a strategy or an order reads changes.
 *
 * Asked for with a tap, not with every change of a setting: it is three backtests' work for each one in it.
 */

type RuleKey = 'sl' | 'delta' | 'lots';
type Draft = Record<VolLevel, string> & { on: boolean };
export type VolDrafts = Record<RuleKey, Draft>;
/** Low, Normal, High -- in that order on the screen, as the owner reads them. */
const LEVELS: { key: VolLevel; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Normal' },
  { key: 'high', label: 'High' },
];
const LEVEL_NAME: Record<VolStudyLevel, string> = { low: 'Low', medium: 'Normal', high: 'High', unknown: 'Unknown' };
export const VOL_DRAFTS: VolDrafts = {
  sl: { on: true, low: '250', medium: '200', high: '150' },
  delta: { on: false, low: '0.12', medium: '0.10', high: '0.08' },
  lots: { on: false, low: '2', medium: '2', high: '1' },
};
const RULES: Record<RuleKey, { title: string; what: string; unit: string; prefix?: string; min: number; max: number; step: number; whole?: boolean; aria: (l: string) => string; words: (v: number) => string }> = {
  sl: {
    title: 'SL by volatility', what: 'The option SL over the premium sold, by level. Research: tighter when volatile did better over two years.',
    unit: '%', prefix: '+', min: 10, max: 1_000, step: 10, aria: (l) => `Option SL in ${l} volatility, per cent over the premium`, words: (v) => `+${v}%`,
  },
  delta: {
    title: 'Delta by volatility', what: 'The most delta a strike sold may have, by level: further out (a lower delta) when volatile.',
    unit: 'Δ', min: 0.02, max: 0.5, step: 0.01, aria: (l) => `Strike delta in ${l} volatility`, words: (v) => `Δ ${v.toFixed(2)}`,
  },
  lots: {
    title: 'Lots by volatility', what: 'Lots a signal, by level: fewer when volatile. The money is then of another size -- compare net per lot.',
    unit: 'lots', min: 1, max: 1_000, step: 1, whole: true, aria: (l) => `Lots in ${l} volatility`, words: (v) => `${v} lot${v === 1 ? '' : 's'}`,
  },
};
const SOURCE: Record<VolBy, { name: string; how: string }> = {
  atr: { name: 'By ATR 2h', how: 'the last two hours of 15-minute candles against the five expiry days before' },
  iv: { name: 'By ATM IV', how: 'the at-the-money implied volatility against the same hour of the five expiry days before (thirds)' },
};

/** What is wrong with the rules as typed, in words, or null: as the server holds them. */
export function volDraftProblem(d: VolDrafts): string | null {
  const on = (Object.keys(RULES) as RuleKey[]).filter((k) => d[k].on);
  if (on.length === 0) return 'Switch on the SL, the delta or the lots by volatility.';
  for (const k of on) {
    const r = RULES[k];
    for (const l of LEVELS) {
      const raw = d[k][l.key].trim(), v = Number(raw);
      if (raw === '' || !Number.isFinite(v)) return `Type the ${l.label.toLowerCase()} volatility ${k === 'sl' ? 'SL' : k}.`;
      if (v < r.min || v > r.max || (r.whole && !Number.isInteger(v))) {
        return k === 'sl' ? `The ${l.label.toLowerCase()} volatility SL is from 10% to 1,000% of the premium.`
          : k === 'delta' ? `The ${l.label.toLowerCase()} volatility delta is from 0.02 to 0.50.`
            : `The ${l.label.toLowerCase()} volatility lots are a whole number from 1 to 1,000.`;
      }
    }
  }
  return null;
}
/** The rules as the server is asked: each on with its three numbers, or null. */
export function volAskOf(d: VolDrafts): VolAsk {
  const of = (k: RuleKey, f: (v: number) => number) => (d[k].on ? { low: f(Number(d[k].low)), medium: f(Number(d[k].medium)), high: f(Number(d[k].high)) } : null);
  return { sl: of('sl', Math.round), delta: of('delta', (v) => Math.round(v * 100) / 100), lots: of('lots', Math.round) };
}

const stopWords = (share: number) => (share > 0 ? `+${Math.round(share * 100)}%` : 'no SL');
/** What the rule by volatility sets at a level, in a few words: "+150% · Δ 0.08 · 1 lot". */
function levelWords(r: VolStudyResult, l: VolLevel): string {
  return [r.sl ? `SL +${Math.round(r.sl[l] * 100)}%` : null, r.delta ? `Δ ${r.delta[l].toFixed(2)}` : null, r.lots ? RULES.lots.words(r.lots[l]) : null].filter(Boolean).join(' · ');
}
/** The settings as set, in words: one SL, or each saved backtest's own. */
const asSetWords = (r: VolStudyResult) => (r.fixed.each.length > 1 ? `each one's own SL (${r.fixed.each.map(stopWords).join(', ')})` : `SL ${stopWords(r.fixed.pct)}`);

/** One way of reading volatility: the settings as set beside the rule by volatility, figure by figure, the better of each marked. */
function Compare({ by, fixed, moved, r }: { by: VolBy; fixed: VolStudyLine; moved: VolStudyLine; r: VolStudyResult }) {
  const sized = r.lots !== null;
  const perLot = (l: VolStudyLine, v: number) => (l.lots > 0 ? v / l.lots : 0);
  type Metric = { label: string; a: number; b: number; show: (v: number) => string; better: 'more' | 'less' | null; money?: boolean };
  const metrics: Metric[] = [
    { label: 'Trades', a: fixed.n, b: moved.n, show: count, better: null },
    ...(sized ? [{ label: 'Lots traded', a: fixed.lots, b: moved.lots, show: count, better: null } as Metric] : []),
    { label: 'Net', a: fixed.net, b: moved.net, show: moneyText, better: sized ? null : 'more', money: true },
    { label: 'Net per lot', a: perLot(fixed, fixed.net), b: perLot(moved, moved.net), show: moneyText, better: 'more', money: true },
    { label: 'Worst day', a: fixed.worstDay?.net ?? 0, b: moved.worstDay?.net ?? 0, show: moneyText, better: 'more', money: true },
    { label: 'Max drawdown', a: -fixed.maxDrawdown, b: -moved.maxDrawdown, show: moneyText, better: 'more', money: true },
    { label: 'Option SL hit', a: fixed.stopHits, b: moved.stopHits, show: count, better: null },
    { label: 'Won', a: fixed.n ? fixed.wins / fixed.n : 0, b: moved.n ? moved.wins / moved.n : 0, show: (v) => pct(v, 0), better: 'more' },
    { label: `1st half${r.secondHalfFrom ? ` · to ${dayLabel(r.secondHalfFrom)}` : ''}${sized ? ' · per lot' : ''}`, a: sized ? perLot(fixed, fixed.halves[0]) : fixed.halves[0], b: sized ? perLot(moved, moved.halves[0]) : moved.halves[0], show: moneyText, better: 'more', money: true },
    { label: `2nd half${r.secondHalfFrom ? ` · from ${dayLabel(r.secondHalfFrom)}` : ''}${sized ? ' · per lot' : ''}`, a: sized ? perLot(fixed, fixed.halves[1]) : fixed.halves[1], b: sized ? perLot(moved, moved.halves[1]) : moved.halves[1], show: moneyText, better: 'more', money: true },
  ];
  const wins = (m: Metric) => (m.better === null || Math.abs(m.a - m.b) < 0.0005 ? null : (m.better === 'more') === (m.b > m.a) ? 'b' : 'a');
  const known = moved.byLevel.filter((l) => l.level !== 'unknown').reduce((a, l) => a + l.n, 0);
  const unknown = moved.byLevel.find((l) => l.level === 'unknown')?.n ?? 0;
  // With lots by level the totals are of another size: the verdict is per lot.
  const [h1, h2] = metrics.slice(-2) as [Metric, Metric];
  const diff = sized ? perLot(moved, moved.net) - perLot(fixed, fixed.net) : moved.net - fixed.net;
  const bothHalves = h1.b > h1.a && h2.b > h2.a, neitherHalf = h1.b <= h1.a && h2.b <= h2.a;
  return (
    <section aria-label={SOURCE[by].name} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md border border-[var(--line-soft)] p-3 max-sm:px-2">
      <h3 className="m-0 text-[14px] font-semibold">{SOURCE[by].name}</h3>
      {known === 0 ? (
        <Empty>No signal in these days has a level by {by === 'iv' ? 'the ATM IV' : 'the candles'}: every trade kept the settings as set, so there is nothing to compare.</Empty>
      ) : (
        <>
          <p role="status" className={cn('m-0 rounded-md px-3 py-2 text-[13.5px] leading-snug', diff > 0 && bothHalves ? 'bg-[rgba(38,161,123,0.14)]' : 'bg-[var(--chosen-soft)]')}>
            By volatility made <b className={netClass(diff)}>{moneyText(diff)}</b> {diff >= 0 ? 'more' : 'less'}{sized ? ' a lot' : ''} than as set,{' '}
            {bothHalves ? 'and was better in both halves of the days.' : neitherHalf ? 'and was not better in either half.' : 'but better in one half only -- not a rule yet.'}
          </p>
          <table className="w-full border-collapse text-[13px] tabular-nums">
            <caption className="sr-only">{SOURCE[by].name}: the settings as set against the rule by volatility</caption>
            <thead>
              <tr className="text-left text-[11.5px] text-muted-foreground">
                <th scope="col" className="py-1 pr-2 font-medium"><span className="sr-only">Figure</span></th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">As set</th>
                <th scope="col" className="py-1 text-right font-medium">By volatility</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => {
                const w = wins(m);
                const cell = (v: number, me: 'a' | 'b') => (
                  <td className={cn('py-1.5 text-right', me === 'a' && 'pr-2', m.money && netClass(v), w === me && 'font-semibold')}>
                    {m.show(v)}{w === me && <span className="sr-only"> (better)</span>}
                    {w === me && <span aria-hidden className="ml-1 text-[11px] text-[var(--up)]">▲</span>}
                  </td>
                );
                return (
                  <tr key={m.label} className="border-t border-[var(--line-soft)]">
                    <th scope="row" className="static whitespace-normal bg-transparent py-1.5 pr-2 text-left text-[13px] font-normal normal-case tracking-normal text-muted-foreground">{m.label}</th>
                    {cell(m.a, 'a')}{cell(m.b, 'b')}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <details className="text-[13px]">
            <summary className="min-h-[36px] cursor-pointer py-2 text-[var(--accent)]">By level · {count(known)} with a level{unknown ? `, ${count(unknown)} unknown` : ''}</summary>
            <table className="w-full border-collapse text-[12.5px] tabular-nums">
              <caption className="sr-only">{SOURCE[by].name}: each level, as set and by volatility</caption>
              <thead>
                <tr className="text-left text-[11.5px] text-muted-foreground">
                  <th scope="col" className="py-1 pr-2 font-medium">Level · by volatility</th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">Trades</th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">As set</th>
                  <th scope="col" className="py-1 text-right font-medium">By vol.</th>
                </tr>
              </thead>
              <tbody>
                {LEVELS.map((x) => x.key as VolStudyLevel).concat('unknown').flatMap((level) => {
                  const f = fixed.byLevel.find((x) => x.level === level), l = moved.byLevel.find((x) => x.level === level);
                  if (!f || !l || (f.n === 0 && l.n === 0)) return [];
                  return [(
                    <tr key={level} className="border-t border-[var(--line-soft)] align-top">
                      <th scope="row" className="static whitespace-normal bg-transparent py-1.5 pr-2 text-left text-[12.5px] font-medium normal-case tracking-normal text-foreground">
                        {LEVEL_NAME[level]} · <span className="font-normal">{level === 'unknown' ? 'kept as set' : levelWords(r, level)}</span>
                      </th>
                      <td className="py-1.5 pr-2 text-right">{count(f.n)}{l.n !== f.n ? ` / ${count(l.n)}` : ''}</td>
                      <td className="py-1.5 pr-2 text-right"><span className={cn('block', netClass(f.net))}>{moneyText(f.net)}</span><span className="block text-[11px] text-muted-foreground">SL {count(f.stopHits)}</span></td>
                      <td className="py-1.5 text-right"><span className={cn('block', netClass(l.net))}>{moneyText(l.net)}</span><span className="block text-[11px] text-muted-foreground">SL {count(l.stopHits)}</span></td>
                    </tr>
                  )];
                })}
              </tbody>
            </table>
          </details>
        </>
      )}
      <p className="m-0 text-[12px] leading-snug text-muted-foreground">Level: {SOURCE[by].how}. A signal with no level{by === 'iv' ? ' (no IV reading in the 6 minutes before its fill)' : ''} keeps the settings as set.</p>
    </section>
  );
}

/** One rule's switch and its three levels. */
function RuleFields({ k, d, onChange, onEnter }: { k: RuleKey; d: Draft; onChange: (d: Draft) => void; onEnter: () => void }) {
  const r = RULES[k];
  return (
    <div className="grid min-w-0 gap-1 border-0 border-t border-solid border-[var(--line-soft)] pt-1 first:border-t-0 first:pt-0">
      <Switch checked={d.on} onCheckedChange={(on) => onChange({ ...d, on })} label={r.title} description={r.what} />
      {d.on && (
        <div className="grid grid-cols-3 gap-2 pb-1 max-[340px]:grid-cols-1">
          {LEVELS.map((l) => (
            <label key={l.key} className="flex min-w-0 flex-col gap-1">
              <span className="text-[12.5px] font-medium">{l.label}</span>
              <span className="relative min-w-0">
                {r.prefix && <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground">{r.prefix}</span>}
                <input type="number" inputMode={r.whole ? 'numeric' : 'decimal'} min={r.min} max={r.max} step={r.step} aria-label={r.aria(l.label.toLowerCase())}
                  value={d[l.key]} onChange={(e) => onChange({ ...d, [l.key]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }}
                  className={cn('h-11 w-full min-w-0 rounded-md border border-border bg-[var(--bg)] text-[16px] tabular-nums text-foreground [color-scheme:dark]', r.prefix ? 'pl-6' : 'pl-3', r.unit.length > 1 ? 'pr-10' : 'pr-7')} />
                <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{r.unit}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function VolStudy({ askKey, read, wide = false, title = 'By volatility · SL, delta, lots · research' }: {
  /** What the result is of -- the backtest's or the run's own question -- so a comparison of other settings is said to be. */
  askKey: string;
  read: (a: VolAsk) => Promise<VolStudyResult>;
  wide?: boolean; title?: string;
}) {
  const [stored, setStored] = usePersisted<VolDrafts>('signalBacktest.volStudy.rules', VOL_DRAFTS);
  // Anything kept by an older build is filled in from the defaults rather than read as empty fields.
  const drafts: VolDrafts = { sl: { ...VOL_DRAFTS.sl, ...stored?.sl }, delta: { ...VOL_DRAFTS.delta, ...stored?.delta }, lots: { ...VOL_DRAFTS.lots, ...stored?.lots } };
  const [run, setRun] = useState<{ key: string; data: VolStudyResult | null; error: Error | null; busy: boolean } | null>(null);
  const problem = volDraftProblem(drafts);
  const ask = volAskOf(drafts);
  const keyOf = (a: VolAsk) => JSON.stringify({ askKey, a });
  const stale = run !== null && run.data !== null && !run.busy && run.key !== keyOf(ask);
  const go = () => {
    if (problem) return;
    const key = keyOf(ask);
    setRun((x) => ({ key, data: x?.data ?? null, error: null, busy: true }));
    read(ask).then(
      (data) => setRun((x) => (x?.key === key ? { key, data, error: null, busy: false } : x)),
      (error: Error) => setRun((x) => (x?.key === key ? { key, data: x.data, error, busy: false } : x)),
    );
  };
  const isDefault = JSON.stringify(drafts) === JSON.stringify(VOL_DRAFTS);
  const r = run?.data ?? null;
  const summary = (['sl', 'delta', 'lots'] as RuleKey[]).filter((k) => drafts[k].on)
    .map((k) => `${k === 'sl' ? 'SL' : k === 'delta' ? 'Delta' : 'Lots'} ${LEVELS.map((l) => `${l.label} ${RULES[k].words(Number(drafts[k][l.key]))}`).join(' · ')}`);
  return (
    <Panel title={title}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        <p className="m-0 text-[13px] leading-snug text-muted-foreground">
          The same signals, twice: as set above, and with what is switched on below set by how volatile it was when each signal filled --
          read by the candles (ATR 2h) and by the market&apos;s own price of the move (ATM IV). <b className="font-medium text-foreground">Research only: no strategy, setting or order changes.</b>
        </p>
        <fieldset className="m-0 grid min-w-0 gap-1 rounded-md border border-[var(--line-soft)] px-3 py-2">
          <legend className="px-1 text-[13px] font-semibold">Set by the level at each fill</legend>
          {(['sl', 'delta', 'lots'] as RuleKey[]).map((k) => (
            <RuleFields key={k} k={k} d={drafts[k]} onChange={(d) => setStored({ ...drafts, [k]: d })} onEnter={go} />
          ))}
        </fieldset>
        <p role={problem ? 'alert' : 'status'} className={cn('m-0 text-[12.5px] leading-snug', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
          {problem ?? `${summary.join('; ')}. What is off stays as set; a trade keeps its level's values to its exit.`}
        </p>
        <div className={cn('grid gap-2', wide ? 'grid-cols-[auto_auto] justify-start' : 'grid-cols-[minmax(0,1fr)_auto]')}>
          <button type="button" onClick={go} disabled={problem !== null || run?.busy === true}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-0 bg-[var(--chosen)] px-4 font-[inherit] text-[14px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40">
            {run?.busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            {run?.busy ? 'Comparing…' : r ? 'Compare again' : 'Compare'}
          </button>
          {!isDefault && (
            <button type="button" onClick={() => setStored(VOL_DRAFTS)} className="h-11 rounded-lg border border-border bg-transparent px-3 font-[inherit] text-[13.5px] text-foreground">Back to the defaults</button>
          )}
        </div>
        {run?.error && <p role="alert" className="m-0 text-[13px] text-[var(--down)]">Could not compare: {run.error.message}</p>}
        {run?.busy && !r && <p role="status" className="m-0 text-[13px] text-muted-foreground">Working out the same signals both ways… a minute on a long range.</p>}
        {stale && <p role="status" className="m-0 rounded-md bg-[var(--chosen-soft)] px-3 py-2 text-[13px]">The settings or the values changed since: below is the last comparison. Tap Compare again for these.</p>}
        {r && (
          <>
            <p className="m-0 text-[12.5px] leading-snug">
              <span className="text-muted-foreground">As set: </span>{asSetWords(r)}.{' '}
              <span className="text-muted-foreground">By volatility: </span>{LEVELS.map((l) => `${l.label} ${levelWords(r, l.key)}`).join(' · ')}.
            </p>
            {r.members && (
              <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
                Over {count(r.members.filter((m) => !m.problem).length)} saved backtest{r.members.filter((m) => !m.problem).length === 1 ? '' : 's'}, each on its own signals and settings, added up.
                {r.members.filter((m) => m.problem).map((m) => ` ${m.name}: ${m.problem}`).join('')}
              </p>
            )}
            <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 transition-opacity', (stale || run?.busy) && 'opacity-50', wide && 'xl:grid-cols-2')} aria-busy={run?.busy}>
              {r.signals === 0 || (r.sources[0]?.lines[0]?.n ?? 0) === 0 ? <Empty>No trade in these days to compare.</Empty> : r.sources.map((s) => {
                const fixed = s.lines.find((l) => l.rule === 'fixed')!, moved = s.lines.find((l) => l.rule === 'by-vol')!;
                return <Compare key={s.by} by={s.by} fixed={fixed} moved={moved} r={r} />;
              })}
            </div>
            <p className="m-0 text-[12px] leading-snug text-muted-foreground">
              {dayLabel(r.from)} → {dayLabel(r.to)}, {count(r.days)} expiry day{r.days === 1 ? '' : 's'}, {count(r.signals)} signals. Every signal is traded, with no limit on what is open -- an earlier exit must
              not free a place for a trade the other rule did not take -- so both sides are the same signals, fills and charges.
              {r.fixed.stepped && ' An SL as set that moves by the clock is compared with a level\'s SL held all day.'}
              {!r.sameTrades && (r.delta ? ' A level\'s delta found no strike worth selling for some signals: those are traded on one side only (Trades).' : ' Warning: the two sides did not trade the same signals on every day -- read the difference with care.')}
              {r.days < 20 ? ` ${count(r.days)} expiry day${r.days === 1 ? ' is' : 's are'} a short sample: a difference here can be luck.` : ' Trust a difference only where both halves agree.'}
              {' '}A rule goes to paper first, never straight to live.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}
