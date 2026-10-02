import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { getEntryBoard, getEntryMethods, getMethodReport, type EntryMethodInfo } from '@/api/entry';
import { usePoll } from '@/hooks/usePoll';
import { Input } from '@/components/ui/input';
import { legOfSignal, ruleTfs, SIGNAL_TFS, type SignalRule, type SignalTf } from '@/types/strategy';
import type { MethodRead, MethodReportRow } from '@/types/entry';
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

/** Enough trades that a record means something; fewer and "profitable" is a coin's opinion. */
export const MIN_TRADES_FOR_RECORD = 5;

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
export function profitableIds(rows: readonly MethodReportRow[]): string[] {
  return rows.filter((r) => r.trades >= MIN_TRADES_FOR_RECORD && r.netPts > 0).map((r) => r.method);
}

export function SignalRuleEditor({ rule, onChange, errors }: {
  rule: SignalRule;
  onChange: (r: SignalRule) => void;
  errors: { mode?: string | null; tf?: string | null; methods?: string | null };
}) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<GroupFilter>('all');
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
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return methods.filter((m) => (group === 'all' || m.group === group)
      && (!q || String(m.n) === q || m.name.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q)));
  }, [methods, query, group]);
  const picked = new Set(rule.methods);
  const toggle = (id: string) => set('methods', picked.has(id) ? rule.methods.filter((x) => x !== id) : [...rule.methods, id]);
  const addAll = (ids: string[]) => set('methods', [...new Set([...rule.methods, ...ids])]);
  const winners = profitableIds(rows);
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

      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-[12px] text-muted-foreground">Methods</span>
          <span className="text-[11.5px] tabular-nums text-foreground" aria-live="polite">
            {rule.methods.length} of {methods.length || 81} picked
          </span>
        </div>
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
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          <button type="button" className={link} disabled={!shown.length} onClick={() => addAll(shown.map((m) => m.id))}>
            Pick all shown ({shown.length})
          </button>
          <button type="button" className={link} disabled={!winners.length}
                  title={`Net points above zero over at least ${MIN_TRADES_FOR_RECORD} trades, added up ${way} -- every timeframe picked, together: what this strategy would have taken`}
                  onClick={() => addAll(winners)}>
            Pick profitable {rule.mode === 'mtf' ? 'with the chain' : `on ${tfs.join(' + ') || '—'}`} ({winners.length})
          </button>
          <button type="button" className={link} disabled={!rule.methods.length} onClick={() => set('methods', [])}>
            Clear
          </button>
        </div>
        {errors.methods && <p role="alert" className="m-0 mt-1 text-[11.5px] text-[var(--down)]">{errors.methods}</p>}
        {catalogueError && !methods.length && (
          <p role="alert" className="m-0 mt-1 text-[11.5px] text-[var(--down)]">Could not load the methods: {catalogueError.message}</p>
        )}

        <ul aria-label="methods" className="m-0 mt-1.5 max-h-72 list-none overflow-y-auto rounded-lg border border-solid border-border p-0">
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
                      </span>
                      <span className="flex-none text-[11px] tabular-nums text-muted-foreground">
                        {rec && rec.trades > 0
                          ? (
                            <>
                              {Math.round(rec.winPct ?? 0)}% · {rec.trades}t ·{' '}
                              <span className={rec.netPts > 0 ? 'text-[var(--up)]' : rec.netPts < 0 ? 'text-[var(--down)]' : ''}>
                                {pts(rec.netPts)} pts
                              </span>
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
                              ? <span className={row.netPts > 0 ? 'text-[var(--up)]' : row.netPts < 0 ? 'text-[var(--down)]' : ''}>{pts(row.netPts)} ({row.trades}t)</span>
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
            <li className="px-2.5 py-3 text-center text-[12px] text-muted-foreground">No method matches “{query}”.</li>
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
                  const leg = legOfSignal(r.dir!);
                  return (
                    <li key={`${r.id}|${r.mode}|${r.tf}`} className="py-0.5 text-[11.5px] leading-snug tabular-nums">
                      <span className="text-muted-foreground">#{r.n} {nameOf(r.id)?.name ?? r.name}{rule.mode === 'single' && tfs.length > 1 ? ` (${r.tf})` : ''}</span>{' '}
                      <span className={r.dir === 'long' ? 'text-[var(--up)]' : 'text-[var(--down)]'}>{r.dir === 'long' ? 'BUY' : 'SELL'}</span>
                      {' → sells '}<b className="font-semibold text-foreground">{leg}</b>
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
