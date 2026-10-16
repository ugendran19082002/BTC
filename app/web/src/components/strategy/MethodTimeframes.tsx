import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { usePersisted } from '@/hooks/usePersisted';
import { dayLabel } from '@/lib/market-report';
import { cn } from '@/lib/utils';
import type { MethodRecordLine, MethodUpdate } from '@/types/strategy';

/**
 * The method updates by time frame, day by day (owner, 16 Oct 2026: "the methods update report, more user friendly:
 * by time frame with its methods, in and out, date wise"). A section a time frame -- its strategies, what came in and
 * went out, how many methods it holds now -- opening to a grid: a method a row, a day a column, each cell what that
 * day did to it. + came in, − went out, ● in the list, blank not in it.
 */
const DAY_MS = 86_400_000;
const IST_MS = 5.5 * 3_600_000;
const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const TF_ORDER = ['3m', '5m', '15m', '30m', '1h', '2h', '4h'];
/** The desk's order: the time frames short to long, several together after their first, the chain, then the unknown. */
const tfRank = (tf: string) => {
  if (tf === 'chain') return 100;
  if (tf === 'other') return 200;
  const first = TF_ORDER.indexOf(tf.split('+')[0]!);
  return (first < 0 ? 50 : first) + (tf.includes('+') ? 0.5 : 0);
};
export const tfWords = (tf: string) => (tf === 'chain' ? 'With the chain' : tf === 'other' ? 'Time frame not known' : tf.split('+').join(' + '));

/** One method on one day, over the time frame's strategies: how many took it in, let it go, and held it at the day's end. */
export type TfCell = { in: number; out: number; held: number };
export type TfMethod = { method: string; cells: TfCell[]; in: number; out: number; nowIn: number; record: MethodRecordLine | null };
export type TfGroup = {
  tf: string;
  strategies: { id: string; name: string; accountId: number | null }[];
  days: { in: number; out: number }[];
  in: number; out: number;
  /** The methods held now, by any of its strategies. */
  now: number;
  methods: TfMethod[];
};

/**
 * The changes laid out by time frame and day. Each strategy starts the range with the list its first change found and
 * carries its list forward day by day, so a day with no change still shows what was held. A record is each
 * strategy's latest daily one, added up.
 */
export function byTimeframe(updates: readonly MethodUpdate[], range: { from: string; to: string }): { days: string[]; groups: TfGroup[] } {
  const days: string[] = [];
  for (let d = range.from; d <= range.to && days.length < 62; d = shift(d, 1)) days.push(d);
  const at = new Map(days.map((d, i) => [d, i]));
  const byTf = new Map<string, MethodUpdate[]>();
  for (const u of updates) (byTf.get(u.tf ?? 'other') ?? byTf.set(u.tf ?? 'other', []).get(u.tf ?? 'other')!).push(u);
  const groups: TfGroup[] = [];
  for (const [tf, us] of byTf) {
    const asc = [...us].sort((a, b) => a.at - b.at || a.id - b.id);
    const strategies = [...new Map(asc.map((u) => [u.strategyId, { id: u.strategyId, name: u.strategyName, accountId: u.accountId }])).values()];
    const rows = new Map<string, TfMethod>();
    const row = (m: string) => rows.get(m) ?? rows.set(m, { method: m, cells: days.map(() => ({ in: 0, out: 0, held: 0 })), in: 0, out: 0, nowIn: 0, record: null }).get(m)!;
    const dayTotals = days.map(() => ({ in: 0, out: 0 }));
    const nowHeld = new Set<string>();
    for (const s of strategies) {
      const mine = asc.filter((u) => u.strategyId === s.id);
      let list = mine[0]!.before;
      for (const m of list) row(m);
      let k = 0;
      days.forEach((day, i) => {
        while (k < mine.length && istDay(mine[k]!.at) <= day) {
          const u = mine[k++]!;
          if (at.get(istDay(u.at)) === i) {
            for (const m of u.added) { row(m).cells[i]!.in++; row(m).in++; dayTotals[i]!.in++; }
            for (const m of u.dropped) { row(m).cells[i]!.out++; row(m).out++; dayTotals[i]!.out++; }
          }
          list = u.after;
        }
        for (const m of list) row(m).cells[i]!.held++;
      });
      // the list after its last change, whatever the range's last day
      const last = mine.at(-1)!.after;
      for (const m of last) { row(m).nowIn++; nowHeld.add(m); }
      const daily = [...mine].reverse().find((u) => u.source === 'daily' && u.records.length);
      for (const r of daily?.records ?? []) {
        if (!rows.has(r.method)) continue;
        const x = row(r.method);
        x.record = x.record ? { method: r.method, trades: x.record.trades + r.trades, wins: x.record.wins + r.wins, net: x.record.net + r.net } : { ...r };
      }
    }
    const methods = [...rows.values()].sort((a, b) => (b.in + b.out) - (a.in + a.out) || b.nowIn - a.nowIn || a.method.localeCompare(b.method));
    groups.push({ tf, strategies, days: dayTotals, in: dayTotals.reduce((a, d) => a + d.in, 0), out: dayTotals.reduce((a, d) => a + d.out, 0), now: nowHeld.size, methods });
  }
  groups.sort((a, b) => tfRank(a.tf) - tfRank(b.tf) || a.tf.localeCompare(b.tf));
  return { days, groups };
}

/** A cell in words, for a screen reader and the tooltip. */
const cellWords = (c: TfCell, many: boolean) => {
  const parts = [c.in ? `came in${many ? ` (${c.in})` : ''}` : '', c.out ? `went out${many ? ` (${c.out})` : ''}` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : c.held ? `in the list${many ? ` (${c.held})` : ''}` : 'not in the list';
};

export function MethodTimeframes({ updates, range, today, nameOf, accountOf, onMethod }: {
  updates: readonly MethodUpdate[];
  range: { from: string; to: string };
  today: string;
  nameOf: (id: string) => string;
  accountOf: (id: number | null) => string | null;
  /** A method's name tapped: its changes in the timeline. */
  onMethod: (m: string) => void;
}) {
  const { days, groups } = useMemo(() => byTimeframe(updates, range), [updates, range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = usePersisted<string[]>('method-log:tf-open', []);
  const opened = new Set(Array.isArray(open) ? open : []);
  const toggle = (tf: string) => setOpen(opened.has(tf) ? [...opened].filter((x) => x !== tf) : [...opened, tf]);
  const manyAccounts = new Set(updates.map((u) => u.accountId)).size > 1;
  const weekday = (d: string) => dayLabel(d).slice(0, 2);
  const dayNo = (d: string) => String(Number(d.slice(8)));

  return (
    <div className="grid min-w-0 gap-2">
      <p aria-label="How to read it" className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
        <span><Mark kind="in" /> came in</span>
        <span><Mark kind="out" /> went out</span>
        <span><Mark kind="held" /> in the list</span>
        <span><Mark kind="none" /> not in it</span>
        <span className="text-[var(--dim)]">· tap a time frame to open it, a method for its changes</span>
      </p>
      {groups.map((g) => {
        const isOpen = opened.has(g.tf);
        const many = g.strategies.length > 1;
        return (
          <section key={g.tf} aria-label={`Time frame ${tfWords(g.tf)}`} className="min-w-0 rounded-md border border-solid border-[var(--line-soft)]">
            <button type="button" aria-expanded={isOpen} onClick={() => toggle(g.tf)}
                    className="m-0 flex w-full min-w-0 appearance-none flex-wrap items-center gap-x-3 gap-y-1 border-0 bg-transparent p-2.5 text-left font-[inherit] text-foreground">
              <ChevronDown aria-hidden className={cn('h-4 w-4 flex-none text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
              <span className="min-w-[4.5rem] text-[15px] font-semibold">{tfWords(g.tf)}</span>
              <span className="text-[12.5px] tabular-nums">
                <span className="text-[var(--up)]">+{g.in} in</span> · <span className="text-[var(--down)]">−{g.out} out</span> · <b>{g.now}</b> methods now
              </span>
              <span className="min-w-0 basis-full truncate pl-7 text-[11.5px] text-muted-foreground sm:basis-auto sm:pl-0">
                {g.strategies.map((s) => (manyAccounts && accountOf(s.accountId) ? `${s.name} (${accountOf(s.accountId)})` : s.name)).join(' · ')}
              </span>
            </button>
            {isOpen && (
              <div className="min-w-0 overflow-x-auto border-0 border-t border-solid border-[var(--line-soft)]">
                <table aria-label={`${tfWords(g.tf)}: methods day by day`} className="w-max min-w-full border-collapse text-[11.5px]">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-[1] bg-[var(--panel)] px-2 py-1 text-left font-medium text-muted-foreground">Method</th>
                      {days.map((d) => (
                        <th key={d} title={dayLabel(d)} className={cn('w-8 px-0.5 py-1 text-center font-medium leading-tight', d === today ? 'text-foreground' : 'text-muted-foreground')}>
                          <span className="block text-[10px] text-[var(--dim)]">{weekday(d)}</span>{dayNo(d)}
                        </th>
                      ))}
                      <th className="px-2 py-1 text-right font-medium text-muted-foreground" title={many ? 'Strategies of this time frame that hold it now' : 'Held now'}>Now</th>
                      <th className="px-2 py-1 text-right font-medium text-muted-foreground" title="Its record at the latest daily update">Win</th>
                    </tr>
                    {/* The day's total, over the head of the grid: how much moved. */}
                    <tr className="border-0 border-t border-solid border-[var(--line-soft)]">
                      <th className="sticky left-0 z-[1] bg-[var(--panel)] px-2 py-1 text-left font-normal text-muted-foreground">In / out</th>
                      {g.days.map((t, i) => (
                        <td key={days[i]} className="px-0.5 py-1 text-center leading-tight tabular-nums">
                          {t.in > 0 && <span className="block text-[var(--up)]">+{t.in}</span>}
                          {t.out > 0 && <span className="block text-[var(--down)]">−{t.out}</span>}
                        </td>
                      ))}
                      <td /><td />
                    </tr>
                  </thead>
                  <tbody>
                    {g.methods.map((m) => (
                      <tr key={m.method} className="border-0 border-t border-solid border-[var(--line-soft)]">
                        <th scope="row" className="sticky left-0 z-[1] max-w-[11rem] bg-[var(--panel)] px-2 py-1 text-left font-normal">
                          <button type="button" onClick={() => onMethod(m.method)}
                                  className="m-0 appearance-none border-0 bg-transparent p-0 text-left font-[inherit] text-[11.5px] leading-snug text-foreground underline decoration-[var(--line)] underline-offset-2">
                            {nameOf(m.method)}
                          </button>
                        </th>
                        {m.cells.map((c, i) => (
                          <td key={days[i]} className="px-0.5 py-0.5 text-center">
                            <Cell c={c} many={many} label={`${nameOf(m.method)}, ${dayLabel(days[i]!)}: ${cellWords(c, many)}`} />
                          </td>
                        ))}
                        <td className="px-2 py-1 text-right tabular-nums">{m.nowIn ? (many ? `${m.nowIn}/${g.strategies.length}` : 'in') : <span className="text-[var(--dim)]">out</span>}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                          {m.record && m.record.trades ? `${Math.round((m.record.wins / m.record.trades) * 100)}% · ${m.record.trades}` : '–'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Mark({ kind }: { kind: 'in' | 'out' | 'held' | 'none' }) {
  return (
    <span aria-hidden className={cn('inline-flex h-4 w-4 items-center justify-center rounded-sm align-[-3px] text-[11px] font-bold leading-none',
      kind === 'in' ? 'bg-[var(--up)] text-[var(--background)]' : kind === 'out' ? 'bg-[var(--down)] text-[var(--background)]'
        : kind === 'held' ? 'bg-muted text-muted-foreground' : 'border border-solid border-[var(--line-soft)]')}>
      {kind === 'in' ? '+' : kind === 'out' ? '−' : kind === 'held' ? '●' : ''}
    </span>
  );
}

/** A day's cell: + or − where it moved (with a count when several strategies share the time frame), ● where it was held. */
function Cell({ c, many, label }: { c: TfCell; many: boolean; label: string }) {
  const both = c.in > 0 && c.out > 0;
  return (
    <span role="img" aria-label={label} title={label}
          className={cn('inline-flex h-6 min-w-6 items-center justify-center rounded-sm px-0.5 text-[11px] font-bold leading-none tabular-nums',
            both ? 'bg-[var(--warn)] text-[var(--background)]'
              : c.in ? 'bg-[var(--up)] text-[var(--background)]'
                : c.out ? 'bg-[var(--down)] text-[var(--background)]'
                  : c.held ? 'bg-muted text-muted-foreground' : '')}>
      {both ? `±` : c.in ? `+${many && c.in > 1 ? c.in : ''}` : c.out ? `−${many && c.out > 1 ? c.out : ''}` : c.held ? '●' : ''}
    </span>
  );
}
