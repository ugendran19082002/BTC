import type { FastifyInstance } from 'fastify';
import { tradingService } from '../../trading/service.js';
import { sessionDayOf } from '../../report/market-day.js';
import { REPORT_FIRST_DAY, REPORT_MAX_DAYS, marketBreakdown, marketReport, type ReportFilters } from '../../report/market-report.js';
import { DAY_START_IST, DEFAULT_PARAMS, MIN_PREMIUM, type Chase, WIDEN_ATR_MAX, WIDEN_MODES, type WidenMode, breakEvenProblems, tslProblems, tslQueryOf, type Tsl, type TslUnit, type BacktestStrategy, VOL_STUDY_DELTA, VOL_STUDY_LOTS, VOL_STUDY_SL, VOL_STUDY_WIN, type VolWin, backtestable, strategyCaveats, type BacktestParams, type VolLevel, type VolRule, type VolTradesPick, type WinSweepAsk, type WinSweepCellPick, SESSION_RULES_MAX, SESSION_WIN, type SessionRule, type SessionTradesPick, type SessionWin } from '../../report/signal-backtest.js';
import { rows } from '../../db/pool.js';
import { methodsSchema } from '../../entry/catalogue.js';
import { liveCheck, sessionStudy, sessionStudyTrades, signalBacktest, signalBacktestTrades, volStudy, volStudyTrades, winSweep, winSweepTrades } from '../../report/backtest-run.js';
import { cleanBlocks, cleanConfig, strategyStore } from './strategy.routes.js';
import { GLOBAL_MAX_OPEN_KEY, MAX_STRIKE_BLOCKS, STRIKE_FULL_KEY, STRIKE_MAX_KEY, strikeFullOf, strikeMaxOf, SIGNAL_TFS, autoMethodsProblems, SIDE_MAX_KEYS, actionOf, exitRules, globalMaxOpenOf, minutesForward, minutesOf, noEntryProblems, ruleTfs, sideMaxOf, strikeBlockProblems, validateConfig, type Strategy, type StrikeBlock } from '../../strategy/types.js';
import { accountSetting } from '../../db/settings.js';
import { brokerAccounts } from '../../delta/accounts.js';
import { refuse } from '../refuse.js';
import { accountOf } from '../account-query.js';
import { WALK_MAX_DAYS, WALK_MAX_HOLDOUT, autoPick, autoWindow, methodRecord, walkForwardOf } from '../../strategy/auto-methods.js';
import { METHODS } from '../../entry/methods.js';

/**
 * The market report (13 Oct 2026): every expiry day -- 5:30 PM IST to 5:30 PM IST -- with the kind of day the
 * BTC perp had, and what the signal history and the real orders made on it. Read-only.
 *
 * `?from=&to=` are expiry days (YYYY-MM-DD, the day the contract settles); without them, from 1 Oct 2026 to the
 * day in progress. `?account=` is one broker account's orders (the signal history has no account). `?tf=`,
 * `?method=` and `?strategy=` keep only those timeframes (`chain` for the timeframe chain), entry methods and
 * strategies; a strategy narrows the real orders only.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function rangeOf(q: { from?: unknown; to?: unknown }, now = Date.now()): { from: string; to: string } | string {
  const today = sessionDayOf(now);
  const from = q.from === undefined || q.from === '' ? REPORT_FIRST_DAY : String(q.from);
  const to = q.to === undefined || q.to === '' ? today : String(q.to);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return 'Dates must be YYYY-MM-DD.';
  if (from > to) return 'The start date must not be after the end date.';
  if (Date.parse(to) - Date.parse(from) > REPORT_MAX_DAYS * 86_400_000) return `At most ${REPORT_MAX_DAYS} days at a time.`;
  return { from, to };
}

function listOf(q: unknown, name: 'tf' | 'method' | 'strategy'): string[] | null {
  const raw = (q as Record<string, unknown> | null | undefined)?.[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter((k) => k !== '' && k.length <= 120))].slice(0, 200);
  return keys.length ? keys : null;
}
/** The report itself is not filtered any more (13 Oct 2026); the backtest still reads one strategy's orders through the same sums. */
const NO_FILTERS: ReportFilters = { account: null, tfs: null, methods: null, strategies: null };

/**
 * The backtest's settings, checked: `?rule=delta|premium`, `?value=` (a delta from 0.02 to 0.5, or a premium from
 * 10 to 500 dollars), `?lots=` (1 to 1,000), `?tp=` and `?sl=` (the option's own target and stop as shares of the
 * premium; 0 is none), `?window=desk|all`. Absent ones are the defaults.
 */
/**
 * The signal strategies a backtest may be asked about -- those that sell -- each with its methods' history (18 Oct
 * 2026): a strategy whose methods are picked again every day is backtested on the list it had at each signal
 * (`methodsAt`), as it traded, not on today's list for every day. A history that cannot be read is no history: today's
 * list, as before.
 */
export async function backtestStrategies(): Promise<BacktestStrategy[]> {
  const every = (await strategyStore().all().catch(() => [])).filter(backtestable);
  const lists = await strategyStore().methodLists(every.map((s) => s.id)).catch(() => new Map<string, never[]>());
  return every.map((s) => (lists.get(s.id)?.length ? { ...s, methodHistory: lists.get(s.id)! } : s));
}

/**
 * Each trading account's signal strategies that sell, with its limit on open trades as it stands: the desk's side
 * of a live check (`liveCheckHere`), which works an account's strategies together under that limit.
 */
export async function liveAccounts(): Promise<{ id: number | null; name: string | null; caps: { deskMax: number; cePct: number; pePct: number; strikePct: number; strikeFull: 'next' | 'skip' } | null; strategies: Strategy[] }[]> {
  const every = await backtestStrategies();
  const svc = tradingService();
  const nameOf = (id: number | null) => { try { return id == null ? null : brokerAccounts().get(id)?.name ?? null; } catch { return null; } };
  return [...new Set(every.map((s) => s.accountId ?? null))].map((id) => {
    const max = globalMaxOpenOf(accountSetting(svc.settings, GLOBAL_MAX_OPEN_KEY, id));
    return {
      id, name: nameOf(id),
      // And the most on one strike, as the account's runner holds it (22 Oct 2026).
      caps: max > 0 ? {
        deskMax: max, cePct: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.CE, id)), pePct: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.PE, id)),
        strikePct: strikeMaxOf(accountSetting(svc.settings, STRIKE_MAX_KEY, id)), strikeFull: strikeFullOf(accountSetting(svc.settings, STRIKE_FULL_KEY, id)),
      } : null,
      strategies: every.filter((s) => (s.accountId ?? null) === id),
    };
  });
}

export function backtestParamsOf(q: Record<string, unknown>): BacktestParams | string {
  const num = (name: string, fallback: number) => (q[name] === undefined || q[name] === '' ? fallback : Number(q[name]));
  const rule = q.rule === undefined || q.rule === '' ? DEFAULT_PARAMS.rule : q.rule;
  if (rule !== 'delta' && rule !== 'premium') return 'The strike rule is "delta" or "premium".';
  const value = num('value', rule === 'delta' ? 0.1 : 50);
  if (rule === 'delta' ? !(value >= 0.02 && value <= 0.5) : !(value >= 10 && value <= 500)) {
    return rule === 'delta' ? 'A delta limit is from 0.02 to 0.5.' : 'A premium limit is from 10 to 500 dollars.';
  }
  const lots = num('lots', DEFAULT_PARAMS.lots);
  if (!Number.isInteger(lots) || lots < 1 || lots > 1_000) return 'Lots are a whole number from 1 to 1,000.';
  const targetPct = num('tp', DEFAULT_PARAMS.targetPct), stopPct = num('sl', DEFAULT_PARAMS.stopPct);
  if (!(targetPct >= 0 && targetPct <= 0.99)) return 'The option target is a share of the premium from 0 (none) to 0.99.';
  if (!(stopPct >= 0 && stopPct <= 10)) return 'The option stop is a share of the premium from 0 (none) to 10.';
  const window = q.window === undefined || q.window === '' ? DEFAULT_PARAMS.window : q.window;
  if (window !== 'desk' && window !== 'all' && window !== 'custom') return 'The window is "desk", "all" or "custom".';
  // Custom hours: `?hfrom=22:00&hto=02:00`, IST, the end not included.
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const hoursFrom = typeof q.hfrom === 'string' ? q.hfrom : '', hoursTo = typeof q.hto === 'string' ? q.hto : '';
  if (window === 'custom' && (!hhmm.test(hoursFrom) || !hhmm.test(hoursTo))) return 'Custom hours are a From and a To time, HH:MM (IST).';
  if (window === 'custom' && hoursFrom === hoursTo) return 'The From and To times must differ.';
  // The desk's own limits, as the Signal Strategies card sets them: at most open 0 (none) to 500; each side 1 to 100%.
  const deskMax = num('max', 0), cePct = num('ce', 100), pePct = num('pe', 100);
  if (!Number.isInteger(deskMax) || deskMax < 0 || deskMax > 500) return 'At most open is a whole number from 0 (no limit) to 500.';
  if (!(cePct >= 1 && cePct <= 100) || !(pePct >= 1 && pePct <= 100)) return 'CE max and PE max are from 1% to 100%.';
  // The most on one strike, as the live desk holds it (22 Oct 2026): `?sk=` per cent of at most open, 1 to 100 (100, or
  // absent, none), and `?skf=next|skip` -- at it, the next strike out (the default, as live) or skip.
  const strikePct = num('sk', 100);
  if (!Number.isInteger(strikePct) || strikePct < 1 || strikePct > 100) return 'The most on one strike is a whole per cent of at most open, from 1 to 100.';
  const strikeFull = q.skf === undefined || q.skf === '' ? 'next' : q.skf;
  if (strikeFull !== 'next' && strikeFull !== 'skip') return 'At a full strike: "next" (the next strike out) or "skip".';
  // The SL and TGT range, in BTC points: `?slmin=&slmax=&tgtmin=&tgtmax=`, 0 off.
  const slMin = num('slmin', 0), slMax = num('slmax', 0), tgtMin = num('tgtmin', 0), tgtMax = num('tgtmax', 0);
  for (const v of [slMin, slMax, tgtMin, tgtMax]) if (!(v >= 0 && v <= 20_000)) return 'An SL or TGT distance is from 0 (off) to 20,000 points.';
  if (slMin > 0 && slMax > 0 && slMax < slMin) return 'The SL maximum must not be under its minimum.';
  if (tgtMin > 0 && tgtMax > 0 && tgtMax < tgtMin) return 'The TGT maximum must not be under its minimum.';
  /*
   * A target by the clock: `?tsteps=23:30:73,01:30:76` -- from each IST time, that per cent of the premium kept;
   * `tp` is where it starts. Up to 24 steps, each time once, each 1 to 99%. Absent: the one target all day.
   */
  const targetSteps: { at: string; pct: number }[] = [];
  if (typeof q.tsteps === 'string' && q.tsteps.trim() !== '') {
    for (const part of q.tsteps.split(',')) {
      const m = /^(([01]\d|2[0-3]):[0-5]\d):(\d{1,2}(?:\.\d+)?)$/.exec(part.trim());
      if (!m) return 'A target step is a time and a per cent, HH:MM:NN -- for example 23:30:73.';
      const pc = Number(m[3]);
      if (!(pc >= 1 && pc <= 99)) return 'A target step keeps from 1% to 99% of the premium.';
      targetSteps.push({ at: m[1]!, pct: Math.round(pc * 100) / 10_000 });
    }
    if (targetSteps.length > 24) return 'At most 24 target steps.';
    if (new Set(targetSteps.map((x) => x.at)).size !== targetSteps.length) return 'Two target steps have the same time.';
    if (!(targetPct > 0)) return 'A target by the clock needs a target to start from.';
  }
  // The volatility when a signal fills: `?vol=off|low|medium|high`.
  const vol = q.vol === undefined || q.vol === '' ? 'off' : q.vol;
  if (vol !== 'off' && vol !== 'low' && vol !== 'medium' && vol !== 'high') return 'The volatility filter is "off", "low", "medium" or "high".';
  // What that level is read from: `?volby=atr|iv` -- the candles' ATR (the default) or the board's ATM implied volatility.
  const volBy = q.volby === undefined || q.volby === '' ? 'atr' : q.volby;
  if (volBy !== 'atr' && volBy !== 'iv') return 'Volatility is read by "atr" or "iv".';
  /*
   * The chase guard (22 Oct 2026): `?chase=07:00-11:00-400` -- from 11:00 IST, skip a signal that sells the way BTC
   * has moved 400 points or more since 07:00 the same expiry day. Both read forward from 5:30 PM, the check after the
   * reference; 50 to 20,000 points. `off` or absent: none.
   */
  let chase: Chase | undefined;
  if (typeof q.chase === 'string' && q.chase.trim() !== '' && q.chase.trim() !== 'off') {
    const m = /^(\d\d:\d\d)-(\d\d:\d\d)-(\d+)$/.exec(q.chase.trim());
    if (!m || !hhmm.test(m[1]!) || !hhmm.test(m[2]!)) return 'The chase guard is a time the move is read from, a time it is checked from and the points, HH:MM-HH:MM-N -- for example 07:00-11:00-400.';
    const start = minutesOf(DAY_START_IST);
    if (!(minutesForward(start, minutesOf(m[2]!)) > minutesForward(start, minutesOf(m[1]!)))) return 'The chase guard is checked from a time after the one the move is read from, in the same expiry day (from 5:30 PM).';
    const pts = Number(m[3]);
    if (!(pts >= 50 && pts <= 20_000)) return 'The chase guard\'s move is from 50 to 20,000 points.';
    chase = { from: m[1]!, after: m[2]!, pts };
  }
  // The least premium an option is sold for: `?minprem=`, dollars, 0 for no floor. Absent: 10.
  const minPremium = num('minprem', MIN_PREMIUM);
  if (!(minPremium >= 0 && minPremium <= 500)) return 'The minimum premium is from 0 (no floor) to 500 dollars.';
  /*
   * No-entry windows: `?noentry=00:30-01:30,03:00-04:00`, IST, from (taken) until (not). Held to the strategy form's
   * own rules (`noEntryProblems`) against these settings' hours: each inside them, none all of them, no overlaps.
   */
  let noEntry: { on: boolean; windows: { from: string; to: string }[] } | undefined;
  if (typeof q.noentry === 'string' && q.noentry.trim() !== '') {
    const windows = q.noentry.split(',').map((x) => { const [from = '', to = ''] = x.trim().split('-'); return { from, to }; });
    const [entry, exit] = window === 'desk' ? ['21:30', '15:59'] : window === 'custom' ? [hoursFrom, hoursTo] : ['17:30', '17:25'];
    const bad = noEntryProblems({ on: true, windows }, entry, exit, true);
    if (bad.length) return bad[0]!.replace("this strategy's", 'the hours\'').replace('Switch the strategy off instead.', 'Take the window off instead.');
    noEntry = { on: true, windows };
  }
  /*
   * A different strike rule by time of day: `?sblocks=` -- the blocks after the first, as JSON, each `{ at, strikeRule,
   * strikeStep, premium, delta?, distance? }` as a strategy saves them (`cleanBlocks`), held to the strategy form's own
   * rules (`strikeBlockProblems`) against these settings' hours. The rule above is block 1.
   */
  let strikeBlocks: StrikeBlock[] | undefined;
  if (typeof q.sblocks === 'string' && q.sblocks.trim() !== '' && q.sblocks.trim() !== '[]') {
    let raw: unknown;
    try { raw = JSON.parse(q.sblocks); } catch { return 'The strike blocks are a list, as JSON.'; }
    if (!Array.isArray(raw)) return 'The strike blocks are a list, as JSON.';
    if (raw.length > MAX_STRIKE_BLOCKS) return `The strike rule can change at most ${MAX_STRIKE_BLOCKS} times in a window.`;
    const blocks = cleanBlocks(raw);
    const [entry, exit] = window === 'desk' ? ['21:30', '15:59'] : window === 'custom' ? [hoursFrom, hoursTo] : ['17:30', '17:25'];
    const bad = strikeBlockProblems(blocks, entry, exit);
    if (bad.length) return bad[0]!;
    strikeBlocks = blocks;
  }
  /*
   * A trailing stop on the option's stop: `?tsl=5pts:5pts` -- every 5 points the premium falls from the price sold,
   * the stop comes down 5 -- or in per cent of the price sold, `10pct:5pct`, either side in either. `off` or absent:
   * none. It needs an option stop to move.
   */
  let tsl: Tsl | undefined;
  if (typeof q.tsl === 'string' && q.tsl.trim() !== '' && q.tsl.trim() !== 'off') {
    const m = /^(\d+(?:\.\d+)?)(pts|pct):(\d+(?:\.\d+)?)(pts|pct)$/.exec(q.tsl.trim());
    if (!m) return 'A trailing SL is a price move and an SL move, each in pts or pct -- for example 5pts:5pts.';
    const t: Tsl = { move: Number(m[1]), moveUnit: m[2] as TslUnit, by: Number(m[3]), byUnit: m[4] as TslUnit };
    const bad = tslProblems(t, stopPct);
    if (bad.length) return bad[0]!;
    tsl = t;
  }
  // The option's stop to the price sold once the premium has fallen so far: `?be=10pct` or `?be=5pts`; `off` or absent, none.
  let breakEven: { move: number; unit: TslUnit } | undefined;
  if (typeof q.be === 'string' && q.be.trim() !== '' && q.be.trim() !== 'off') {
    const m = /^(\d+(?:\.\d+)?)(pts|pct)$/.exec(q.be.trim());
    if (!m) return 'A move to break-even is a premium fall in pts or pct -- for example 10pct or 5pts.';
    const b = { move: Number(m[1]), unit: m[2] as TslUnit };
    const bad = breakEvenProblems(b);
    if (bad.length) return bad[0]!;
    breakEven = b;
  }
  // The perp's SL and TGT widened with volatility: `?wsl=` and `?wtgt=`, each the least ATRs of the 1m candles from the
  // entry; 0 or absent, the signal's own.
  const widenSlAtr = num('wsl', 0), widenTgtAtr = num('wtgt', 0);
  for (const v of [widenSlAtr, widenTgtAtr]) if (!(v >= 0 && v <= WIDEN_ATR_MAX)) return `Widening with volatility is from 0 (off) to ${WIDEN_ATR_MAX} ATRs.`;
  // The perp's own levels left out: `?noperpsl=1`, `?noperptgt=1` (0 or absent: used).
  for (const k of ['noperpsl', 'noperptgt']) if (q[k] !== undefined && q[k] !== '' && q[k] !== '0' && q[k] !== '1') return `${k} is 0 or 1.`;
  const skipPerpSl = q.noperpsl === '1', skipPerpTgt = q.noperptgt === '1';
  // And when volatility falls again: `?wmode=widest` (kept at the widest, the default) or `calm` (back to the signal's own).
  const widenMode = q.wmode === undefined || q.wmode === '' ? 'widest' : q.wmode;
  if (!WIDEN_MODES.includes(widenMode as WidenMode)) return 'When volatility falls again: "widest" or "calm".';
  return {
    rule, value, lots, targetPct, stopPct, window, deskMax, cePct, pePct, slMin, slMax, tgtMin, tgtMax, vol, minPremium,
    // Only where it is not the default, so settings saved before it are the same settings as ever.
    ...(strikePct < 100 ? { strikePct, ...(strikeFull === 'skip' ? { strikeFull: 'skip' as const } : {}) } : {}),
    ...(volBy === 'iv' ? { volBy } : {}),
    ...(window === 'custom' ? { hoursFrom, hoursTo } : {}), ...(targetSteps.length ? { targetSteps } : {}), ...(noEntry ? { noEntry } : {}),
    ...(strikeBlocks ? { strikeBlocks } : {}), ...(tsl ? { tsl } : {}),
    ...(widenSlAtr > 0 ? { widenSlAtr } : {}), ...(widenTgtAtr > 0 ? { widenTgtAtr } : {}),
    ...((widenSlAtr > 0 || widenTgtAtr > 0) && widenMode === 'calm' ? { widenMode: 'calm' as const } : {}),
    ...(skipPerpSl ? { skipPerpSl } : {}), ...(skipPerpTgt ? { skipPerpTgt } : {}), ...(breakEven ? { breakEven } : {}),
    ...(chase ? { chase } : {}),
  };
}

/**
 * What the volatility study sets by level: `?vsl=1` (the default) the option stop, each level's per cent over the
 * premium in `?vh=&vm=&vl=` (150 / 200 / 250 absent); `?vdelta=1` the strike's delta, each level's in `?dh=&dm=&dl=`
 * (0.08 / 0.10 / 0.12 absent); `?vlots=1` the lots, each level's in `?lh=&lm=&ll=` (1 / 2 / 2 absent, whole, 1 to
 * 1,000); `?vwin=1` methods by win % with the bar moved by the level (20 Oct 2026): `?wb=` the base per cent (1 to
 * 100, 50), `?wt=` the least trades (1 to 100, 3), `?wd=` the days before each day read (1 to 30, 14), and each level's
 * move in points `?wl=&wm=&wh=` (-50 to 50; -5 / 0 / +5). At least one of the four.
 */
export function volRuleOf(q: Record<string, unknown>): VolRule | string {
  const on = (k: string, dflt: boolean) => (q[k] === undefined || q[k] === '' ? dflt : q[k] === '1');
  for (const k of ['vsl', 'vdelta', 'vlots', 'vwin']) if (q[k] !== undefined && q[k] !== '' && q[k] !== '0' && q[k] !== '1') return `${k} is 0 or 1.`;
  const read = (keys: [string, string, string], dflt: Record<VolLevel, number>, scale: number, lo: number, hi: number, what: (l: VolLevel) => string) => {
    const out = {} as Record<VolLevel, number>;
    for (const [i, level] of (['high', 'medium', 'low'] as const).entries()) {
      const k = keys[i]!, v = q[k] === undefined || q[k] === '' ? dflt[level] * scale : Number(q[k]);
      if (!(Number.isFinite(v) && v >= lo && v <= hi)) return what(level);
      out[level] = Math.round(v * (scale === 1 ? 100 : 1)) / (scale === 1 ? 100 : scale);
    }
    return out;
  };
  const sl = on('vsl', true) ? read(['vh', 'vm', 'vl'], VOL_STUDY_SL, 100, 10, 1_000, (l) => `The ${l} volatility stop is from 10% to 1,000% of the premium.`) : null;
  if (typeof sl === 'string') return sl;
  const delta = on('vdelta', false) ? read(['dh', 'dm', 'dl'], VOL_STUDY_DELTA, 1, 0.02, 0.5, (l) => `The ${l} volatility delta is from 0.02 to 0.50.`) : null;
  if (typeof delta === 'string') return delta;
  let lots: Record<VolLevel, number> | null = null;
  if (on('vlots', false)) {
    lots = {} as Record<VolLevel, number>;
    for (const [level, k] of [['high', 'lh'], ['medium', 'lm'], ['low', 'll']] as const) {
      const v = q[k] === undefined || q[k] === '' ? VOL_STUDY_LOTS[level] : Number(q[k]);
      if (!(Number.isInteger(v) && v >= 1 && v <= 1_000)) return `The ${level} volatility lots are a whole number from 1 to 1,000.`;
      lots[level] = v;
    }
  }
  let win: VolWin | null = null;
  if (on('vwin', false)) {
    const num = (k: string, dflt: number) => (q[k] === undefined || q[k] === '' ? dflt : Number(q[k]));
    const base = num('wb', VOL_STUDY_WIN.base), minTrades = num('wt', VOL_STUDY_WIN.minTrades), days = num('wd', VOL_STUDY_WIN.days);
    if (!(Number.isFinite(base) && base >= 1 && base <= 100)) return 'The base win % is from 1% to 100%.';
    if (!(Number.isInteger(minTrades) && minTrades >= 1 && minTrades <= 100)) return 'The least trades are a whole number from 1 to 100.';
    if (!(Number.isInteger(days) && days >= 1 && days <= 30)) return 'The days read for the win % are a whole number from 1 to 30.';
    const adj = {} as Record<VolLevel, number>;
    for (const [level, k] of [['high', 'wh'], ['medium', 'wm'], ['low', 'wl']] as const) {
      const v = num(k, VOL_STUDY_WIN.adj[level]);
      if (!(Number.isFinite(v) && v >= -50 && v <= 50)) return `The ${level} volatility move of the win % is from -50 to +50 points.`;
      adj[level] = Math.round(v * 10) / 10;
    }
    win = { base: Math.round(base * 10) / 10, minTrades, days, adj };
  }
  if (!sl && !delta && !lots && !win) return 'Set the SL, the delta, the lots or the win % by volatility: vsl=1, vdelta=1, vlots=1 or vwin=1.';
  return { sl, delta, lots, win };
}

/**
 * What the session study sets (23 Oct 2026): `?ss=` the sessions as JSON, `[{"from":"11:00","to":"16:00","delta":0.08,
 * "sl":150,"win":70}]` -- each an IST span read forward from 5:30 PM (`to` 17:30 is the day's end), none over another,
 * at most `SESSION_RULES_MAX`; in each, `delta` 0.02 to 0.50, `sl` the option stop's per cent over the premium (10 to
 * 1,000), `win` the least per cent its method won (1 to 100), each null or absent to keep it as set. Methods by win %:
 * `?swb=` the bar as set (1 to 100; absent, none), `?swt=` the least trades (1 to 100, 3), `?swd=` the days read
 * before each day (1 to 30, 14). Something must differ from as set. Or why not, in words.
 */
export function sessionRuleOf(q: Record<string, unknown>): { sessions: SessionRule[]; win: SessionWin } | string {
  let raw: unknown;
  try { raw = JSON.parse(typeof q.ss === 'string' ? q.ss : ''); } catch { return 'The sessions are a list, ?ss=[{"from":"11:00","to":"16:00","delta":0.08,"sl":150,"win":70}].'; }
  if (!Array.isArray(raw) || raw.length === 0) return 'Add a session to set its delta, SL or win %.';
  if (raw.length > SESSION_RULES_MAX) return `At most ${SESSION_RULES_MAX} sessions.`;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/, start = minutesOf(DAY_START_IST);
  const sessions: SessionRule[] = [];
  for (const [i, x] of raw.entries()) {
    const r = (x ?? {}) as Record<string, unknown>, n = i + 1;
    if (typeof r.from !== 'string' || typeof r.to !== 'string' || !hhmm.test(r.from) || !hhmm.test(r.to)) return `Session ${n} is a From and a To time, HH:MM (IST).`;
    if (r.from === r.to) return `Session ${n}'s From and To times must differ.`;
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
    const delta = num(r.delta), sl = num(r.sl), win = num(r.win);
    if (delta !== null && !(delta >= 0.02 && delta <= 0.5)) return `Session ${n}'s delta is from 0.02 to 0.50.`;
    if (sl !== null && !(sl >= 10 && sl <= 1_000)) return `Session ${n}'s SL is from 10% to 1,000% of the premium.`;
    if (win !== null && !(win >= 1 && win <= 100)) return `Session ${n}'s win % is from 1% to 100%.`;
    sessions.push({ from: r.from, to: r.to, delta: delta === null ? null : Math.round(delta * 100) / 100, sl: sl === null ? null : Math.round(sl) / 100, win: win === null ? null : Math.round(win * 10) / 10 });
  }
  // Read forward from 5:30 PM, as the session table is: a span is [from, to), and no two share a minute.
  const spans = sessions.map((x) => [minutesForward(start, minutesOf(x.from)), minutesForward(start, minutesOf(x.to)) || 1_440] as const);
  for (const [i, [f, t]] of spans.entries()) {
    if (t <= f) return `Session ${i + 1} runs past 5:30 PM, the daily contract's end: end it by then, or start another after it.`;
    for (const [j, [g, u]] of spans.entries()) if (j < i && f < u && g < t) return `Sessions ${j + 1} and ${i + 1} overlap: a signal must be of one session.`;
  }
  const num = (k: string, dflt: number | null) => (q[k] === undefined || q[k] === '' ? dflt : Number(q[k]));
  const base = num('swb', SESSION_WIN.base), minTrades = num('swt', SESSION_WIN.minTrades)!, days = num('swd', SESSION_WIN.days)!;
  if (base !== null && !(base >= 1 && base <= 100)) return 'The win % as set is from 1% to 100%.';
  if (!(Number.isInteger(minTrades) && minTrades >= 1 && minTrades <= 100)) return 'The least trades are a whole number from 1 to 100.';
  if (!(Number.isInteger(days) && days >= 1 && days <= 30)) return 'The days read for the win % are a whole number from 1 to 30.';
  if (!sessions.some((x) => x.delta !== null || x.sl !== null || x.win !== null)) return 'Set a delta, an SL or a win % in a session: as it stands it is the settings as set.';
  return { sessions, win: { base: base === null ? null : Math.round(base * 10) / 10, minTrades, days } };
}
/** Which of the session study's trades to list: `?side=fixed|by-session`, `?session=` an index or -1 (absent: all), `?day=` one of the days (absent: all). */
export function sessionTradesPickOf(q: Record<string, unknown>, r: { from: string; to: string }, n: number): SessionTradesPick | string {
  if (q.side !== 'fixed' && q.side !== 'by-session') return 'The side is "fixed" (as set) or "by-session".';
  const session = q.session === undefined || q.session === '' ? null : Number(q.session);
  if (session !== null && !(Number.isInteger(session) && session >= -1 && session < n)) return 'The session is one of those asked (from 0), or -1 for none.';
  const day = typeof q.day === 'string' && q.day !== '' ? q.day : null;
  if (day !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < r.from || day > r.to)) return 'The day is one of the expiry days asked for, as YYYY-MM-DD.';
  return { side: q.side, session, day };
}

/**
 * The days methods by win % are picked on, for a run over `r` (19 Oct 2026; read here for the sweep too, 20 Oct): `o_winon=`
 * `before` (the default) the `o_windays=` (1 to 30, 7) finished days before the run; `same`, the run's own; `first`,
 * the run's first `o_windays` days, the run then on the days after them; `custom`, `o_winfrom` to `o_winto`, the run
 * then on its days after the last. With the days the run is left on. Or why not, in words.
 */
export function winDaysOf(q: Record<string, unknown>, r: { from: string; to: string }): { on: 'before' | 'same' | 'first' | 'custom'; pick: { from: string; to: string }; run: { from: string; to: string } } | string {
  const on = q.o_winon === undefined || q.o_winon === '' ? 'before' : q.o_winon;
  const days = q.o_windays === undefined || q.o_windays === '' ? 7 : Number(q.o_windays);
  if (on !== 'before' && on !== 'same' && on !== 'first' && on !== 'custom') return 'methods are picked on the days "before" the run, on its "first" days, on the "same" days, or on "custom" days.';
  if (on !== 'custom' && (!Number.isInteger(days) || days < 1 || days > 30)) return 'methods are picked on 1 to 30 days before it.';
  const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  if (on === 'same') return { on, pick: r, run: r };
  if (on === 'custom') {
    const pickFrom = typeof q.o_winfrom === 'string' ? q.o_winfrom : '', pickTo = typeof q.o_winto === 'string' ? q.o_winto : '';
    if (!DAY.test(pickFrom) || !DAY.test(pickTo) || Number.isNaN(Date.parse(pickFrom)) || Number.isNaN(Date.parse(pickTo))) return 'custom days to pick on are a first and a last day, YYYY-MM-DD.';
    if (pickFrom > pickTo) return 'the first day to pick on must not be after the last.';
    if (pickFrom < REPORT_FIRST_DAY) return `the record starts ${REPORT_FIRST_DAY}; pick on days from then.`;
    if ((Date.parse(pickTo) - Date.parse(pickFrom)) / 86_400_000 + 1 > 31) return 'methods are picked on at most 31 days.';
    if (pickTo >= r.to) return `picking up to ${pickTo} leaves none of ${r.from} to ${r.to} to run on. End the pick before ${r.to}.`;
    // Run on the run's days after the pick, never on one of its own.
    return { on, pick: { from: pickFrom, to: pickTo }, run: pickTo >= r.from ? { from: shift(pickTo, 1), to: r.to } : r };
  }
  if (on === 'first') {
    const pickTo = shift(r.from, days - 1);
    if (pickTo >= r.to) return `picking on its first ${days} day${days === 1 ? '' : 's'} leaves none of ${r.from} to ${r.to} to run on. Pick on fewer days, or run over more.`;
    return { on, pick: { from: r.from, to: pickTo }, run: { from: shift(pickTo, 1), to: r.to } };
  }
  const to = shift(r.from, -1), from = shift(r.from, -days);
  if (to < REPORT_FIRST_DAY) return `there are no finished days before ${r.from} to pick from (the record starts ${REPORT_FIRST_DAY}). Pick on the run's first ${days} days instead, or start the run later.`;
  return { on, pick: { from: from < REPORT_FIRST_DAY ? REPORT_FIRST_DAY : from, to }, run: r };
}

/** The most win % values and least-trades values a sweep takes: every pair is a backtest. */
const SWEEP_PCTS_MAX = 12;
const SWEEP_TRADES_MAX = 4;
/**
 * The bars of a win % sweep (20 Oct 2026): `?w_pcts=50,55,60` the win % values (whole, 1 to 100, at most
 * `SWEEP_PCTS_MAX`) and `?w_trades=1,3` the least trades (whole, 1 to 100, at most `SWEEP_TRADES_MAX`), each in
 * rising order, once. Or why not, in words.
 */
export function sweepBarsOf(q: Record<string, unknown>): { pcts: number[]; minTrades: number[] } | string {
  const list = (k: string) => (typeof q[k] === 'string' && q[k] !== '' ? [...new Set((q[k] as string).split(',').map((x) => Number(x.trim())))].sort((a, b) => a - b) : []);
  const pcts = list('w_pcts'), minTrades = list('w_trades');
  if (!pcts.length) return 'Which win % values: w_pcts=50,55,60.';
  if (pcts.some((x) => !(Number.isInteger(x) && x >= 1 && x <= 100))) return 'Each win % is a whole number from 1 to 100.';
  if (pcts.length > SWEEP_PCTS_MAX) return `At most ${SWEEP_PCTS_MAX} win % values at once.`;
  if (!minTrades.length) return 'Which least trades: w_trades=1,3.';
  if (minTrades.some((x) => !(Number.isInteger(x) && x >= 1 && x <= 100))) return 'Each least trades is a whole number from 1 to 100.';
  if (minTrades.length > SWEEP_TRADES_MAX) return `At most ${SWEEP_TRADES_MAX} least-trades values at once.`;
  return { pcts, minTrades };
}

/**
 * One cell of a sweep, for its trades (20 Oct 2026): `?w_row=` the row's id, and `?w_cell=` `saved`, `all`, or a bar as
 * `<win %>:<least trades>` -- `60:3`. Or why not, in words.
 */
export function sweepCellOf(q: Record<string, unknown>): WinSweepCellPick | string {
  const row = typeof q.w_row === 'string' ? q.w_row.trim() : '';
  if (row === '' || row.length > 120) return 'Which row: w_row=<its id>.';
  const cell = typeof q.w_cell === 'string' ? q.w_cell : '';
  if (cell === 'saved' || cell === 'all') return { row, cell };
  const m = /^(\d{1,3}):(\d{1,3})$/.exec(cell);
  const pct = m ? Number(m[1]) : NaN, minTrades = m ? Number(m[2]) : NaN;
  if (!(pct >= 1 && pct <= 100 && minTrades >= 1 && minTrades <= 100)) return 'Which cell: w_cell=saved, all, or <win %>:<least trades> -- 60:3.';
  return { row, cell: { pct, minTrades } };
}

/** The rows of the single backtest's sweep: the settings whole, or (`?w_split=tf`) each time frame of them alone. */
function sweepRowsOf(q: Record<string, unknown>, params: BacktestParams): WinSweepAsk['members'] {
  const tfs = listOf(q, 'tf'), methods = listOf(q, 'method');
  return q.w_split === 'tf'
    ? (tfs ?? [...[...SIGNAL_TFS].reverse(), 'chain']).map((tf) => ({ id: tf, name: tf === 'chain' ? 'All (chain)' : tf, ask: { params, tfs: [tf], methods, strategy: null } }))
    : [{ id: 'settings', name: 'These settings', ask: { params, tfs, methods, strategy: null } }];
}

/** Which of the study's trades to list: `?day=` (an expiry day of the range), `?side=fixed|by-vol`, `?by=atr|iv`. */
export function volTradesPickOf(q: Record<string, unknown>, r: { from: string; to: string }): VolTradesPick | string {
  const day = typeof q.day === 'string' ? q.day : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < r.from || day > r.to) return 'The day is one of the expiry days asked for, as YYYY-MM-DD.';
  if (q.side !== 'fixed' && q.side !== 'by-vol') return 'The side is "fixed" (as set) or "by-vol".';
  if (q.by !== 'atr' && q.by !== 'iv') return 'Volatility is read by "atr" or "iv".';
  return { day, side: q.side, by: q.by };
}

/** A set of settings as an object -- a saved one -- held to the same rules as one in a query string. */
export function backtestParamsFrom(p: unknown): BacktestParams | string {
  if (!p || typeof p !== 'object') return 'A backtest\'s settings are needed.';
  const x = p as Partial<BacktestParams>;
  return backtestParamsOf({
    rule: x.rule, value: x.value, lots: x.lots, tp: x.targetPct, sl: x.stopPct, window: x.window, hfrom: x.hoursFrom, hto: x.hoursTo,
    max: x.deskMax, ce: x.cePct, pe: x.pePct, sk: x.strikePct, skf: x.strikeFull, slmin: x.slMin, slmax: x.slMax, tgtmin: x.tgtMin, tgtmax: x.tgtMax, vol: x.vol, volby: x.volBy, minprem: x.minPremium,
    tsteps: Array.isArray(x.targetSteps) && x.targetSteps.length ? x.targetSteps.map((s) => `${s.at}:${Math.round(s.pct * 10_000) / 100}`).join(',') : undefined,
    // Kept off with its times, as the form keeps them; only an on switch is a rule.
    noentry: x.noEntry?.on && Array.isArray(x.noEntry.windows) ? x.noEntry.windows.map((w) => `${w.from}-${w.to}`).join(',') : undefined,
    sblocks: Array.isArray(x.strikeBlocks) && x.strikeBlocks.length ? JSON.stringify(x.strikeBlocks) : undefined,
    tsl: x.tsl && typeof x.tsl === 'object' ? tslQueryOf(x.tsl) : undefined,
    wsl: x.widenSlAtr, wtgt: x.widenTgtAtr, wmode: x.widenMode,
    noperpsl: x.skipPerpSl === true ? '1' : undefined, noperptgt: x.skipPerpTgt === true ? '1' : undefined,
    be: x.breakEven && typeof x.breakEven === 'object' ? `${x.breakEven.move}${x.breakEven.unit}` : undefined,
    chase: x.chase && typeof x.chase === 'object' ? `${x.chase.from}-${x.chase.after}-${x.chase.pts}` : undefined,
  });
}

/** A strategy's option target as the backtest's settings take one: where it starts and its time steps, or null where it is not a per cent. */
function targetOf(s: Strategy): { pct: number; steps: { at: string; pct: number }[] } | null {
  const t = exitRules(s.config).target;
  return t.mode === 'pct' && t.value > 0 ? { pct: t.value, steps: t.steps.map((x) => ({ at: x.at, pct: x.value })) } : null;
}

export function registerMarketRoutes(app: FastifyInstance) {
  /**
   * The signal history traded as options on the contracts' own recorded prices (13 Oct 2026): every signal in the
   * trade, an option sold at its fill and bought back at the perp's stop or target, the option's own target or
   * stop, or the window's end. `?from=&to=` are expiry days; `?tf=` and `?method=` narrow it. Read-only, and it
   * takes every signal: no limit on what is open.
   */
  app.get('/api/signal-backtest', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    /*
     * `?strategy=<id>`: backtest by that saved strategy's own rules instead of the screen's settings (owner, 13 Oct
     * 2026: "a strategy list in the backtest -- choose one and backtest by it, else don't"). The list to choose from
     * comes back with every answer: the signal strategies that sell, each with its account.
     */
    const every = await backtestStrategies();
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : every.find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    const accountName = (id: number | null | undefined) => { try { return id == null ? null : brokerAccounts().get(id)?.name ?? null; } catch { return null; } };
    const result = await signalBacktest({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot });
    // Each trading account's own limits as they stand, for the screen to offer as one tap.
    const svc = tradingService();
    let deskLimits: { account: string; max: number; ce: number; pe: number; sk: number; skf: 'next' | 'skip' }[] = [];
    try {
      deskLimits = brokerAccounts().list().filter((a) => a.active).map((a) => ({
        account: a.name,
        max: globalMaxOpenOf(accountSetting(svc.settings, GLOBAL_MAX_OPEN_KEY, a.id)),
        ce: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.CE, a.id)),
        pe: sideMaxOf(accountSetting(svc.settings, SIDE_MAX_KEYS.PE, a.id)),
        // And its most on one strike (22 Oct 2026): per cent of the max, and what a signal does at it.
        sk: strikeMaxOf(accountSetting(svc.settings, STRIKE_MAX_KEY, a.id)),
        skf: strikeFullOf(accountSetting(svc.settings, STRIKE_FULL_KEY, a.id)),
      })).filter((x) => x.max > 0);
    } catch { /* no account set up: none to offer */ }
    return {
      ...result,
      deskLimits,
      // With its methods and timeframes, so the screen can tick a strategy's methods for the settings (`chain`: the timeframe chain).
      strategies: every.map((s) => ({
        id: s.id, name: s.name, enabled: s.enabled, account: accountName(s.accountId),
        methods: [...s.config.signal!.methods], tfs: s.config.signal!.mode === 'mtf' ? ['chain'] : [...ruleTfs(s.config.signal!)],
        // Its option target and time steps, for the screen to copy into a dynamic target (per cent of the premium kept).
        target: targetOf(s),
      }))
        .sort((a, b) => (a.account ?? '').localeCompare(b.account ?? '') || a.name.localeCompare(b.name, 'en', { numeric: true })),
    };
  });

  /**
   * The backtest's trades, one by one (owner, 14 Oct 2026: "tap the count -- each trade's entry, exit, SL, TGT,
   * points and money"; 15 Oct: "by session too"): asked as the backtest itself is, and narrowed by `?day=` (one of
   * its expiry days), `?sfrom=&sto=` (a session of the day, fifteen-minute slots, both in) and `?smethod=` (one
   * method). Each day is played again as its row was. Read-only.
   */
  app.get('/api/signal-backtest/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    // Which trades (`TradePick`): one of its days, or all; a session of the day as fifteen-minute slots; one method.
    const day = typeof q.day === 'string' && q.day !== '' ? q.day : null;
    if (day !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < r.from || day > r.to)) return refuse(reply, 400, { error: 'The day is one of the expiry days asked for, as YYYY-MM-DD.' });
    const slot = (k: string) => (q[k] === undefined || q[k] === '' ? null : Number(q[k]));
    const slotFrom = slot('sfrom'), slotTo = slot('sto');
    if ([slotFrom, slotTo].some((x) => x !== null && !(Number.isInteger(x) && x >= 0 && x <= 95))) return refuse(reply, 400, { error: 'A session is fifteen-minute slots from 0 (5:30 PM) to 95.' });
    const pick = { day, slotFrom, slotTo, method: typeof q.smethod === 'string' && q.smethod !== '' ? q.smethod : null };
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : (await backtestStrategies()).find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    return signalBacktestTrades({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot }, pick);
  });

  /**
   * Methods by win % at several bars, of the settings on the screen (owner, 20 Oct 2026: "an editable range -- the
   * win %, the strategies and the least trades -- in the backtest"): asked as the backtest is, with the bars
   * (`sweepBarsOf`) and the days picked on (`winDaysOf`). `?w_split=tf`: each time frame of it alone -- its methods
   * picked on that time frame's own record -- one row each, as saved backtests by time frame would be. A strategy's
   * methods are its own: not swept. Read-only.
   */
  app.get('/api/signal-backtest/win-sweep', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const runDays = rangeOf(q);
    if (typeof runDays === 'string') return refuse(reply, 400, { error: runDays });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    if (typeof q.strategy === 'string' && q.strategy !== '') return refuse(reply, 400, { error: 'A strategy keeps its own methods: the sweep is of the settings. Choose "Settings" rather than a strategy.' });
    const bars = sweepBarsOf(q);
    if (typeof bars === 'string') return refuse(reply, 400, { error: bars });
    if (q.w_split !== undefined && q.w_split !== '' && q.w_split !== 'tf') return refuse(reply, 400, { error: 'w_split is "tf" or absent.' });
    const d = winDaysOf(q, runDays);
    if (typeof d === 'string') return refuse(reply, 400, { error: `For the sweep: ${d}` });
    return winSweep({ ...d.run, now: Date.now(), spot: tradingService().spot, pick: d.pick, ...bars, members: sweepRowsOf(q, params) });
  });

  /**
   * One cell of the sweep, trade by trade (owner, 20 Oct 2026: "each cell, a tap, a popup, trade by trade"): asked as
   * the sweep is, less its bars, with the cell (`sweepCellOf`). Its methods are worked out again as the sweep worked
   * them, and named in the answer. Read-only.
   */
  app.get('/api/signal-backtest/win-sweep/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const runDays = rangeOf(q);
    if (typeof runDays === 'string') return refuse(reply, 400, { error: runDays });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    if (typeof q.strategy === 'string' && q.strategy !== '') return refuse(reply, 400, { error: 'A strategy keeps its own methods: the sweep is of the settings. Choose "Settings" rather than a strategy.' });
    if (q.w_split !== undefined && q.w_split !== '' && q.w_split !== 'tf') return refuse(reply, 400, { error: 'w_split is "tf" or absent.' });
    const at = sweepCellOf(q);
    if (typeof at === 'string') return refuse(reply, 400, { error: at });
    const d = winDaysOf(q, runDays);
    if (typeof d === 'string') return refuse(reply, 400, { error: `For the sweep: ${d}` });
    const members = sweepRowsOf(q, params);
    if (!members.some((m) => m.id === at.row)) return refuse(reply, 404, { error: 'No such row in this sweep.' });
    return winSweepTrades({ ...d.run, now: Date.now(), spot: tradingService().spot, pick: d.pick, pcts: [], minTrades: [], members }, at);
  });

  /**
   * The option's stop and strike as set, against a stop and a strike's delta by how volatile it was at each signal's
   * fill (owner, 17 Oct 2026): asked as the backtest itself is, with what is set by level (`volRuleOf`). Both ways of
   * reading the level (ATR, ATM IV), on the same signals. Report only: no strategy, setting or order is touched.
   */
  app.get('/api/signal-backtest/vol-study', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    const rule = volRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : (await backtestStrategies()).find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    return volStudy({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot, ...rule });
  });

  /**
   * The option's SL, the strike's delta and methods by win % by session of the day, against as set (owner, 23 Oct
   * 2026): asked as the backtest itself is, with the sessions (`sessionRuleOf`). Report only: nothing is changed.
   */
  app.get('/api/signal-backtest/session-study', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    const rule = sessionRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : (await backtestStrategies()).find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    return sessionStudy({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot, ...rule });
  });

  /** The session study's trades, one by one: asked as the study is, with `?side=&session=&day=` (`sessionTradesPickOf`). */
  app.get('/api/signal-backtest/session-study/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    const rule = sessionRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    const pick = sessionTradesPickOf(q, r, rule.sessions.length);
    if (typeof pick === 'string') return refuse(reply, 400, { error: pick });
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : (await backtestStrategies()).find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    return sessionStudyTrades({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot, ...rule }, pick);
  });

  /**
   * One expiry day of the volatility study, trade by trade (owner, 17 Oct 2026: "tap the count -- trade by trade"):
   * asked as the study is, with `?day=&side=fixed|by-vol&by=atr|iv`. Each trade carries its level. Read-only.
   */
  app.get('/api/signal-backtest/vol-study/trades', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    const rule = volRuleOf(q);
    if (typeof rule === 'string') return refuse(reply, 400, { error: rule });
    const pick = volTradesPickOf(q, r);
    if (typeof pick === 'string') return refuse(reply, 400, { error: pick });
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const strategy = askedId === null ? null : (await backtestStrategies()).find((s) => s.id === askedId) ?? null;
    if (askedId !== null && !strategy) return refuse(reply, 404, { error: 'No such signal strategy to backtest: it may have been deleted, or it buys rather than sells.' });
    return volStudyTrades({ ...r, now: Date.now(), params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy, spot: tradingService().spot, ...rule }, pick);
  });

  /**
   * The backtest against the live desk, signal for signal (owner, 14 Oct 2026: "the real trades since 9:30 last
   * night and the backtest's do not match in number"): every signal strategy that sells, backtested by its own
   * rules -- an account's strategies together under that account's limit, as the desk holds them -- and laid
   * beside the desk's record of what it did with the same signals. Asked as the single backtest is, so it is the
   * check of what is on the screen: `?strategy=<id>`, that strategy's own rules against its own record; else the
   * screen's settings and filters, as one book, against what the desk did with each signal under any strategy;
   * `?all=1`, every strategy by its own rules. `?from=&to=` are expiry days. Read-only.
   */
  app.get('/api/signal-backtest/live-check', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const r = rangeOf(q);
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    const accounts = await liveAccounts();
    const askedId = typeof q.strategy === 'string' && q.strategy !== '' ? q.strategy : null;
    const base = { ...r, now: Date.now(), spot: tradingService().spot, accounts };
    // By a strategy: its own rules against its own record, worked with its account's other strategies as the desk holds them.
    if (askedId !== null) {
      if (!accounts.some((a) => a.strategies.some((s) => s.id === askedId))) return refuse(reply, 404, { error: 'No such signal strategy to check: it may have been deleted, or it buys rather than sells.' });
      return liveCheck({ ...base, only: [askedId] });
    }
    // Every strategy's own rules: asked for with nothing else.
    if (q.all === '1') return liveCheck(base);
    // The settings on the screen, as the single backtest reads them: one book, against what the desk did under any strategy.
    const params = backtestParamsOf(q);
    if (typeof params === 'string') return refuse(reply, 400, { error: params });
    return liveCheck({
      ...base,
      portfolio: { name: 'these settings', shared: (params.deskMax ?? 0) > 0 ? { deskMax: params.deskMax!, cePct: params.cePct ?? 100, pePct: params.pePct ?? 100, strikePct: params.strikePct ?? 100, strikeFull: params.strikeFull ?? 'next' } : null, members: [{ id: 'screen', name: 'These settings', ask: { params, tfs: listOf(q, 'tf'), methods: listOf(q, 'method'), strategy: null } }] },
    });
  });

  /**
   * Every method's record as options under a strategy's rules as they stand on the form (owner, 13 Oct 2026: "in
   * the strategy form the signal filter's profit and loss must be by the option's TGT and SL, not the perp's --
   * now it is the perp's"). The body is the form's own draft (`{ config }`), saved or not. Each method is tried
   * on every one of its signals in the strategy's way and timeframes -- not only the methods ticked, and with no
   * "at most open", so one method's place is not taken by another's -- sold as the strategy would sell it (its
   * strike rule at each hour, its lots, its hours and no-entry window, its SL / TGT distances) and bought back as
   * it would buy it back: the perp at the signal's stop or its target, or the option at its own target or stop
   * first. The money is the option's, after charges. Read-only; nothing is saved.
   */
  app.post('/api/signal-backtest/methods', async (req, reply) => {
    const body = (req.body ?? {}) as { config?: unknown; from?: unknown; to?: unknown };
    const raw = body.config;
    if (!raw || typeof raw !== 'object') return refuse(reply, 400, { error: 'A strategy\'s settings are needed: { config }.' });
    await methodsSchema();
    const every = (await rows<{ id: string }>('SELECT id FROM entry_methods ORDER BY id')).map((m) => m.id);
    const asked = cleanConfig(raw);
    if (asked.trigger !== 'signal' || !asked.signal) return refuse(reply, 422, { error: 'Only a signal strategy has methods to give a record.', problems: ['Only a signal strategy has methods to give a record.'] });
    if (actionOf(asked.signal) !== 'sell') {
      const why = 'A record as options is worked out for strategies that sell; one that buys is shown on the perp\'s points.';
      return refuse(reply, 422, { error: why, problems: [why] });
    }
    // Every method, whichever are ticked; and (`draft` below) each on all its signals, with no place for one to take from another.
    const config = { ...asked, signal: { ...asked.signal, methods: every } };
    const problems = validateConfig(config);
    if (problems.length) return refuse(reply, 422, { error: problems.join(' '), problems });
    const now = Date.now();
    // `from` and `to` (expiry days) where they are given; else from the report's first day, and no further back
    // than the days the backtest keeps ready.
    let from: string, to: string;
    if (body.from !== undefined || body.to !== undefined) {
      const given = rangeOf({ from: body.from, to: body.to }, now);
      if (typeof given === 'string') return refuse(reply, 400, { error: given });
      ({ from, to } = given);
    } else {
      to = sessionDayOf(now);
      const earliest = new Date(Date.parse(`${to}T00:00:00Z`) - 44 * 86_400_000).toISOString().slice(0, 10);
      from = earliest > REPORT_FIRST_DAY ? earliest : REPORT_FIRST_DAY;
    }
    const draft: Strategy = { id: 'draft', name: 'draft', enabled: false, config, accountId: null, createdAt: now, updatedAt: now };
    const r = await methodRecord(config, { from, to, now, spot: tradingService().spot });
    return { ...r, caveats: strategyCaveats(draft) };
  });

  /**
   * The methods' daily update, now, on the form's draft (owner, 16 Oct 2026): the list it would set by the draft's
   * own win rate, least trades and days, and the run as it would be kept. Nothing is saved -- the form takes the
   * list and saving it is the owner's act; the desk's own run at the day's time saves.
   */
  app.post('/api/strategies/auto-methods/pick', async (req, reply) => {
    const raw = ((req.body ?? {}) as { config?: unknown }).config;
    if (!raw || typeof raw !== 'object') return refuse(reply, 400, { error: 'A strategy\'s settings are needed: { config }.' });
    const asked = cleanConfig(raw);
    if (asked.trigger !== 'signal' || !asked.signal) return refuse(reply, 422, { error: 'Only a signal strategy has methods to pick.', problems: ['Only a signal strategy has methods to pick.'] });
    if (actionOf(asked.signal) !== 'sell') {
      const why = 'The methods are picked by their record as options sold: a strategy that buys has none.';
      return refuse(reply, 422, { error: why, problems: [why] });
    }
    const auto = asked.signal.autoMethods ?? null;
    const autoBad = auto ? autoMethodsProblems(auto) : ['The daily update\'s settings are needed: win rate, least trades and days.'];
    if (autoBad.length) return refuse(reply, 422, { error: autoBad.join(' '), problems: autoBad });
    // An empty list is what this is for: checked with every method, as the record is worked out.
    const problems = validateConfig({ ...asked, signal: { ...asked.signal, methods: METHODS.map((m) => m.id) } });
    if (problems.length) return refuse(reply, 422, { error: problems.join(' '), problems });
    return autoPick(asked, auto!, Date.now(), tradingService().spot);
  });

  /**
   * The draft's daily-update rule walked forward, with an untouched holdout (18 Oct 2026, the R&D audit): each test day
   * traded with what the rule picked from the days before it alone; the last `holdout` days reported apart; every
   * method and the list as it stands beside it (`walkForward`). `{ config, from?, to?, holdout? }`: finished expiry
   * days, at most 30, `to` the last finished one and `from` 13 before it (no earlier than the record allows) where not
   * given; `holdout` 0 to 10, 3 where not given, leaving at least one day to walk. Read-only.
   */
  app.post('/api/strategies/auto-methods/walk-forward', async (req, reply) => {
    const body = (req.body ?? {}) as { config?: unknown; from?: unknown; to?: unknown; holdout?: unknown };
    if (!body.config || typeof body.config !== 'object') return refuse(reply, 400, { error: 'A strategy\'s settings are needed: { config }.' });
    const asked = cleanConfig(body.config);
    if (asked.trigger !== 'signal' || !asked.signal) return refuse(reply, 422, { error: 'Only a signal strategy has methods to pick.', problems: ['Only a signal strategy has methods to pick.'] });
    if (actionOf(asked.signal) !== 'sell') {
      const why = 'The methods are picked by their record as options sold: a strategy that buys has none.';
      return refuse(reply, 422, { error: why, problems: [why] });
    }
    const auto = asked.signal.autoMethods ?? null;
    const autoBad = auto ? autoMethodsProblems(auto) : ['The daily update\'s settings are needed: win rate, least trades and days.'];
    if (autoBad.length) return refuse(reply, 422, { error: autoBad.join(' '), problems: autoBad });
    const problems = validateConfig({ ...asked, signal: { ...asked.signal, methods: METHODS.map((m) => m.id) } });
    if (problems.length) return refuse(reply, 422, { error: problems.join(' '), problems });
    const now = Date.now();
    const last = autoWindow(now, 1).to;
    const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
    const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const to = body.to === undefined || body.to === '' ? last : day(body.to);
    if (!to) return refuse(reply, 400, { error: 'Dates must be YYYY-MM-DD.' });
    if (to > last) return refuse(reply, 400, { error: `The last day is ${last}: the day being traded is not finished.` });
    // The first test day has the rule's whole look-back before it, inside the record.
    const firstTest = plusDays(REPORT_FIRST_DAY, auto!.days);
    const fromAsked = body.from === undefined || body.from === '' ? null : day(body.from);
    if (body.from !== undefined && body.from !== '' && !fromAsked) return refuse(reply, 400, { error: 'Dates must be YYYY-MM-DD.' });
    const from = fromAsked ?? (plusDays(to, -13) > firstTest ? plusDays(to, -13) : firstTest);
    if (from > to) return refuse(reply, 400, { error: `The first test day must not be after the last; with ${auto!.days} days to look back, the first is ${firstTest}.` });
    if (from < firstTest) return refuse(reply, 400, { error: `With ${auto!.days} days to look back, the first test day is ${firstTest}: the record starts ${REPORT_FIRST_DAY}.` });
    const tests = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    if (tests > WALK_MAX_DAYS) return refuse(reply, 400, { error: `At most ${WALK_MAX_DAYS} test days at a time.` });
    const holdout = body.holdout === undefined || body.holdout === '' ? Math.min(3, tests - 1) : Number(body.holdout);
    if (!Number.isInteger(holdout) || holdout < 0 || holdout > WALK_MAX_HOLDOUT) return refuse(reply, 400, { error: `The holdout is a whole number of days from 0 to ${WALK_MAX_HOLDOUT}.`, testDays: tests });
    // How many days can be tested is the record's length less the rule's look-back: said in numbers, with what fits.
    if (holdout >= tests) {
      const why = `Only ${tests} finished day${tests === 1 ? ' has' : 's have'} the rule's whole ${auto!.days}-day look-back inside the record (it starts ${REPORT_FIRST_DAY}), so at most ${tests - 1} can be held out${tests - 1 === 0 ? ' -- none' : ''}. A shorter look-back leaves more days to test.`;
      return refuse(reply, 400, { error: why, testDays: tests, holdoutMax: tests - 1 });
    }
    return walkForwardOf(asked, auto!, { from, to, holdout, now, spot: tradingService().spot, first: REPORT_FIRST_DAY });
  });

  /** Each expiry day with its figures, its kind and both records' totals. `?account=` is one broker account's orders. */
  app.get('/api/market-report', async (req, reply) => {
    const r = rangeOf((req.query ?? {}) as { from?: unknown; to?: unknown });
    if (typeof r === 'string') return refuse(reply, 400, { error: r });
    return marketReport({ ...r, now: Date.now(), spot: tradingService().spot, ...NO_FILTERS, account: accountOf(req.query) });
  });

  /** One expiry day opened (`?day=`): both records by pair, timeframe, method and strategy. */
  app.get('/api/market-report/breakdown', async (req, reply) => {
    const day = (req.query as { day?: unknown } | null)?.day;
    if (typeof day !== 'string' || !DAY.test(day) || Number.isNaN(Date.parse(day))) return refuse(reply, 400, { error: 'Day must be YYYY-MM-DD.' });
    return marketBreakdown({ from: day, to: day, now: Date.now(), spot: tradingService().spot, day, ...NO_FILTERS, account: accountOf(req.query) });
  });
}
