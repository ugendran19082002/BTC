import { Fragment, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useSynced } from '@/hooks/useSynced';
import { count, netClass } from '@/components/report/backtest-parts';
import { moneyText } from '@/lib/market-report';
import { pct } from '@/lib/format';
import { time12 } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { BtSlotRow, TradePick } from '@/types/signal-backtest';

/**
 * The backtest by session of the day (owner, 15 Oct 2026: "by session, 1h by default, 15m to 6h; the methods in each;
 * the count opens its trades"). The server adds every trade into a fifteen-minute slot of the trading day -- slot 0 is
 * 5:30 PM IST, when the daily contract's day begins -- by method; a session here is so many of those together, so any
 * length is the same figures regrouped, with no new question asked. Each session opens to its methods, the best first.
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

type Sum = { n: number; wins: number; net: number; charges: number };
const add = (a: Sum, x: Sum): Sum => ({ n: a.n + x.n, wins: a.wins + x.wins, net: a.net + x.net, charges: a.charges + x.charges });
const ZERO: Sum = { n: 0, wins: 0, net: 0, charges: 0 };

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

export function SessionTable({ rows, onOpen }: {
  rows: readonly BtSlotRow[];
  /** Open the trades of a session -- or of one method in it -- one by one. */
  onOpen: (pick: TradePick, title: string) => void;
}) {
  const [minutes, setMinutes] = useSynced<number>('backtest.sessionMinutes', 60);
  const len = (SESSION_LENGTHS as readonly number[]).includes(minutes) ? minutes : 60;
  const [open, setOpen] = useState<number | null>(null);
  const sessions = sessionsOf(rows, len);
  const best = sessions.reduce<number | null>((m, s) => (m === null || s.sum.net > sessions.find((x) => x.from === m)!.sum.net ? s.from : m), null);
  const worst = sessions.reduce<number | null>((m, s) => (m === null || s.sum.net < sessions.find((x) => x.from === m)!.sum.net ? s.from : m), null);
  const worstLost = worst !== null && sessions.find((x) => x.from === worst)!.sum.net < 0;
  // How far each session's net reaches, against the biggest either way: the bar under its money.
  const most = Math.max(1e-9, ...sessions.map((s) => Math.abs(s.sum.net)));
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
      {sessions.length === 0 ? <p className="m-0 py-2 text-[13px] text-muted-foreground">No trade in any session.</p> : (
        <table className="w-full table-fixed border-collapse text-[13px]">
          <caption className="sr-only">Backtest by session of the day</caption>
          {/* Narrow figures on a phone, wider from a tablet up; every cell wraps rather than running into the next. */}
          <colgroup><col /><col className="w-[3.25rem] sm:w-[4.75rem]" /><col className="w-[2.75rem] sm:w-[3.5rem]" /><col className="w-[5.5rem] sm:w-[6.75rem]" /></colgroup>
          <thead>
            <tr className="text-[11px] uppercase tracking-[0.4px] text-muted-foreground">
              <th scope="col" className="whitespace-normal py-1 text-left font-medium">Session</th>
              <th scope="col" className="whitespace-normal py-1 text-right font-medium">Trades</th>
              <th scope="col" className="whitespace-normal py-1 text-right font-medium">Won</th>
              <th scope="col" className="whitespace-normal py-1 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const words = sessionWords(s.from, s.to), isOpen = open === s.from;
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
                    <td className="whitespace-normal py-1.5 text-right">{countBtn(s.sum.n, `See the ${count(s.sum.n)} trades of ${words}`, () => onOpen({ slotFrom: s.from, slotTo: s.to }, `${words} · every day`))}</td>
                    <td className="whitespace-normal py-1.5 text-right tabular-nums">{pct(s.sum.n ? s.sum.wins / s.sum.n : null, 0)}</td>
                    <td className="whitespace-normal py-1.5 text-right">
                      <span className={cn('block font-semibold tabular-nums', netClass(s.sum.net))}>{moneyText(s.sum.net)}</span>
                      <span className={cn('block text-[11px] tabular-nums', netClass(s.sum.net))}>{moneyText(s.sum.net / s.sum.n)} each</span>
                      <span aria-hidden className="mt-1 ml-auto block h-1 rounded-full" style={{ width: `${Math.max(4, (100 * Math.abs(s.sum.net)) / most)}%`, background: s.sum.net >= 0 ? 'var(--up)' : 'var(--down)', opacity: 0.7 }} />
                    </td>
                  </tr>
                  {isOpen && s.methods.map((m) => (
                    <tr key={m.method} className="text-[12.5px]">
                      <th scope="row" className="whitespace-normal py-1 pl-5 pr-2 text-left text-[12.5px] font-normal normal-case leading-snug tracking-normal text-muted-foreground [overflow-wrap:anywhere]">{m.name}</th>
                      <td className="whitespace-normal py-1 text-right align-top">{countBtn(m.n, `See the ${count(m.n)} trades of ${m.name} in ${words}`, () => onOpen({ slotFrom: s.from, slotTo: s.to, method: m.method }, `${m.name} · ${words}`))}</td>
                      <td className="whitespace-normal py-1 text-right align-top tabular-nums">{pct(m.n ? m.wins / m.n : null, 0)}</td>
                      <td className={cn('whitespace-normal py-1 text-right align-top font-medium tabular-nums', netClass(m.net))}>{moneyText(m.net)}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="m-0 text-[12px] text-muted-foreground">Tap a session for its methods, the best first; tap a count for its trades, one by one, over every day.</p>
    </div>
  );
}
