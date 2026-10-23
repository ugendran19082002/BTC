import { Fragment, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSynced } from '@/hooks/useSynced';
import { count, netClass } from '@/components/report/backtest-parts';
import { dayLabel, moneyText } from '@/lib/market-report';
import { pct, stamp } from '@/lib/format';
import { time12 } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { BtSlotRow, TradePick } from '@/types/signal-backtest';

/**
 * The backtest by session of the day (owner, 15 Oct 2026: "by session, 1h by default, 15m to 6h; the methods in each;
 * the count opens its trades"). The server adds every trade into a fifteen-minute slot of the trading day -- slot 0 is
 * 5:30 PM IST, when the daily contract's day begins -- by method; a session here is so many of those together, so any
 * length is the same figures regrouped, with no new question asked. Each session opens to its methods, the best first.
 *
 * Against a baseline (owner, 23 Oct 2026: "comparison -- the net's change per session, the win % change per session,
 * SL % per session"): a run kept as the baseline -- its slots added up, kept by the desk (`useSynced`) so it is there on
 * every screen and after a reload -- and each session of the run on the screen beside it: its net, win % and SL %
 * now, and by how much each moved. Change a setting, run again, and the table says where in the day it helped.
 */

export const SESSION_LENGTHS = [15, 30, 60, 120, 180, 240, 360] as const;
export type SessionMinutes = (typeof SESSION_LENGTHS)[number];
const lengthWords = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);
/** "9:30 PM": the start of a fifteen-minute slot. */
export const slotTime = (slot: number) => {
  const m = (17 * 60 + 30 + slot * 15) % 1_440;
  return time12(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
};
/** "9:30 PM – 10:30 PM" */
export const sessionWords = (from: number, to: number) => `${slotTime(from)} – ${slotTime(to + 1)}`;

type Sum = { n: number; wins: number; net: number; charges: number; stops: number };
const add = (a: Sum, x: Omit<Sum, 'stops'> & { stops?: number }): Sum => ({ n: a.n + x.n, wins: a.wins + x.wins, net: a.net + x.net, charges: a.charges + x.charges, stops: a.stops + (x.stops ?? 0) });
const ZERO: Sum = { n: 0, wins: 0, net: 0, charges: 0, stops: 0 };
const winOf = (x: Pick<Sum, 'n' | 'wins'>) => (x.n ? x.wins / x.n : null);
const slOf = (x: Pick<Sum, 'n' | 'stops'>) => (x.n ? x.stops / x.n : null);

/** A run kept to compare others with: its slots added up over its methods, and what it was of. */
export type SessionBase = { words: string; from: string; to: string; at: number; slots: { slot: number; n: number; wins: number; net: number; stops: number }[] };
/** The run on the screen, kept as the baseline: one line a slot, so it stays small whatever the methods. */
export function baseOf(rows: readonly BtSlotRow[], about: { words: string; from: string; to: string }, at: number): SessionBase {
  const by = new Map<number, SessionBase['slots'][number]>();
  for (const r of rows) {
    const x = by.get(r.slot) ?? { slot: r.slot, n: 0, wins: 0, net: 0, stops: 0 };
    x.n += r.n; x.wins += r.wins; x.net += r.net; x.stops += r.stops ?? 0;
    by.set(r.slot, x);
  }
  return { ...about, at, slots: [...by.values()].sort((a, b) => a.slot - b.slot) };
}
/** The baseline in sessions of the given length, by the first slot of each. */
export function baseSessions(base: SessionBase, minutes: number): Map<number, Sum> {
  const per = Math.max(1, Math.round(minutes / 15)), out = new Map<number, Sum>();
  for (const x of base.slots) {
    const from = Math.floor(x.slot / per) * per;
    out.set(from, add(out.get(from) ?? ZERO, { ...x, charges: 0 }));
  }
  return out;
}
/** A change in percentage points, signed: "+4 pts", "−3 pts", "±0". Null when either side has no trade. */
export const ptsChange = (now: number | null, was: number | null): string | null => {
  if (now === null || was === null) return null;
  const d = Math.round((now - was) * 100);
  return d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d)} pts`;
};

/** The sessions of the given length that traded, in the day's order, each with its methods. */
export function sessionsOf(rows: readonly BtSlotRow[], minutes: number) {
  const per = Math.max(1, Math.round(minutes / 15));
  const by = new Map<number, { from: number; to: number; sum: Sum; methods: Map<string, Sum & { method: string; name: string }> }>();
  for (const r of rows) {
    const i = Math.floor(r.slot / per);
    const s = by.get(i) ?? { from: i * per, to: Math.min(95, i * per + per - 1), sum: ZERO, methods: new Map() };
    s.sum = add(s.sum, r);
    const m = s.methods.get(r.method) ?? { method: r.method, name: r.name, ...ZERO };
    s.methods.set(r.method, { ...m, ...add(m, r) });
    by.set(i, s);
  }
  return [...by.values()].filter((s) => s.sum.n > 0).sort((a, b) => a.from - b.from)
    .map((s) => ({ from: s.from, to: s.to, sum: s.sum, methods: [...s.methods.values()].sort((a, b) => b.net - a.net || b.n - a.n) }));
}

const isBase = (v: unknown): v is SessionBase => {
  const b = v as SessionBase | null;
  return !!b && typeof b.words === 'string' && typeof b.from === 'string' && typeof b.to === 'string' && typeof b.at === 'number' && Array.isArray(b.slots);
};

export function SessionTable({ rows, onOpen, baseKey = 'backtest', about, busy = false }: {
  rows: readonly BtSlotRow[];
  /** Open the trades of a session -- or of one method in it -- one by one. */
  onOpen: (pick: TradePick, title: string) => void;
  /** Whose baseline: the single backtest's or the portfolio's, each kept apart. */
  baseKey?: 'backtest' | 'portfolio';
  /** What the run on the screen is of, said on the baseline once it is kept. Without it, no baseline is offered. */
  about?: { words: string; from: string; to: string };
  /** The run is being worked again for new settings: what is on the screen is not yet of them, so it is not kept. */
  busy?: boolean;
}) {
  const [minutes, setMinutes] = useSynced<number>('backtest.sessionMinutes', 60);
  const len = (SESSION_LENGTHS as readonly number[]).includes(minutes) ? minutes : 60;
  const [open, setOpen] = useState<number | null>(null);
  const [keptBase, setBase] = useSynced<SessionBase | null>(`${baseKey}.sessionBase`, null);
  const base = about && isBase(keptBase) ? keptBase : null;
  // An older server sends no stops: SL % is not said rather than said as none.
  const hasStops = rows.every((r) => r.stops !== undefined);
  const baseBy = base ? baseSessions(base, len) : null;
  const ran = sessionsOf(rows, len);
  // With a baseline, a session it traded in and this run did not is a row too: where the change took every trade away.
  const sessions = !baseBy ? ran : [...ran, ...[...baseBy.keys()].filter((f) => !ran.some((s) => s.from === f)).map((f) => {
    const per = Math.max(1, Math.round(len / 15));
    return { from: f, to: Math.min(95, f + per - 1), sum: ZERO, methods: [] as ReturnType<typeof sessionsOf>[number]['methods'] };
  })].sort((a, b) => a.from - b.from);
  const traded = sessions.filter((x) => x.sum.n > 0);
  const best = traded.reduce<number | null>((m, s) => (m === null || s.sum.net > traded.find((x) => x.from === m)!.sum.net ? s.from : m), null);
  const worst = traded.reduce<number | null>((m, s) => (m === null || s.sum.net < traded.find((x) => x.from === m)!.sum.net ? s.from : m), null);
  const worstLost = worst !== null && sessions.find((x) => x.from === worst)!.sum.net < 0;
  // How far each session's net reaches, against the biggest either way: the bar under its money.
  const most = Math.max(1e-9, ...sessions.map((s) => Math.abs(s.sum.net)));
  // The whole run against the whole baseline, and how many sessions each way.
  const all = ran.reduce((a, x) => add(a, x.sum), ZERO);
  const baseAll = base ? base.slots.reduce((a, x) => add(a, { ...x, charges: 0 }), ZERO) : null;
  const moved = baseBy ? sessions.map((x) => x.sum.net - (baseBy.get(x.from)?.net ?? 0)) : [];
  const better = moved.filter((d) => d > 0.005).length, worse = moved.filter((d) => d < -0.005).length;
  const sameDays = !base || (base.from === about?.from && base.to === about?.to);
  const keep = () => { if (about && !busy) setBase(baseOf(rows, about, Date.now())); };
  /** A small line under a figure: its change against the baseline, coloured by whether that is better. */
  const change = (text: string | null, d: number, label: string) => (text === null ? null : (
    <span aria-label={`${label} ${text} against the baseline`} className={cn('block whitespace-nowrap text-[11px] tabular-nums', Math.abs(d) < 1e-9 ? 'text-muted-foreground' : d > 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}>{text}</span>
  ));
  const countBtn = (n: number, label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} aria-label={label}
      className="m-0 min-h-[32px] appearance-none border-0 bg-transparent p-0 font-[inherit] tabular-nums text-[var(--accent)] underline decoration-dotted underline-offset-4">
      {count(n)} ›
    </button>
  );
  return (
    <div className="grid min-w-0 gap-2">
      <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
        Session length
        <select aria-label="Session length" value={len} onChange={(e) => { setMinutes(Number(e.target.value)); setOpen(null); }}
          className="h-9 rounded-md border border-solid border-border bg-background px-2 font-[inherit] text-[13px] text-foreground">
          {SESSION_LENGTHS.map((m) => <option key={m} value={m}>{lengthWords(m)}</option>)}
        </select>
        <span>IST, from the daily contract&apos;s 5:30 PM · by when the signal filled</span>
      </label>
      {about && (
        <div aria-label="Baseline" className="grid gap-1.5 rounded-md border border-solid border-[var(--line-soft)] px-3 py-2 text-[12.5px]">
          {!base ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-muted-foreground">Keep this run as the baseline, change a setting and run again: each session then shows its change.</span>
              <button type="button" onClick={keep} disabled={busy} className="min-h-[36px] rounded-md border border-solid border-border bg-background px-3 font-[inherit] text-[13px] text-foreground disabled:opacity-50">Keep as baseline</button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="font-semibold">Against the baseline</span>
                  <span className="block text-[12px] text-muted-foreground">{base.words} · {dayLabel(base.from)} → {dayLabel(base.to)} · kept {stamp(base.at)}</span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <button type="button" onClick={keep} disabled={busy} className="min-h-[36px] rounded-md border border-solid border-border bg-background px-3 font-[inherit] text-[13px] text-foreground disabled:opacity-50">Keep this run instead</button>
                  <button type="button" onClick={() => setBase(null)} className="min-h-[36px] rounded-md border border-solid border-border bg-background px-3 font-[inherit] text-[13px] text-foreground">Clear</button>
                </span>
              </div>
              {baseAll && (
                <p aria-label="The whole run against the baseline" className="m-0 tabular-nums leading-snug">
                  Net <span className={cn('font-semibold', netClass(all.net - baseAll.net))}>{moneyText(all.net - baseAll.net)}</span>
                  {' '}({moneyText(baseAll.net)} → {moneyText(all.net)})
                  {' · '}Won {pct(winOf(baseAll), 0)} → {pct(winOf(all), 0)}
                  {hasStops && <>{' · '}SL {pct(slOf(baseAll), 0)} → {pct(slOf(all), 0)}</>}
                  {' · '}{better === 0 && worse === 0 ? 'the same in every session' : `better in ${better} session${better === 1 ? '' : 's'}, worse in ${worse}`}
                </p>
              )}
              {!sameDays && <p role="status" className="m-0 rounded-md bg-[var(--chosen-soft)] px-2 py-1 text-[12px]">The baseline is of other days: the change is partly the days, not only the settings.</p>}
            </>
          )}
        </div>
      )}
      {sessions.length === 0 ? <p className="m-0 py-2 text-[13px] text-muted-foreground">No trade in any session.</p> : (
        <table className="w-full table-fixed border-collapse text-[13px]">
          <caption className="sr-only">Backtest by session of the day</caption>
          {/* Narrow figures on a phone, wider from a tablet up; every cell wraps rather than running into the next. */}
          <colgroup><col /><col className="w-[3rem] sm:w-[4.75rem]" /><col className="w-[3rem] sm:w-[3.75rem]" />{hasStops && <col className="w-[3rem] sm:w-[3.75rem]" />}<col className="w-[5.25rem] sm:w-[6.75rem]" /></colgroup>
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.4px] text-muted-foreground">
              <th scope="col" className="whitespace-normal py-1 text-left font-medium">Session</th>
              <th scope="col" className="whitespace-normal py-1 text-right font-medium">Trades</th>
              <th scope="col" className="whitespace-normal py-1 text-right font-medium">Won</th>
              {hasStops && <th scope="col" className="whitespace-normal py-1 text-right font-medium"><abbr title="Bought back at a stop loss" className="no-underline">SL</abbr></th>}
              <th scope="col" className="whitespace-normal py-1 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const words = sessionWords(s.from, s.to), isOpen = open === s.from;
              const was = baseBy ? (baseBy.get(s.from) ?? ZERO) : null;
              return (
                <Fragment key={s.from}>
                  <tr className={cn('border-0 border-t border-solid border-[var(--line-soft)]', isOpen && '[&>*]:bg-[var(--chosen-soft)]')}>
                    <th scope="row" className="whitespace-normal py-1.5 pr-2 text-left font-normal normal-case tracking-normal">
                      <button type="button" aria-expanded={isOpen} aria-label={`${words}: its methods`} onClick={() => setOpen(isOpen ? null : s.from)}
                        className="m-0 flex min-h-[36px] w-full appearance-none items-center gap-1 border-0 bg-transparent p-0 text-left font-[inherit] text-[13px] text-foreground">
                        <ChevronDown aria-hidden className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                        <span className="min-w-0">
                          <span className="block tabular-nums leading-snug">{slotTime(s.from)} –<wbr /> {slotTime(s.to + 1)}</span>
                          {(s.from === best || s.from === worst) && sessions.length > 2 && (
                            <span className={cn('block text-[11px]', s.from === best ? 'text-[var(--up)]' : worstLost ? 'text-[var(--down)]' : 'text-muted-foreground')}>
                              {s.from === best ? 'best session' : worstLost ? 'worst session' : 'lowest session'}
                            </span>
                          )}
                        </span>
                      </button>
                    </th>
                    <td className="whitespace-normal py-1.5 text-right">
                      {s.sum.n > 0 ? countBtn(s.sum.n, `See the ${count(s.sum.n)} trades of ${words}`, () => onOpen({ slotFrom: s.from, slotTo: s.to }, `${words} · every day`)) : <span className="tabular-nums text-muted-foreground">0</span>}
                      {was && was.n !== s.sum.n && <span aria-label={`Trades ${s.sum.n - was.n > 0 ? '+' : '−'}${Math.abs(s.sum.n - was.n)} against the baseline`} className="block text-[11px] tabular-nums text-muted-foreground">{s.sum.n - was.n > 0 ? '+' : '−'}{count(Math.abs(s.sum.n - was.n))}</span>}
                    </td>
                    <td className="whitespace-normal py-1.5 text-right tabular-nums">
                      {pct(winOf(s.sum), 0)}
                      {was && change(ptsChange(winOf(s.sum), winOf(was)), (winOf(s.sum) ?? 0) - (winOf(was) ?? 0), 'Won')}
                    </td>
                    {hasStops && (
                      <td className="whitespace-normal py-1.5 text-right tabular-nums">
                        {pct(slOf(s.sum), 0)}
                        {/* Fewer stop losses is the better way. */}
                        {was && change(ptsChange(slOf(s.sum), slOf(was)), (slOf(was) ?? 0) - (slOf(s.sum) ?? 0), 'SL')}
                      </td>
                    )}
                    <td className="whitespace-normal py-1.5 text-right">
                      <span className={cn('block font-semibold tabular-nums', netClass(s.sum.net))}>{s.sum.n > 0 ? moneyText(s.sum.net) : '—'}</span>
                      {was ? change(moneyText(s.sum.net - was.net), s.sum.net - was.net, 'Net')
                        : <span className={cn('block text-[11px] tabular-nums', netClass(s.sum.net))}>{moneyText(s.sum.net / s.sum.n)} each</span>}
                      {s.sum.n > 0 && <span aria-hidden className="mt-1 ml-auto block h-1 rounded-full" style={{ width: `${Math.max(4, (100 * Math.abs(s.sum.net)) / most)}%`, background: s.sum.net >= 0 ? 'var(--up)' : 'var(--down)', opacity: 0.7 }} />}
                    </td>
                  </tr>
                  {isOpen && s.methods.map((m) => (
                    <tr key={m.method} className="text-[12.5px]">
                      <th scope="row" className="whitespace-normal py-1 pl-5 pr-2 text-left text-[12.5px] font-normal normal-case leading-snug tracking-normal text-muted-foreground [overflow-wrap:anywhere]">{m.name}</th>
                      <td className="whitespace-normal py-1 text-right align-top">{countBtn(m.n, `See the ${count(m.n)} trades of ${m.name} in ${words}`, () => onOpen({ slotFrom: s.from, slotTo: s.to, method: m.method }, `${m.name} · ${words}`))}</td>
                      <td className="whitespace-normal py-1 text-right align-top tabular-nums">{pct(winOf(m), 0)}</td>
                      {hasStops && <td className="whitespace-normal py-1 text-right align-top tabular-nums">{pct(slOf(m), 0)}</td>}
                      <td className={cn('whitespace-normal py-1 text-right align-top font-medium tabular-nums', netClass(m.net))}>{moneyText(m.net)}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="m-0 text-[12px] text-muted-foreground">
        Tap a session for its methods, the best first; tap a count for its trades, one by one, over every day.
        {hasStops && ' SL: of the trades, those bought back at a stop loss (the perp\'s or the option\'s; not a trailing SL or break-even).'}
        {base && ' Under each figure, its change against the baseline: green is better (for SL, fewer).'}
      </p>
    </div>
  );
}
