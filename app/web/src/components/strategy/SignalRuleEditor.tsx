import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { getEntryBoard, getEntryMethods, getMethodReport, type EntryMethodInfo } from '@/api/entry';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { Input } from '@/components/ui/input';
import { NumberField } from '@/components/ui/number-field';
import { CHAIN_PTS, legOfSignal, ptsKeysOf, ruleTfs, SIGNAL_TFS, type PtsKey, type SignalRule, type SignalTf } from '@/types/strategy';
import type { MethodRead, MethodReportRow } from '@/types/entry';
import type { Strategy } from '@/types/strategy';
import { cn } from '@/lib/utils';

/**
 * Which signals a signal strategy takes: the way (with the timeframe chain, or
 * without it on one timeframe), and the methods -- picked from the 81, each
 * with its record so far in that way, so the choice is made against what the
 * method has actually done rather than its name.
 *
 * Under it, the live board: the picked methods' TRADE signals standing now,
 * each read as the order it would become -- the leg, and the stop and target
 * on the BTC perpetual. Those levels are the signal's own, re-read every few
 * seconds; nothing here is typed.
 */

const GROUPS = [
  { id: 'all', label: 'All' },
  { id: 'breakout', label: 'Breakout' },
  { id: 'pullback', label: 'Pullback' },
  { id: 'reversal', label: 'Reversal' },
  { id: 'flow', label: 'Flow' },
] as const;
type GroupFilter = (typeof GROUPS)[number]['id'];

type ResultFilter = 'all' | 'profit' | 'loss' | 'none';
const RESULTS: { id: ResultFilter; label: string; tone: string; test: (r: MethodReportRow | undefined) => boolean }[] = [
  { id: 'all', label: 'All', tone: '', test: () => true },
  { id: 'profit', label: 'Profit', tone: 'text-[var(--up)]', test: (r) => Boolean(r && r.trades > 0 && r.netPts > 0) },
  { id: 'loss', label: 'Loss', tone: 'text-[var(--down)]', test: (r) => Boolean(r && r.trades > 0 && r.netPts < 0) },
  { id: 'none', label: 'No trades', tone: 'text-[var(--dim)]', test: (r) => !r || r.trades === 0 },
];

/** By the method's order side in the owner's list (5 Oct 2026): both, the BUY ones, the SELL ones. */
type SideFilter = 'both' | 'BUY' | 'SELL';
const SIDES: { id: SideFilter; label: string; tone: string }[] = [
  { id: 'both', label: 'Both', tone: '' },
  { id: 'BUY', label: 'Buy', tone: 'text-[var(--up)]' },
  { id: 'SELL', label: 'Sell', tone: 'text-[var(--down)]' },
];
const onSide = (m: EntryMethodInfo, side: SideFilter) => side === 'both' || m.orderSide === side;

/** Enough trades that a record means something; fewer and "profitable" is a coin's opinion. */
export const MIN_TRADES_FOR_RECORD = 5;
/** The quick picks for that minimum; it can be typed too. Shown beside the button, never hidden (owner, 2 Oct 2026). */
const MIN_TRADE_PRESETS = [1, 3, 5, 10, 20] as const;

const pts = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n).toLocaleString('en-US')}`;
const px = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));

/** The picked methods' TRADE reads on this board, in this strategy's way. */
export function matchingSignals(reads: readonly MethodRead[], rule: SignalRule): MethodRead[] {
  return reads.filter((r) => r.state === 'TRADE' && r.plan && r.dir
    && r.mode === rule.mode && (rule.mode === 'mtf' || ruleTfs(rule).includes(r.tf as SignalTf))
    && rule.methods.includes(r.id));
}

/**
 * One record per method over several timeframes: the timeframes' trades, wins,
 * points and signals added up, and the win rate worked out again from the sums
 * -- an average of win rates would weigh a 2-trade timeframe like a 50-trade one.
 */
export function combineRows(sections: readonly { rows: readonly MethodReportRow[] }[]): MethodReportRow[] {
  const by = new Map<string, MethodReportRow>();
  for (const sec of sections) {
    for (const r of sec.rows) {
      const a = by.get(r.method);
      by.set(r.method, a ? {
        ...a,
        signals: a.signals + r.signals, trades: a.trades + r.trades, wins: a.wins + r.wins, losses: a.losses + r.losses,
        profitPts: a.profitPts + r.profitPts, lossPts: a.lossPts + r.lossPts, netPts: a.netPts + r.netPts,
        profitR: a.profitR + r.profitR, lossR: a.lossR + r.lossR, netR: a.netR + r.netR,
      } : { ...r });
    }
  }
  return [...by.values()].map((r) => ({ ...r, winPct: r.trades ? (r.wins / r.trades) * 100 : null }));
}

/** The methods with a record worth the name, and a positive net: the "profitable so far" pick. */
export function profitableIds(rows: readonly MethodReportRow[], minTrades = MIN_TRADES_FOR_RECORD): string[] {
  return rows.filter((r) => r.trades >= minTrades && r.netPts > 0).map((r) => r.method);
}

/** The strategies whose methods can be copied in: signal ones with methods picked, not the one being edited, by name. */
export function copySources(strategies: readonly Strategy[], self: string | null): Strategy[] {
  return strategies
    .filter((s) => s.id !== self && s.config.trigger === 'signal' && (s.config.signal?.methods.length ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "12 methods · with the chain" / "5 methods · 15m + 1h" -- what a strategy's pick is, beside its name. */
const sourceWords = (s: Strategy) => {
  const r = s.config.signal!;
  const n = r.methods.length;
  return `${n} method${n === 1 ? '' : 's'} · ${r.mode === 'mtf' ? 'with the chain' : ruleTfs(r).join(' + ')}${s.enabled ? '' : ' · off'}`;
};

export function SignalRuleEditor({ rule, onChange, errors, copyFrom = [] }: {
  rule: SignalRule;
  onChange: (r: SignalRule) => void;
  errors: { mode?: string | null; tf?: string | null; methods?: string | null; slPts?: string | null };
  /**
   * The same broker account's other signal strategies (`copySources`), whose picked methods can be taken in one
   * step (owner, 9 Oct 2026): a new strategy on another timeframe or exit usually wants the same methods, and
   * ticking 12 of 81 again by hand is how one gets missed.
   */
  copyFrom?: readonly Strategy[];
}) {
  const [query, setQuery] = useState('');
  // What the last copy replaced, so it can be undone; cleared by any other change to the pick.
  const [copy, setCopy] = useState<{ name: string; took: string[]; before: string[] } | null>(null);
  const [group, setGroup] = useState<GroupFilter>('all');
  // By record: everything, the ones up, the ones down, the ones with no trade -- over the timeframes picked.
  const [result, setResult] = usePersisted<ResultFilter>('signal-rule:result', 'all');
  // By order side. Not remembered: a list quietly missing half its methods next time is a list misread.
  const [side, setSide] = useState<SideFilter>('both');
  const set = <K extends keyof SignalRule>(k: K, v: SignalRule[K]) => onChange({ ...rule, [k]: v });

  // The list changes with a deploy, not a minute: asked for once an hour.
  const { data: catalogue, error: catalogueError } = usePoll(getEntryMethods, 3_600_000);
  const tfs = ruleTfs(rule);
  const tfKey = tfs.join(',');
  // Each method's record in the chosen way -- every signal so far, as the Methods tab counts them; one
  // report, every timeframe in it, added up over the ones picked.
  const { data: report } = usePoll(() => getMethodReport(null), 300_000);
  // The boards the signals stand on: 5m for the chain (its reads ride on every board), each picked timeframe without it.
  const boardTfs: SignalTf[] = rule.mode === 'single' ? tfs : ['5m'];
  // The rows of the SL / TGT range: a timeframe each without the chain, the chain's one with it.
  const ptsKeys: PtsKey[] = rule.mode === 'single' ? tfs : ptsKeysOf(rule);
  const { data: boards } = usePoll(() => Promise.all(boardTfs.map((tf) => getEntryBoard(tf))), 10_000, { deps: [rule.mode, tfKey] });

  const rows = useMemo((): MethodReportRow[] => {
    if (!report) return [];
    if (rule.mode === 'mtf') return report.sections.find((s) => s.mode === 'mtf')?.rows ?? [];
    return combineRows(tfs.map((tf) => report.singleByTf[tf]).filter((x): x is NonNullable<typeof x> => Boolean(x)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, rule.mode, tfKey]);
  const recordOf = useMemo(() => new Map(rows.map((r) => [r.method, r])), [rows]);
  // Without the chain on more than one timeframe: each method's record on each, under the sum, so the pick can be checked.
  const byTf = useMemo((): Map<string, { tf: SignalTf; row: MethodReportRow | undefined }[]> => {
    if (!report || rule.mode !== 'single' || tfs.length < 2) return new Map();
    const per = tfs.map((tf) => ({ tf, rows: new Map((report.singleByTf[tf]?.rows ?? []).map((r) => [r.method, r])) }));
    const ids = [...new Set(per.flatMap((p) => [...p.rows.keys()]))];
    return new Map(ids.map((id) => [id, per.map((p) => ({ tf: p.tf, row: p.rows.get(id) }))]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, rule.mode, tfKey]);
  const board = boards?.[0] ?? null;
  const reads = useMemo(() => (boards ?? []).flatMap((b, i) => b.reads.filter((r) => (rule.mode === 'mtf' ? r.mode === 'mtf' : r.mode === 'single' && r.tf === boardTfs[i]))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
    [boards]);

  const methods: EntryMethodInfo[] = catalogue?.methods ?? [];
  // Search and family first; the result and order-side filters on top, so each one's counts follow the rest.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return methods.filter((m) => (group === 'all' || m.group === group)
      && (!q || String(m.n) === q || m.name.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q)));
  }, [methods, query, group]);
  const resultTab = RESULTS.find((x) => x.id === result) ?? RESULTS[0]!;
  const shown = useMemo(() => searched.filter((m) => onSide(m, side) && resultTab.test(recordOf.get(m.id))), [searched, resultTab, recordOf, side]);
  const picked = new Set(rule.methods);
  // Only the methods the desk still has: a strategy saved before one was retired would carry an id the save refuses.
  const known = new Set(methods.map((m) => m.id));
  const copyIn = (id: string) => {
    const from = copyFrom.find((s) => s.id === id);
    if (!from?.config.signal) return;
    const ids = [...new Set(from.config.signal.methods)].filter((m) => !known.size || known.has(m));
    setCopy({ name: from.name, took: ids, before: rule.methods });
    set('methods', ids);
  };
  // Said, with its Undo, only while the pick is still the copied one: a change made after it is the owner's own.
  const copied = copy && copy.took.join(',') === rule.methods.join(',') ? copy : null;
  const toggle = (id: string) => set('methods', picked.has(id) ? rule.methods.filter((x) => x !== id) : [...rule.methods, id]);
  const addAll = (ids: string[]) => set('methods', [...new Set([...rule.methods, ...ids])]);
  // How many trades a record needs before "profitable" means anything; kept in this browser.
  const [minTrades, setMinTrades] = usePersisted<number>('signal-rule:min-trades', MIN_TRADES_FOR_RECORD);
  const minT = Math.max(1, Math.trunc(minTrades) || 1);
  const winners = profitableIds(rows, minT);
  const live = matchingSignals(reads, rule);
  const way = rule.mode === 'mtf' ? 'with the chain' : `without it on ${tfs.join(' + ')}`;
  const toggleTf = (tf: SignalTf) => {
    const next = tfs.includes(tf) ? tfs.filter((x) => x !== tf) : SIGNAL_TFS.filter((x) => x === tf || tfs.includes(x));
    onChange({ ...rule, tfs: next, tf: next[0] ?? rule.tf });
  };
  const nameOf = (id: string) => methods.find((m) => m.id === id);
  const chip = (on: boolean) => cn(
    'm-0 h-8 appearance-none rounded-md border border-solid px-2.5 font-[inherit] text-[12px]',
    on ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground',
  );
  const link = 'm-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2 disabled:opacity-40 disabled:no-underline';

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 text-[12px] text-muted-foreground">Which signals</div>
        <div role="radiogroup" aria-label="signal way" className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {([['mtf', 'With the timeframe chain'], ['single', 'Without the chain']] as const).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={rule.mode === v} onClick={() => set('mode', v)}
                    className={cn('m-0 h-9 flex-1 appearance-none whitespace-nowrap rounded-md border-0 px-2 font-[inherit] text-[12.5px] font-medium',
                      rule.mode === v ? 'bg-background text-foreground shadow-sm' : 'bg-transparent text-muted-foreground')}>
              {label}
            </button>
          ))}
        </div>
        <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">
          {rule.mode === 'mtf'
            ? 'Entry on 5m, agreed by 4h / 1h / 30m / 15m, confirmed on 3m — fewer signals, each one checked across the chain.'
            : 'One timeframe on its own — more signals, no higher-timeframe check.'}
        </p>
        {errors.mode && <p role="alert" className="m-0 mt-1 text-[11.5px] text-[var(--down)]">{errors.mode}</p>}
      </div>

      {rule.mode === 'single' && (
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-muted-foreground">Timeframes — pick one or more</span>
            <span className="flex gap-3">
              <button type="button" className={link} disabled={tfs.length === SIGNAL_TFS.length} aria-label="All timeframes"
                      onClick={() => onChange({ ...rule, tfs: [...SIGNAL_TFS], tf: SIGNAL_TFS[0]! })}>All</button>
              <button type="button" className={link} disabled={tfs.length === 0} aria-label="No timeframes"
                      onClick={() => onChange({ ...rule, tfs: [] })}>None</button>
            </span>
          </div>
          <div role="group" aria-label="signal timeframes" className="grid grid-cols-6 gap-1">
            {SIGNAL_TFS.map((tf: SignalTf) => (
              <button key={tf} type="button" aria-pressed={tfs.includes(tf)} onClick={() => toggleTf(tf)} className={chip(tfs.includes(tf))}>
                {tf}
              </button>
            ))}
          </div>
          <p className="m-0 mt-1 text-[11px] text-[var(--dim)]">
            {tfs.length ? `Takes signals on ${tfs.join(', ')}. The record beside each method is added up over these.` : ''}
          </p>
          {errors.tf && <p role="alert" className="m-0 mt-1 text-[11.5px] text-[var(--down)]">{errors.tf}</p>}

        </div>
      )}

      {/*
            The distance filters, two numbers per timeframe picked (4 Oct 2026) -- and, with the chain, the
            chain's own two (6 Oct 2026): one row, kept apart from any timeframe's, so a rule switched to the
            chain does not bring a filter with it. A
            stop a few points from the entry is one the perp's own noise reaches,
            and a target a few points away pays less than the option's spread; how
            near is too near differs by timeframe, so each has its own. Both start
            at 0, which is off.
          */}
      {ptsKeys.length > 0 && (
            <div role="group" aria-label={rule.mode === 'single' ? 'SL and TGT distance by timeframe' : 'SL and TGT distance with the chain'} className="rounded-lg border border-solid border-border px-2.5 py-2">
              <div className="text-[12.5px] font-medium text-foreground">Take a signal only if its SL and TGT are in range</div>
              <p className="m-0 mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                The distance from the perp entry to the signal&apos;s SL, and to its TGT, in BTC points, {rule.mode === 'single' ? 'for each timeframe' : 'for signals with the chain (their entry is on 5m)'}:
                a minimum (≥) and a maximum (≤). Inside both and the signal is taken; nearer than the minimum or further
                than the maximum and it is skipped, with both prices in the trade history. Each is its own condition,
                on from any number above 0 — 0 is off.
              </p>
              <div className="mt-1.5 flex flex-col gap-1.5">
                {ptsKeys.map((tf) => (
                  // A phone: the timeframe, then an SL row and a TGT row, aligned; wider, all on one line as before.
                  <div key={tf} className="grid grid-cols-1 gap-1.5 text-[12px] sm:flex sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1">
                    <span className={cn('flex-none font-medium text-foreground', tf === CHAIN_PTS ? 'w-12' : 'w-8')}>{tf === CHAIN_PTS ? 'Chain' : tf}</span>
                    <span className="grid grid-cols-[2rem_auto_1fr_auto_1fr] items-center gap-1.5 sm:flex">
                      <span className="text-[var(--down)]">SL</span>
                      <span className="text-muted-foreground">≥</span>
                      <NumberField label={`${tf} SL distance pts`} value={rule.minSlPts?.[tf] ?? 0} unit="pts" decimals={0} className="w-full sm:w-24"
                                   onChange={(n) => onChange({ ...rule, minSlPts: { ...(rule.minSlPts ?? {}), [tf]: n } })} />
                      <span className="text-muted-foreground">≤</span>
                      <NumberField label={`${tf} SL maximum distance pts`} value={rule.maxSlPts?.[tf] ?? 0} unit="pts" decimals={0} className="w-full sm:w-24"
                                   onChange={(n) => onChange({ ...rule, maxSlPts: { ...(rule.maxSlPts ?? {}), [tf]: n } })} />
                    </span>
                    <span className="grid grid-cols-[2rem_auto_1fr_auto_1fr] items-center gap-1.5 sm:flex">
                      <span className="text-[var(--up)]">TGT</span>
                      <span className="text-muted-foreground">≥</span>
                      <NumberField label={`${tf} TGT distance pts`} value={rule.minTgtPts?.[tf] ?? 0} unit="pts" decimals={0} className="w-full sm:w-24"
                                   onChange={(n) => onChange({ ...rule, minTgtPts: { ...(rule.minTgtPts ?? {}), [tf]: n } })} />
                      <span className="text-muted-foreground">≤</span>
                      <NumberField label={`${tf} TGT maximum distance pts`} value={rule.maxTgtPts?.[tf] ?? 0} unit="pts" decimals={0} className="w-full sm:w-24"
                                   onChange={(n) => onChange({ ...rule, maxTgtPts: { ...(rule.maxTgtPts ?? {}), [tf]: n } })} />
                    </span>
                    <span className="text-[11px] text-[var(--dim)]" aria-label={`${tf} distance filters`}>
                      {(() => {
                        // What is on, in words: "SL 150+ · TGT up to 900"; nothing set is "all off".
                        const said = (name: string, least: number, most: number) =>
                          (least > 0 && most > 0 ? `${name} ${least} to ${most}` : least > 0 ? `${name} ${least}+` : most > 0 ? `${name} up to ${most}` : null);
                        const on = [said('SL', rule.minSlPts?.[tf] ?? 0, rule.maxSlPts?.[tf] ?? 0), said('TGT', rule.minTgtPts?.[tf] ?? 0, rule.maxTgtPts?.[tf] ?? 0)].filter(Boolean);
                        return on.length ? on.join(' · ') : 'all off';
                      })()}
                    </span>
                  </div>
                ))}
              </div>
              <p className="m-0 mt-1.5 text-[11px] leading-snug text-[var(--dim)]">
                The TGT is the one the trade exits at — TGT1, or the one picked on Entry &amp; exit (TGT1 where the signal has no TGT2 / TGT3).
              </p>
              {errors.slPts && <p role="alert" className="m-0 mt-1 text-[11.5px] text-[var(--down)]">{errors.slPts}</p>}
            </div>
      )}

      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Methods</span>
            {/* Another strategy's pick, in one step: it replaces the pick here, and can be undone. */}
            {copyFrom.length > 0 && (
              <select aria-label="copy methods from a strategy" value="" onChange={(e) => copyIn(e.target.value)}
                      title="Take the methods another strategy of this account picked -- they replace the ones picked here"
                      className="h-8 max-w-[min(100%,20rem)] rounded-md border border-solid border-border bg-background px-2 text-[12px] text-foreground">
                <option value="" disabled>Copy methods from a strategy…</option>
                {copyFrom.map((s) => <option key={s.id} value={s.id}>{s.name} — {sourceWords(s)}</option>)}
              </select>
            )}
          </span>
          <span className="text-[11.5px] tabular-nums text-foreground" aria-live="polite">
            {rule.methods.length} of {methods.length || 81} picked
          </span>
        </div>
        {copied && (
          <p role="status" className="m-0 mb-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
            <span>Took the {copied.took.length} method{copied.took.length === 1 ? '' : 's'} of <b className="text-foreground">{copied.name}</b>{copied.before.length ? `, in place of the ${copied.before.length} picked before` : ''}.</span>
            <button type="button" className={link} onClick={() => { set('methods', copied.before); setCopy(null); }}>Undo</button>
          </p>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="search methods"
                 placeholder="Search by number or name" className="pl-7" />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {GROUPS.map((g) => (
            <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)} className={chip(group === g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        {/* By record, with counts: the profitable ones, the losing ones, the ones with nothing yet. */}
        <div role="group" aria-label="methods by result" className="mt-1.5 flex flex-wrap gap-1">
          {RESULTS.map((x) => (
            <button key={x.id} type="button" aria-pressed={resultTab.id === x.id} onClick={() => setResult(x.id)} className={chip(resultTab.id === x.id)}>
              <span className={x.tone}>{x.label}</span>{' '}
              <span className="tabular-nums text-[var(--dim)]">{searched.filter((m) => onSide(m, side) && x.test(recordOf.get(m.id))).length}</span>
            </button>
          ))}
        </div>
        {/* By order side, under the record: the methods marked BUY, the ones marked SELL, or both. */}
        <div role="group" aria-label="methods by order side" className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11.5px] text-muted-foreground">Order side</span>
          {SIDES.map((x) => (
            <button key={x.id} type="button" aria-pressed={side === x.id} onClick={() => setSide(x.id)} className={chip(side === x.id)}>
              <span className={x.tone}>{x.label}</span>{' '}
              <span className="tabular-nums text-[var(--dim)]">{searched.filter((m) => onSide(m, x.id) && resultTab.test(recordOf.get(m.id))).length}</span>
            </button>
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          <button type="button" className={link} disabled={!shown.length} onClick={() => addAll(shown.map((m) => m.id))}>
            Pick all shown ({shown.length})
          </button>
          <button type="button" className={link} disabled={!winners.length}
                  title={`Net points above zero over at least ${minT} trade${minT === 1 ? '' : 's'}, added up ${way} -- every timeframe picked, together: what this strategy would have taken`}
                  onClick={() => addAll(winners)}>
            Pick profitable {rule.mode === 'mtf' ? 'with the chain' : `on ${tfs.join(' + ') || '—'}`} ({winners.length})
          </button>
          <button type="button" className={link} disabled={!rule.methods.length} onClick={() => set('methods', [])}>
            Clear
          </button>
        </div>
        {/*
          The rule "profitable" is read by, out loud. It was a hidden five: a method at +578 on one trade
          showed green and was not picked, and nothing on the screen said why.
        */}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span>Profitable = net above 0 over at least</span>
          <Input value={String(minTrades)} aria-label="minimum trades" inputMode="numeric" className="h-7 w-12 px-1.5 text-center text-[12px]"
                 onChange={(e) => setMinTrades(Math.max(1, Math.trunc(Number(e.target.value)) || 1))} />
          <span>trades</span>
          {MIN_TRADE_PRESETS.map((n) => (
            <button key={n} type="button" aria-pressed={minT === n} onClick={() => setMinTrades(n)}
                    className={cn('m-0 h-7 min-w-7 appearance-none rounded-md border border-solid px-1.5 font-[inherit] text-[11.5px] tabular-nums',
                      minT === n ? 'border-foreground bg-muted text-foreground' : 'border-border bg-transparent text-muted-foreground')}>
              {n}
            </button>
          ))}
          {minT < 3 && <span className="text-[var(--warn)]">— one or two trades is luck, not a record</span>}
        </div>
        {errors.methods && <p role="alert" className="m-0 mt-1 text-[11.5px] text-[var(--down)]">{errors.methods}</p>}
        {catalogueError && !methods.length && (
          <p role="alert" className="m-0 mt-1 text-[11.5px] text-[var(--down)]">Could not load the methods: {catalogueError.message}</p>
        )}

        <ul aria-label="methods" className="m-0 mt-1.5 max-h-[26rem] list-none overflow-y-auto rounded-lg border border-solid border-border p-0">
          {shown.map((m) => {
            const rec = recordOf.get(m.id);
            const on = picked.has(m.id);
            return (
              <li key={m.id} className="border-0 border-b border-solid border-border last:border-b-0">
                <label className={cn('flex cursor-pointer items-start gap-2 px-2.5 py-2', on && 'bg-muted/60')}>
                  <input type="checkbox" checked={on} onChange={() => toggle(m.id)} aria-label={`#${m.n} ${m.name}`}
                         className="mt-0.5 h-4 w-4 flex-none accent-[var(--warn)]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[12.5px] font-medium text-foreground">
                        <span className="tabular-nums text-muted-foreground">#{m.n}</span> {m.name}
                        {m.orderSide && (
                          <span aria-label={`#${m.n} order side`} className={cn('ml-1.5 text-[10px] font-semibold', m.orderSide === 'BUY' ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
                            {m.orderSide}
                          </span>
                        )}
                      </span>
                      <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
                        {rec && rec.trades > 0
                          ? (
                            <>
                              <span title={rule.mode === 'single' && tfs.length > 1 ? `Over ${tfs.join(' + ')} together` : undefined}>
                                {Math.round(rec.winPct ?? 0)}% win
                              </span> · {rec.trades}t ·{' '}
                              <span className={rec.netPts > 0 ? 'text-[var(--up)]' : rec.netPts < 0 ? 'text-[var(--down)]' : ''}>
                                {pts(rec.netPts)} pts
                              </span>
                              {rec.netPts > 0 && rec.trades < minT && (
                                <span className="ml-1 text-[var(--warn)]" title={`Profitable, but on ${rec.trades} of the ${minT} trades "Pick profitable" asks for`}>
                                  · {rec.trades} of {minT} trades
                                </span>
                              )}
                            </>
                          )
                          : 'no trades yet'}
                      </span>
                    </span>
                    {byTf.has(m.id) && (
                      <span className="mt-0.5 block text-[10.5px] tabular-nums text-muted-foreground" aria-label={`#${m.n} by timeframe`}>
                        {byTf.get(m.id)!.map(({ tf, row }, i) => (
                          <span key={tf}>
                            {i > 0 && ' · '}
                            {tf}{' '}
                            {row && row.trades > 0
                              ? (
                                <>
                                  <span className="text-foreground">{Math.round((row.wins / row.trades) * 100)}%</span>{' '}
                                  <span className={row.netPts > 0 ? 'text-[var(--up)]' : row.netPts < 0 ? 'text-[var(--down)]' : ''}>{pts(row.netPts)}</span>
                                  {' '}({row.trades}t)
                                </>
                              )
                              : <span className="text-[var(--dim)]">—</span>}
                          </span>
                        ))}
                      </span>
                    )}
                    <span className="mt-0.5 block text-[10.5px] leading-snug text-[var(--dim)]">{m.summary} · SL: {m.sl}</span>
                  </span>
                </label>
              </li>
            );
          })}
          {methods.length > 0 && !shown.length && (
            <li className="px-2.5 py-3 text-center text-[12px] text-muted-foreground">
              {query.trim() ? `No method matches “${query}”.` : 'No method under these filters.'}
            </li>
          )}
        </ul>
        <p className="m-0 mt-1 text-[10.5px] text-[var(--dim)]">
          Record: win rate · trades · net BTC points, every signal so far {way} (the Methods tab).
        </p>
      </div>

      {/*
        The levels a trade would carry, read off the live board: the signal's own
        stop and targets on the BTC perpetual. They are made and moved by the
        method, per signal -- the strategy only says which target to use.
      */}
      <div className="rounded-lg border border-solid border-border px-2.5 py-2" aria-label="live signals">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium text-foreground">Standing now</span>
          <span className="text-[10.5px] text-[var(--dim)]">
            {board?.ltp ? `BTC perp ${px(board.ltp.price)} · ` : ''}re-read every 10 s
          </span>
        </div>
        {!rule.methods.length
          ? <p className="m-0 mt-1 text-[11.5px] text-muted-foreground">Pick a method to see its signals here.</p>
          : !live.length
            ? <p className="m-0 mt-1 text-[11.5px] text-muted-foreground">No TRADE signal from the picked methods right now.</p>
            : (
              <ul className="m-0 mt-1 list-none p-0">
                {live.map((r) => {
                  const p = r.plan!;
                  const leg = legOfSignal(r.dir!, rule.action === 'buy' ? 'buy' : 'sell');
                  return (
                    <li key={`${r.id}|${r.mode}|${r.tf}`} className="py-0.5 text-[11.5px] leading-snug tabular-nums">
                      <span className="text-muted-foreground">#{r.n} {nameOf(r.id)?.name ?? r.name}{rule.mode === 'single' && tfs.length > 1 ? ` (${r.tf})` : ''}</span>{' '}
                      <span className={r.dir === 'long' ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{r.dir === 'long' ? 'BUY' : 'SELL'}</span>
                      {rule.action === 'buy' ? ' → buys ' : ' → sells '}<b className="font-semibold text-foreground">{leg}</b>
                      {' · perp SL '}{px(p.stop)}
                      {' · TGT1 '}{px(p.tp1)}
                      {p.tp2 != null && <> · TGT2 {px(p.tp2)}</>}
                      {p.tp3 != null && <> · TGT3 {px(p.tp3)}</>}
                    </li>
                  );
                })}
              </ul>
            )}
      </div>
    </div>
  );
}
