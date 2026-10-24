import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { useSynced } from '@/hooks/useSynced';
import { pct } from '@/lib/format';
import { dayLabel, moneyText } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import { RANGE_KEYS, SESSIONS_MAX, SESSION_DRAFTS, nextSession, ruleWords, sessionAskOf, sessionDraftProblem, sessionSpanWords, splitDay, type SessionDraft, type SessionDrafts } from '@/lib/session-study';
import type { BtDayTrades, SessionAsk, SessionStudyResult, SessionTradesPick } from '@/types/signal-backtest';
import { DayTradesSheet } from '@/components/report/DayTrades';
import { Empty, Panel } from '@/components/mobile/parts';
import { TimePicker } from '@/components/ui/time-picker';
import { count, netClass } from '@/components/report/backtest-parts';

/**
 * The option's SL, the strike's delta and methods by win % by session of the day, as research (owner, 23 Oct 2026:
 * "session based -- delta, SL %, win % -- make them editable; I will check it by session"). The volatility study's
 * question with the session a signal filled in for its level: the settings above -- or a run's saved backtests --
 * traded twice on the same signals, as set and with each session's own figures, and laid side by side session by
 * session: trades, won, SL % and net, with what changed. A blank figure, and a signal in no session, keep it as set.
 *
 * The sessions are kept by the desk (`useSynced`), so they are there on every screen and after a reload. Asked for with
 * a tap: it is two backtests' work, and a record for win %.
 */

type Field = 'delta' | 'sl' | 'win';
// The unit is in the label: three fields abreast on a phone have no room for one inside.
const FIELDS: { key: Field; label: string; min: number; max: number; step: number; aria: (n: number) => string }[] = [
  { key: 'delta', label: 'Delta ≤', min: 0.02, max: 0.5, step: 0.01, aria: (n) => `Session ${n}: the most delta a strike sold may have` },
  { key: 'sl', label: 'SL +%', min: 10, max: 1_000, step: 10, aria: (n) => `Session ${n}: option SL, per cent over the premium` },
  { key: 'win', label: 'Won ≥ %', min: 1, max: 100, step: 1, aria: (n) => `Session ${n}: the least win per cent of its method` },
];
// The SL and TGT range, as the run's own: BTC points from the perp entry to the signal's SL and target.
const RANGE_FIELDS: { key: (typeof RANGE_KEYS)[number]; label: string; aria: (n: number) => string }[] = [
  { key: 'slMin', label: 'SL ≥ pts', aria: (n) => `Session ${n}: the least points to the signal's SL` },
  { key: 'slMax', label: 'SL ≤ pts', aria: (n) => `Session ${n}: the most points to the signal's SL` },
  { key: 'tgtMin', label: 'TGT ≥ pts', aria: (n) => `Session ${n}: the least points to the signal's TGT` },
  { key: 'tgtMax', label: 'TGT ≤ pts', aria: (n) => `Session ${n}: the most points to the signal's TGT` },
];
const SPLITS = [3, 4, 6];
const input = 'h-11 w-full min-w-0 rounded-md border border-solid border-border bg-[var(--bg)] text-[16px] tabular-nums text-foreground placeholder:text-[13px] placeholder:text-muted-foreground';
const chip = 'm-0 h-9 appearance-none rounded-full border border-solid border-border bg-transparent px-3 font-[inherit] text-[12.5px] text-muted-foreground';

/** Anything kept by an older build, or by hand, filled in from the defaults rather than read as broken. */
function draftsOf(x: SessionDrafts | null | undefined): SessionDrafts {
  const ok = (s: unknown): s is SessionDraft => !!s && typeof (s as SessionDraft).from === 'string' && typeof (s as SessionDraft).to === 'string';
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    sessions: Array.isArray(x?.sessions) ? x.sessions.filter(ok).map((s) => ({ from: s.from, to: s.to, delta: str(s.delta), sl: str(s.sl), win: str(s.win), slMin: str(s.slMin), slMax: str(s.slMax), tgtMin: str(s.tgtMin), tgtMax: str(s.tgtMax) })) : SESSION_DRAFTS.sessions,
    win: { ...SESSION_DRAFTS.win, ...(x?.win ?? {}) },
  };
}

const winOf = (x: { n: number; wins: number }) => (x.n ? x.wins / x.n : null);
const slOf = (x: { n: number; stops: number }) => (x.n ? x.stops / x.n : null);
/** "+9" / "−3" / "±0" in points: a narrow column has no room for the unit. Null with no trade on either side. */
const ptsMove = (now: number | null, was: number | null) => {
  if (now === null || was === null) return null;
  const d = Math.round((now - was) * 100);
  return d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
};
/** A small line under a figure, coloured by whether it is better. */
function Move({ text, good, label }: { text: string | null; good: number; label: string }) {
  if (text === null) return null;
  return <span aria-label={label} className={cn('block whitespace-nowrap text-[11px] tabular-nums', Math.abs(good) < 1e-9 ? 'text-muted-foreground' : good > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{text}</span>;
}

/** Each session as set beside by session: trades, won, SL % and net, each with its change; a count opens its trades. */
function Sessions({ r, open }: { r: SessionStudyResult; open?: (pick: SessionTradesPick, title: string) => void }) {
  const [a, b] = r.lines;
  const rows = [...r.sessions.map((s, i) => ({ i, words: sessionSpanWords(s), rule: ruleWords(s) })), { i: -1, words: 'In no session', rule: 'as set' }]
    .map((x) => ({ ...x, was: a.bySession.find((y) => y.session === x.i)!, now: b.bySession.find((y) => y.session === x.i)! }))
    .filter((x) => x.was.n > 0 || x.now.n > 0);
  const btn = (n: number, label: string, pick: SessionTradesPick, title: string, small = false) => (open && n > 0 ? (
    <button type="button" aria-label={label} onClick={() => open(pick, title)}
      className={cn('m-0 min-h-[32px] appearance-none border-0 bg-transparent p-0 font-[inherit] tabular-nums text-[var(--accent)] underline decoration-dotted underline-offset-4', small && 'min-h-[28px] text-[11px]')}>
      {count(n)} ›
    </button>
  ) : <span className={cn('tabular-nums', small ? 'text-[11px] text-muted-foreground' : n === 0 && 'text-muted-foreground')}>{count(n)}</span>);
  if (rows.length === 0) return <Empty>No trade in these days on either side.</Empty>;
  return (
    <table className="w-full table-fixed border-collapse text-[13px]">
      <caption className="sr-only">Each session: as set against by session</caption>
      <colgroup><col /><col className="w-[3.25rem] sm:w-[5rem]" /><col className="w-[3rem] sm:w-[3.75rem]" /><col className="w-[3rem] sm:w-[3.75rem]" /><col className="w-[5.25rem] sm:w-[6.75rem]" /></colgroup>
      <thead>
        <tr className="text-[11px] uppercase tracking-[0.4px] text-muted-foreground">
          <th scope="col" className="py-1 text-left font-medium">Session</th>
          <th scope="col" className="py-1 text-right font-medium">Trades</th>
          <th scope="col" className="py-1 text-right font-medium">Won</th>
          <th scope="col" className="py-1 text-right font-medium"><abbr title="Bought back at a stop loss" className="no-underline">SL</abbr></th>
          <th scope="col" className="py-1 text-right font-medium">Net</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ i, words, rule, was, now }) => (
          <tr key={i} className="border-0 border-t border-solid border-[var(--line-soft)] align-top">
            <th scope="row" className="static whitespace-normal bg-transparent py-1.5 pr-2 text-left text-[13px] font-normal normal-case tracking-normal text-foreground">
              <span className="block tabular-nums leading-snug">{words}</span>
              <span className="block text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{rule}</span>
            </th>
            <td className="py-1.5 text-right">
              {btn(now.n, `By session: the ${count(now.n)} trades of ${words}`, { side: 'by-session', session: i, day: null }, `${words} · by session`)}
              <span className="block whitespace-nowrap text-[11px] text-muted-foreground">
                was {btn(was.n, `As set: the ${count(was.n)} trades of ${words}`, { side: 'fixed', session: i, day: null }, `${words} · as set`, true)}
              </span>
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {pct(winOf(now), 0)}
              <Move text={ptsMove(winOf(now), winOf(was))} good={(winOf(now) ?? 0) - (winOf(was) ?? 0)} label={`${words}: won ${ptsMove(winOf(now), winOf(was))} points against as set`} />
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {pct(slOf(now), 0)}
              {/* Fewer stop losses is the better way. */}
              <Move text={ptsMove(slOf(now), slOf(was))} good={(slOf(was) ?? 0) - (slOf(now) ?? 0)} label={`${words}: SL ${ptsMove(slOf(now), slOf(was))} points against as set`} />
            </td>
            <td className="py-1.5 text-right">
              <span className={cn('block font-semibold tabular-nums', netClass(now.net))}>{now.n ? moneyText(now.net) : '—'}</span>
              <Move text={moneyText(now.net - was.net)} good={now.net - was.net} label={`${words}: net ${moneyText(now.net - was.net)} against as set`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The whole of both sides, figure by figure, the better of each marked. */
function Whole({ r }: { r: SessionStudyResult }) {
  const [a, b] = r.lines;
  type Metric = { label: string; a: number | null; b: number | null; show: (v: number | null) => string; better: 'more' | 'less' | null; money?: boolean };
  const money = (v: number | null) => moneyText(v ?? 0);
  const metrics: Metric[] = [
    { label: 'Trades', a: a.n, b: b.n, show: (v) => count(v ?? 0), better: null },
    { label: 'Net', a: a.net, b: b.net, show: money, better: 'more', money: true },
    { label: 'Won', a: winOf(a), b: winOf(b), show: (v) => pct(v, 0), better: 'more' },
    { label: 'SL hit', a: slOf(a), b: slOf(b), show: (v) => pct(v, 0), better: 'less' },
    { label: 'Worst day', a: a.worstDay?.net ?? 0, b: b.worstDay?.net ?? 0, show: money, better: 'more', money: true },
    { label: 'Max drawdown', a: -a.maxDrawdown, b: -b.maxDrawdown, show: money, better: 'more', money: true },
    { label: `1st half${r.secondHalfFrom ? ` · to ${dayLabel(r.secondHalfFrom)}` : ''}`, a: a.halves[0], b: b.halves[0], show: money, better: 'more', money: true },
    { label: `2nd half${r.secondHalfFrom ? ` · from ${dayLabel(r.secondHalfFrom)}` : ''}`, a: a.halves[1], b: b.halves[1], show: money, better: 'more', money: true },
  ];
  const wins = (m: Metric) => (m.better === null || m.a === null || m.b === null || Math.abs(m.a - m.b) < 0.0005 ? null : (m.better === 'more') === (m.b > m.a) ? 'b' : 'a');
  return (
    <table className="w-full border-collapse text-[13px] tabular-nums">
      <caption className="sr-only">The whole: as set against by session</caption>
      <thead>
        <tr className="text-left text-[11.5px] text-muted-foreground">
          <th scope="col" className="py-1 pr-2 font-medium"><span className="sr-only">Figure</span></th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">As set</th>
          <th scope="col" className="py-1 text-right font-medium">By session</th>
        </tr>
      </thead>
      <tbody>
        {metrics.map((m) => {
          const w = wins(m);
          const cell = (v: number | null, me: 'a' | 'b') => (
            <td className={cn('py-1.5 text-right', me === 'a' && 'pr-2', m.money && netClass(v ?? 0), w === me && 'font-semibold')}>
              {m.show(v)}{w === me && <span className="sr-only"> (better)</span>}{w === me && <span aria-hidden className="ml-1 text-[11px] text-[var(--up)]">▲</span>}
            </td>
          );
          return (
            <tr key={m.label} className="border-0 border-t border-solid border-[var(--line-soft)]">
              <th scope="row" className="static whitespace-normal bg-transparent py-1.5 pr-2 text-left text-[13px] font-normal normal-case tracking-normal text-muted-foreground">{m.label}</th>
              {cell(m.a, 'a')}{cell(m.b, 'b')}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One session's times, its three figures and its SL and TGT range, each blank for as set. */
function SessionFields({ n, s, onChange, onRemove, onEnter }: { n: number; s: SessionDraft; onChange: (s: SessionDraft) => void; onRemove: () => void; onEnter: () => void }) {
  return (
    <li className="grid min-w-0 gap-2 rounded-md border border-solid border-[var(--line-soft)] p-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 text-[13px] font-semibold">Session {n} <span className="font-normal text-muted-foreground">· {sessionSpanWords(s)}</span></span>
        <button type="button" onClick={onRemove} aria-label={`Remove session ${n}`}
          className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground"><X aria-hidden className="h-4 w-4" /></button>
      </div>
      {/* One under the other on a phone, where two pickers abreast clip their times; side by side from a tablet. */}
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <span className="flex min-w-0 items-center gap-2"><span className="w-10 flex-none text-[12.5px] font-medium">From</span><TimePicker label={`Session ${n}: from`} value={s.from} className="min-w-0 flex-1" onChange={(from) => onChange({ ...s, from })} /></span>
        <span className="flex min-w-0 items-center gap-2"><span className="w-10 flex-none text-[12.5px] font-medium">To</span><TimePicker label={`Session ${n}: to`} value={s.to} className="min-w-0 flex-1" onChange={(to) => onChange({ ...s, to })} /></span>
      </div>
      <div className="grid grid-cols-3 gap-2 max-[340px]:grid-cols-1">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex min-w-0 flex-col gap-1">
            <span className="text-[12.5px] font-medium">{f.label}</span>
            <input type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} aria-label={f.aria(n)} placeholder="as set"
              value={s[f.key]} onChange={(e) => onChange({ ...s, [f.key]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }}
              className={cn(input, 'px-2.5')} />
          </label>
        ))}
      </div>
      <fieldset className="m-0 grid min-w-0 gap-1 border-0 p-0">
        <legend className="p-0 text-[12px] text-muted-foreground">SL and TGT range · BTC pts from the perp entry · 0 off</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {RANGE_FIELDS.map((f) => (
            <label key={f.key} className="flex min-w-0 flex-col gap-1">
              <span className="text-[12.5px] font-medium">{f.label}</span>
              <input type="number" inputMode="numeric" min={0} max={20_000} step={10} aria-label={f.aria(n)} placeholder="as set"
                value={s[f.key]} onChange={(e) => onChange({ ...s, [f.key]: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') onEnter(); }}
                className={cn(input, 'px-2.5')} />
            </label>
          ))}
        </div>
      </fieldset>
    </li>
  );
}

export function SessionStudy({ askKey, read, readTrades, wide = false, title = 'By session · SL, delta, win % · research' }: {
  /** What the result is of -- the backtest's or the run's own question -- so a comparison of other settings is said to be. */
  askKey: string;
  read: (a: SessionAsk) => Promise<SessionStudyResult>;
  /** The trades of one side, a session or all, asked with the sessions the comparison was worked with. */
  readTrades?: (a: SessionAsk, pick: SessionTradesPick) => Promise<BtDayTrades>;
  wide?: boolean; title?: string;
}) {
  const [stored, setStored] = useSynced<SessionDrafts>('signalBacktest.sessionStudy.rules', SESSION_DRAFTS);
  const drafts = draftsOf(stored);
  const [run, setRun] = useState<{ key: string; ask: SessionAsk; data: SessionStudyResult | null; error: Error | null; busy: boolean } | null>(null);
  const [trades, setTrades] = useState<{ pick: SessionTradesPick; title: string } | null>(null);
  const problem = sessionDraftProblem(drafts);
  const ask = sessionAskOf(drafts);
  const keyOf = (a: SessionAsk) => JSON.stringify({ askKey, a });
  const stale = run !== null && run.data !== null && !run.busy && run.key !== keyOf(ask);
  const go = () => {
    if (problem) return;
    const key = keyOf(ask);
    setRun((x) => ({ key, ask, data: x?.data ?? null, error: null, busy: true }));
    read(ask).then(
      (data) => setRun((x) => (x?.key === key ? { key, ask, data, error: null, busy: false } : x)),
      (error: Error) => setRun((x) => (x?.key === key ? { key, ask, data: x.data, error, busy: false } : x)),
    );
  };
  const set = (sessions: SessionDraft[]) => setStored({ ...drafts, sessions });
  const next = nextSession(drafts);
  const isDefault = JSON.stringify(drafts) === JSON.stringify(SESSION_DRAFTS);
  const r = run?.data ?? null;
  const asked = run?.ask ?? null;
  const diff = r ? r.lines[1].net - r.lines[0].net : 0;
  const halves = r ? [r.lines[1].halves[0] > r.lines[0].halves[0], r.lines[1].halves[1] > r.lines[0].halves[1]] : [false, false];
  const winField = (key: 'base' | 'minTrades' | 'days', label: string, unit: string, aria: string, placeholder?: string) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[12.5px] font-medium">{label}</span>
      <span className="relative min-w-0">
        <input type="number" inputMode="numeric" aria-label={aria} placeholder={placeholder} value={drafts.win[key]}
          onChange={(e) => setStored({ ...drafts, win: { ...drafts.win, [key]: e.target.value } })} onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          className={cn(input, 'pl-3', unit.length > 1 ? 'pr-12' : 'pr-7')} />
        <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted-foreground">{unit}</span>
      </span>
    </label>
  );
  return (
    <Panel title={title}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
        <p className="m-0 text-[13px] leading-snug text-muted-foreground">
          The same signals, twice: as set above, and with each session&apos;s own delta, SL, win % and SL / TGT range -- by the time each signal filled (IST, from the
          daily contract&apos;s 5:30 PM). A blank figure, and a signal in no session, keep the settings. <b className="font-medium text-foreground">Research only: no strategy, setting or order changes.</b>
        </p>
        <fieldset className="m-0 grid min-w-0 gap-2 rounded-md border border-solid border-[var(--line-soft)] px-3 py-2">
          <legend className="px-1 text-[13px] font-semibold">Sessions</legend>
          {drafts.sessions.length === 0 ? <p className="m-0 text-[13px] text-muted-foreground">No session yet: add one, or split the day.</p> : (
            <ol className="m-0 grid list-none gap-2 p-0">
              {drafts.sessions.map((s, i) => (
                <SessionFields key={i} n={i + 1} s={s} onEnter={go}
                  onChange={(x) => set(drafts.sessions.map((y, j) => (j === i ? x : y)))}
                  onRemove={() => set(drafts.sessions.filter((_, j) => j !== i))} />
              ))}
            </ol>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button type="button" disabled={!next || drafts.sessions.length >= SESSIONS_MAX} onClick={() => { if (next) set([...drafts.sessions, next]); }}
              className="inline-flex h-10 items-center gap-1.5 rounded-md border border-solid border-border bg-transparent px-3 font-[inherit] text-[13px] text-foreground disabled:opacity-40">
              <Plus aria-hidden className="h-4 w-4" /> Add a session
            </button>
            <span role="group" aria-label="Split the whole day" className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-muted-foreground">Whole day in</span>
              {SPLITS.map((h) => <button key={h} type="button" onClick={() => set(splitDay(h))} aria-label={`Split the whole day into ${h}-hour sessions`} className={chip}>{h}h</button>)}
            </span>
          </div>
        </fieldset>
        <fieldset className="m-0 grid min-w-0 gap-2 rounded-md border border-solid border-[var(--line-soft)] px-3 py-2">
          <legend className="px-1 text-[13px] font-semibold">Methods by win %</legend>
          <p className="m-0 text-[12px] leading-snug text-muted-foreground">A session&apos;s Won ≥ takes a signal only if its method won that much over the days before its day. As set: the bar for every signal on both sides, or blank for none.</p>
          <div className="grid grid-cols-3 gap-2 max-[340px]:grid-cols-1">
            {winField('base', 'Win % as set', '%', 'Win per cent as set, blank for none', 'none')}
            {winField('minTrades', 'Least trades', 'trades', 'Least trades')}
            {winField('days', 'Days read', 'days', 'Days before each day read')}
          </div>
        </fieldset>
        <p role={problem ? 'alert' : 'status'} className={cn('m-0 text-[12.5px] leading-snug', problem ? 'text-[var(--down)]' : 'text-muted-foreground')}>
          {problem ?? `${ask.sessions.map((s) => `${sessionSpanWords(s)} ${ruleWords({ ...s, sl: s.sl === null ? null : s.sl / 100 })}`).join('; ')}. A trade keeps its session's figures to its exit.`}
        </p>
        <div className={cn('grid gap-2', wide ? 'grid-cols-[auto_auto] justify-start' : 'grid-cols-[minmax(0,1fr)_auto]')}>
          <button type="button" onClick={go} disabled={problem !== null || run?.busy === true}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border-0 bg-[var(--chosen)] px-4 font-[inherit] text-[14px] font-semibold text-[var(--chosen-ink)] disabled:opacity-40">
            {run?.busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
            {run?.busy ? 'Comparing…' : r ? 'Compare again' : 'Compare'}
          </button>
          {!isDefault && (
            <button type="button" onClick={() => setStored(SESSION_DRAFTS)} className="h-11 rounded-lg border border-solid border-border bg-transparent px-3 font-[inherit] text-[13.5px] text-foreground">Back to the defaults</button>
          )}
        </div>
        {run?.error && <p role="alert" className="m-0 text-[13px] text-[var(--down)]">Could not compare: {run.error.message}</p>}
        {run?.busy && !r && <p role="status" className="m-0 text-[13px] text-muted-foreground">Working out the same signals both ways… a minute on a long range.</p>}
        {stale && <p role="status" className="m-0 rounded-md bg-[var(--chosen-soft)] px-3 py-2 text-[13px]">The settings or the sessions changed since: below is the last comparison. Tap Compare again for these.</p>}
        {r && (
          <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 transition-opacity', (stale || run?.busy) && 'opacity-50')} aria-busy={run?.busy}>
            {r.members && (
              <p className="m-0 text-[12.5px] leading-snug text-muted-foreground">
                Over {count(r.members.filter((m) => !m.problem).length)} saved backtest{r.members.filter((m) => !m.problem).length === 1 ? '' : 's'}, each on its own signals and settings, added up.
                {r.members.filter((m) => m.problem).map((m) => ` ${m.name}: ${m.problem}`).join('')}
              </p>
            )}
            {r.signals === 0 || (r.lines[0].n === 0 && r.lines[1].n === 0) ? <Empty>No trade in these days to compare.</Empty> : (
              <>
                <p role="status" className={cn('m-0 rounded-md px-3 py-2 text-[13.5px] leading-snug', diff > 0 && halves[0] && halves[1] ? 'bg-[color-mix(in_srgb,_var(--up)_14%,_transparent)]' : 'bg-[var(--chosen-soft)]')}>
                  By session made <b className={netClass(diff)}>{moneyText(diff)}</b> {diff >= 0 ? 'more' : 'less'} than as set,{' '}
                  {halves[0] && halves[1] ? 'and was better in both halves of the days.' : !halves[0] && !halves[1] ? 'and was not better in either half.' : 'but better in one half only -- not a rule yet.'}
                </p>
                <section aria-label="Each session" className="grid min-w-0 gap-1">
                  <h3 className="m-0 text-[13px] font-semibold">Each session <span className="font-normal text-muted-foreground">· by session, and its change against as set</span></h3>
                  <Sessions r={r} open={readTrades && asked ? (pick, t) => setTrades({ pick, title: t }) : undefined} />
                  <p className="m-0 text-[12px] leading-snug text-muted-foreground">
                    Under each figure, its change against as set -- won and SL in percentage points; green is better, for SL fewer. SL: bought back at a stop loss, the perp&apos;s or the option&apos;s.
                    {readTrades && ' Tap a count for its trades, one by one, over every day.'}
                  </p>
                </section>
                <section aria-label="The whole" className="grid min-w-0 gap-1">
                  <h3 className="m-0 text-[13px] font-semibold">The whole</h3>
                  <Whole r={r} />
                </section>
              </>
            )}
            <p className="m-0 text-[12px] leading-snug text-muted-foreground">
              {dayLabel(r.from)} → {dayLabel(r.to)}, {count(r.days)} expiry day{r.days === 1 ? '' : 's'}, {count(r.signals)} signals. Every signal is traded with no limit on what is open, so both sides are the same signals.
              {(r.win.base !== null || r.sessions.some((s) => s.win !== null)) && ` Win % reads each method's record over the ${r.win.days} days before each day, on ${r.win.minTrades}+ trades -- never the day's own -- so the first days may trade nothing.`}
              {!r.sameTrades && ' A session\'s delta or win % left some signals out: those are traded on one side only (Trades).'}
              {r.days < 20 ? ` ${count(r.days)} expiry day${r.days === 1 ? ' is' : 's are'} a short sample: a difference here can be luck.` : ' Trust a difference only where both halves agree.'}
              {' '}A rule goes to paper first, never straight to live.
            </p>
          </div>
        )}
      </div>
      {readTrades && asked && (
        <DayTradesSheet day={trades ? `session-study:${trades.pick.side}:${trades.pick.session}` : null} title={trades?.title}
          read={() => readTrades(asked, trades!.pick)} onClose={() => setTrades(null)} />
      )}
    </Panel>
  );
}
