/**
 * A signal strategy's methods, picked again every day by their own record (owner, 16 Oct 2026: "daily, a time
 * chosen, the methods picked by a win %, auto update on and off in the signal strategy form").
 *
 * The record is the form's own "as options · this strategy's rules" one (`methodRecord`, the same the Win tab
 * reads): every method on all its signals, sold as the strategy sells and bought back as it buys back, money after
 * charges. Once a day at the strategy's time, over the last finished expiry days, the methods that won the share
 * asked for, on enough trades, become its list -- best net first. None passing leaves the list as it was: a
 * strategy is never emptied by a bad week. The methods excluded (`exclude`, while it is on) are never picked, and
 * are taken out of a list that is kept -- unless that would empty it. Only new signals read the list (`signalMatches`); a trade already
 * open keeps its exits whatever is picked.
 *
 * Measured on 16 Oct 2026 over 8-15 Oct, each day picked only from the days before it: win 75% re-picked daily
 * made the most; every day beat once a week; every method, unfiltered, lost the most.
 */
import { rows } from '../db/pool.js';
import { methodsSchema } from '../entry/catalogue.js';
import { DEFAULT_PARAMS, type SignalBacktest } from '../report/signal-backtest.js';
import { signalBacktest } from '../report/backtest-run.js';
import { sessionDayOf } from '../report/market-day.js';
import { excludedBy, tfLabel, validateConfig, type AutoMethods, type AutoMethodsRun, type MethodUpdate, type Strategy, type StrategyConfig } from './types.js';

const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

export type MethodRec = { method: string; trades: number; wins: number; net: number; byTf: { tf: string; trades: number; wins: number; net: number }[] };
export type MethodRecordResult = { from: string; to: string; priced: SignalBacktest['priced']; signals: number; trades: number; methods: MethodRec[] };

/**
 * Every method's record as options under a strategy's rules, `from` to `to` (expiry days): each method on every
 * one of its signals, none taking another's place (`draft`). Read-only.
 */
export async function methodRecord(config: StrategyConfig, o: { from: string; to: string; now: number; spot: number | null }): Promise<MethodRecordResult> {
  await methodsSchema();
  const every = (await rows<{ id: string }>('SELECT id FROM entry_methods ORDER BY id')).map((m) => m.id);
  const draft: Strategy = {
    id: 'draft', name: 'draft', enabled: false, accountId: null, createdAt: o.now, updatedAt: o.now,
    config: { ...config, signal: { ...config.signal!, methods: every } },
  };
  const r = await signalBacktest({ from: o.from, to: o.to, now: o.now, params: { ...DEFAULT_PARAMS }, tfs: null, methods: null, strategy: draft, draft: true, spot: o.spot });
  const by = new Map<string, MethodRec>();
  for (const p of r.pairs) {
    // A pair's key is its method, its way and its timeframe; with the chain the timeframe is the chain itself.
    const [method, mode, tf] = p.key.split('|') as [string, string, string];
    let m = by.get(method);
    if (!m) { m = { method, trades: 0, wins: 0, net: 0, byTf: [] }; by.set(method, m); }
    m.trades += p.n; m.wins += p.wins; m.net += p.net;
    m.byTf.push({ tf: mode === 'mtf' ? 'chain' : tf, trades: p.n, wins: p.wins, net: p.net });
  }
  return { from: o.from, to: o.to, priced: r.priced, signals: r.signals, trades: r.total.n, methods: [...by.values()].sort((a, b) => b.net - a.net) };
}

/** The last `days` finished expiry days at `now`: the one being traded is not finished, so it ends the day before. */
export function autoWindow(now: number, days: number): { from: string; to: string } {
  const live = Date.parse(`${sessionDayOf(now)}T00:00:00Z`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(live - days * DAY_MS), to: iso(live - DAY_MS) };
}

/** The methods that won `winPct`% or more of `minTrades` trades or more, best net first. */
export function pickMethods(records: readonly Pick<MethodRec, 'method' | 'trades' | 'wins' | 'net'>[], a: Pick<AutoMethods, 'winPct' | 'minTrades'>): string[] {
  return records
    .filter((r) => r.trades >= a.minTrades && (r.wins / r.trades) * 100 >= a.winPct - 1e-9)
    .sort((x, y) => y.net - x.net)
    .map((r) => r.method);
}

/** Today's run time, epoch ms: the IST date of `now` at `at`. */
const runTimeOn = (now: number, at: string) => Date.parse(`${new Date(now + IST_MS).toISOString().slice(0, 10)}T${at}:00+05:30`);

/** Whether a strategy's update is due: on, today's time passed, and not run since it. Once a day, caught up after a restart. */
export function autoDue(s: Pick<Strategy, 'config'>, now: number): boolean {
  const a = s.config.trigger === 'signal' ? s.config.signal?.autoMethods : null;
  if (!a?.on) return false;
  const when = runTimeOn(now, a.at);
  return Number.isFinite(when) && now >= when && !((a.last?.at ?? 0) >= when);
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A list less the excluded methods; the list as it is when nothing would be left -- a strategy is never emptied. */
export function lessExcluded(list: readonly string[], a: Pick<AutoMethods, 'exclude'>): string[] {
  const out = excludedBy(a);
  const kept = list.filter((m) => !out.has(m));
  return kept.length ? kept : [...list];
}

/**
 * One pick for a strategy's rules as given (saved or on the form): the list it would set, and the record behind it.
 * Nothing passing keeps the list it has, said in `note`.
 */
export async function autoPick(config: StrategyConfig, a: AutoMethods, now: number, spot: number | null, record = methodRecord): Promise<AutoMethodsRun> {
  const { from, to } = autoWindow(now, a.days);
  const before = config.signal?.methods ?? [];
  const r = await record(config, { from, to, now, spot });
  const out = excludedBy(a);
  const passed = pickMethods(r.methods, a);
  const picked = passed.filter((m) => !out.has(m));
  // The excluded ones that would have come in: said, so a 90% method missing from the list is not a mystery.
  const excluded = out.size ? { excluded: passed.filter((m) => out.has(m)) } : {};
  // Every method that traded, in brief: why each came, stayed or went -- for the preview and the log.
  const records = r.methods.filter((m) => m.trades > 0).map(({ method, trades, wins, net }) => ({ method, trades, wins, net }));
  if (!picked.length) {
    const kept = lessExcluded(before, a);
    const less = before.length - kept.length;
    const why = `No method ${out.size ? 'but an excluded one ' : ''}won ${a.winPct}% of ${plural(a.minTrades, 'trade')} or more`;
    return { at: now, from, to, picked: kept, before, records, ...excluded, note: `${why}: the list was kept${less ? `, less the ${plural(less, 'excluded method')}` : ''}.` };
  }
  return { at: now, from, to, picked, before, records, ...excluded };
}

export type AutoDeps = {
  all: () => Promise<Strategy[]>;
  get: (id: string) => Promise<Strategy | null>;
  save: (s: Strategy) => Promise<unknown>;
  pick: (config: StrategyConfig, a: AutoMethods, now: number) => Promise<AutoMethodsRun>;
  /** The day's summary, one message for every strategy updated in the run. */
  tell: (text: string) => void;
  /** Each strategy's run, kept (`strategy_method_updates`): changed or kept, with why. */
  log: (u: Omit<MethodUpdate, 'id' | 'added' | 'dropped'>) => Promise<unknown>;
  warn: (message: string) => void;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dayWords = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Every strategy whose update is due, one after the other (the backtest thread takes one at a time). Each is
 * read again before it is written, and only its list and `last` change: a save from the form in the minute the
 * record took is kept. Returns the ids updated.
 */
export async function runAutoMethods(now: number, d: AutoDeps): Promise<string[]> {
  const done: string[] = [];
  const lines: string[] = [];
  for (const s of (await d.all()).filter((x) => autoDue(x, now))) {
    const a = s.config.signal!.autoMethods!;
    let run: AutoMethodsRun;
    try {
      run = await d.pick(s.config, a, now);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const { from, to } = autoWindow(now, a.days);
      const before = s.config.signal!.methods;
      run = { at: now, from, to, picked: lessExcluded(before, a), before, note: `The record could not be had: ${why}. The list was kept.` };
      d.warn(`methods' daily update for ${s.name}: ${why}`);
    }
    const fresh = await d.get(s.id);
    const rule = fresh?.config.signal;
    if (!fresh || !rule?.autoMethods?.on) continue;
    // The list as it stands now is the one replaced (a save from the form may have come in the meantime); kept, it
    // stays -- less what is excluded now, unless that would empty it.
    const before = rule.methods;
    const took = run.picked.filter((m) => !excludedBy(rule.autoMethods).has(m));
    const after = run.note || !took.length ? lessExcluded(before, rule.autoMethods) : took;
    const { records = [], ...brief } = run;
    run = { ...brief, before, picked: after };
    const config: StrategyConfig = { ...fresh.config, signal: { ...rule, methods: after, autoMethods: { ...rule.autoMethods, last: run } } };
    const problems = validateConfig(config);
    if (problems.length) { d.warn(`methods' daily update for ${s.name} not saved: ${problems.join(' ')}`); continue; }
    await d.save({ ...fresh, config });
    done.push(s.id);
    await d.log({
      at: now, strategyId: fresh.id, strategyName: fresh.name, accountId: fresh.accountId ?? null, source: 'daily', tf: tfLabel(rule),
      rule: { winPct: a.winPct, minTrades: a.minTrades, days: a.days }, from: run.from, to: run.to, before, after,
      // the records of every method that traded: the ones picked, dropped, and the ones that missed the line
      records,
      note: run.note ?? null,
    }).catch((e: Error) => d.warn(`methods' daily update for ${s.name}: not logged: ${e.message}`));
    const added = run.picked.filter((m) => !run.before.includes(m)).length, dropped = run.before.filter((m) => !run.picked.includes(m)).length;
    const out = excludedBy(rule.autoMethods).size;
    const said = `win ≥${a.winPct}% on ${a.minTrades}+, ${dayWords(run.from)} – ${dayWords(run.to)}${out ? `, ${out} excluded` : ''}`;
    lines.push(run.note
      ? `<b>${esc(s.name)}</b>: kept ${run.picked.length} (${said}). ${esc(run.note)}`
      : added + dropped === 0
        ? `<b>${esc(s.name)}</b>: no change, ${plural(run.picked.length, 'method')} (${said})`
        : `<b>${esc(s.name)}</b>: ${run.before.length} → ${run.picked.length} methods, +${added} −${dropped} (${said})`);
  }
  if (lines.length) d.tell(['Methods updated by their record:', ...lines].join('\n'));
  return done;
}
