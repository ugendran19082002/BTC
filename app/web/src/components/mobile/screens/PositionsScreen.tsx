import { useMemo } from 'react';
import { usePhone } from '@/components/mobile/phone-context';
import { PositionCard } from '@/components/mobile/PositionCard';
import { SessionLossCard } from '@/components/mobile/SessionLossCard';
import { Bar, Empty, Panel } from '@/components/mobile/parts';
import { positionRisk } from '@/lib/position-risk';
import { MARGIN_WARN } from '@/lib/phone-alerts';
import { isRunning, isWaiting } from '@/lib/trade-events';
import { usePersisted } from '@/hooks/usePersisted';
import { pct, signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SortSheet } from '@/components/mobile/SortSheet';
import type { Trade } from '@/types/trade';

/**
 * Positions (6 Oct 2026): every open position's live risk. Read only: no button here could close, edit or add, and
 * the phone's session could not.
 *
 * On top (owner, 9 Oct 2026: "position phone la user friendly upgrades"): three tiles -- how many are running, what
 * they leave if closed now, and the margin used with a bar -- then which to show (winning, losing, waiting, and
 * the ones with a problem when there are any), each with its count, and how to sort them. Both remembered on the
 * phone. Whatever the sort, a position with a problem (an alert) stays on top and an order still waiting goes after the
 * running ones: a sort is for reading, and must never bury the position that needs a look.
 *
 * The tiles add up (owner, 24 Nov 2026: "all win loss filter count thappa kaatra maari iruku ... best practice fix"):
 * every position is in exactly one of Winning, Losing, Waiting and No price, so All is always their sum. No price is
 * a position with no close price to read (no offer on the book, or one closing as the list catches up); it shows only
 * when there is one. The P&L is the close price's only (`netIfClosedUsd`, the ask for a short): never the mark, which
 * no close could print. With CE or PE picked, the All tile says which side it counts ("All CE").
 */

export type Show = 'all' | 'win' | 'loss' | 'waiting' | 'noprice' | 'alert';
export type Sort = 'risk' | 'pnl-desc' | 'pnl-asc' | 'new' | 'old' | 'perp-sl' | 'perp-tgt' | 'opt-sl' | 'opt-tgt';

export const SORTS: { key: Sort; label: string; hint: string; group: string }[] = [
  { key: 'risk', label: 'Riskiest first', hint: 'Problems, then the least room to the stop', group: 'Risk & P&L' },
  { key: 'pnl-desc', label: 'P&L high to low', hint: 'Biggest profit first', group: 'Risk & P&L' },
  { key: 'pnl-asc', label: 'P&L low to high', hint: 'Biggest loss first', group: 'Risk & P&L' },
  { key: 'new', label: 'Newest first', hint: 'Latest entry on top', group: 'Time' },
  { key: 'old', label: 'Oldest first', hint: 'Earliest entry on top', group: 'Time' },
  // Nearest exit first (owner, 9 Oct 2026). The perp's in points -- one price for every position, so points and
  // percent rank alike; the option's as a share of its own price, since a 20 and a 200 premium do not compare in points.
  { key: 'perp-sl', label: 'Nearest perp SL', hint: 'BTC closest to the signal\'s stop', group: 'Nearest exit' },
  { key: 'perp-tgt', label: 'Nearest perp TGT', hint: 'BTC closest to the signal\'s target', group: 'Nearest exit' },
  { key: 'opt-sl', label: 'Nearest option SL', hint: 'The option closest to its stop', group: 'Nearest exit' },
  { key: 'opt-tgt', label: 'Nearest option TGT', hint: 'The option closest to its target', group: 'Nearest exit' },
];

/** What closing it now would leave, at the close price -- never the mark (no close prints it); null with no price. */
const pnlOf = (t: Trade): number | null => {
  const n = t.live?.netIfClosedUsd;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** When it was opened: its first entry fill, or its last change while it waits for one. */
const openedAt = (t: Trade): number => {
  const entries = t.fills.filter((f) => f.role === 'entry').map((f) => f.ts);
  return entries.length ? Math.min(...entries) : t.updatedAt;
};

/** A tile's figure: 18px on the narrowest phones, 22px from 390px. */
const BIG = 'm-0 text-[18px] font-semibold leading-tight tabular-nums min-[390px]:text-[22px]';
/**
 * The money figure sized to its own tile (17% of its width, 13 to 22px): "−₹10,367" was cut to "−₹10,3…" on
 * every phone from 320 to 414px (9 Oct 2026). The tile is the container (`[container-type:inline-size]`).
 */
const MONEY = 'm-0 text-[clamp(13px,17cqi,22px)] font-semibold leading-tight tabular-nums';
/** A tile's small words: they wrap on a 320px phone rather than end in "…". */
const SMALL = 'm-0 text-[11.5px] leading-tight text-muted-foreground';

type Item = {
  t: Trade; problem: boolean; room: number; pnl: number | null; waiting: boolean;
  /**
   * Room left to each exit: the perp's in points from its mark, the option's as a share of its price. Below zero
   * once the price is through it, so a level already crossed comes first; left out where there is no such level
   * (a manual trade has no perp levels) or no price to measure from, and such a position goes last.
   */
  perpStop?: number; perpTarget?: number; optStop?: number; optTarget?: number;
};

/** Which option side the list shows: both, calls or puts. */
type SideShow = 'all' | 'CE' | 'PE';
/**
 * Which kind each position is -- one of four, so the tiles add up to All. An exact ₹0 after every charge (rare) is
 * not a loss, so it counts as winning.
 */
export type Kind = 'win' | 'loss' | 'waiting' | 'noprice';
export const kindOf = (x: Pick<Item, 'waiting' | 'pnl'>): Kind => (x.waiting ? 'waiting' : x.pnl === null ? 'noprice' : x.pnl < 0 ? 'loss' : 'win');
const SHOWS: { key: Show; label: string; tone: string; test: (x: Item) => boolean; optional?: boolean }[] = [
  { key: 'all', label: 'All', tone: 'text-foreground', test: () => true },
  { key: 'win', label: 'Winning', tone: 'text-[var(--up)]', test: (x) => kindOf(x) === 'win' },
  { key: 'loss', label: 'Losing', tone: 'text-[var(--down)]', test: (x) => kindOf(x) === 'loss' },
  { key: 'waiting', label: 'Waiting', tone: 'text-[var(--warn)]', test: (x) => kindOf(x) === 'waiting' },
  // Shown only when there is one: the tiles add up without it the rest of the time.
  { key: 'noprice', label: 'No price', tone: 'text-muted-foreground', test: (x) => kindOf(x) === 'noprice', optional: true },
  // Not a kind but a mark on any of them: a position with a problem is also winning, losing or waiting.
  { key: 'alert', label: 'Alerts', tone: 'text-[var(--down)]', test: (x) => x.problem, optional: true },
];
/** The tile row's columns, by how many tiles it holds (literal, so the classes are built). */
const COLS: Record<number, string> = { 4: 'grid-cols-4', 5: 'grid-cols-5', 6: 'grid-cols-6' };

/** Least room first; a position without that exit after every one with it (Infinity - Infinity would be NaN). */
const nearest = (of: (x: Item) => number | undefined) => (a: Item, b: Item): number => {
  const x = of(a), y = of(b);
  if (x === undefined || y === undefined) return Number(x === undefined) - Number(y === undefined);
  return x - y;
};

/** The order shown: problems first, waiting orders last, and the chosen sort in between. */
export function sortItems<T extends Item>(items: readonly T[], sort: Sort): T[] {
  const by: Record<Sort, (a: T, b: T) => number> = {
    risk: (a, b) => a.room - b.room,
    // A position with no price yet goes last either way: it is not "the best" or "the worst", it is unknown.
    'pnl-desc': (a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity),
    'pnl-asc': (a, b) => (a.pnl ?? Infinity) - (b.pnl ?? Infinity),
    new: (a, b) => openedAt(b.t) - openedAt(a.t),
    old: (a, b) => openedAt(a.t) - openedAt(b.t),
    'perp-sl': nearest((x) => x.perpStop),
    'perp-tgt': nearest((x) => x.perpTarget),
    'opt-sl': nearest((x) => x.optStop),
    'opt-tgt': nearest((x) => x.optTarget),
  };
  return [...items].sort((a, b) => Number(a.waiting) - Number(b.waiting) || Number(b.problem) - Number(a.problem) || by[sort](a, b) || 0);
}

export function PositionsScreen() {
  const p = usePhone();
  const s = p.status;
  const perpMark = p.perp;
  const [show, setShow] = usePersisted<Show>('m-positions-show', 'all');
  const [sort, setSort] = usePersisted<Sort>('m-positions-sort', 'risk');
  // CE / PE (owner, 22 Nov 2026: "shown and sort by, centre la CE PE tab ... small, user friendly"): the list and its tiles.
  const [side, setSide] = usePersisted<SideShow>('m-positions-side', 'all');

  const items = useMemo((): Item[] => (s?.open ?? []).map((t) => {
    const r = positionRisk(t, { alarms: s?.alarms, perpMark });
    const room = r.stop && r.stop.pct !== null && Number.isFinite(r.stop.pct) ? r.stop.pct : Infinity;
    const known = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);
    return {
      t, problem: r.problems.length > 0, room, pnl: pnlOf(t), waiting: isWaiting(t),
      perpStop: known(r.perp?.toStop), perpTarget: known(r.perp?.toTarget),
      optStop: known(r.stop?.pct), optTarget: known(r.target?.pct),
    };
  }), [s, perpMark]);

  const sideOn: SideShow = side === 'CE' || side === 'PE' ? side : 'all';
  const sided = useMemo(() => (sideOn === 'all' ? items : items.filter((x) => x.t.optionSide === sideOn)), [items, sideOn]);
  // The tiles offered: an optional one only with something in it. A remembered choice the screen no longer offers
  // (Alerts or No price with none left) reads as All.
  const tiles = SHOWS.filter((x) => !x.optional || sided.some(x.test));
  const showing: Show = tiles.some((x) => x.key === show) ? show : 'all';
  const sorting: Sort = SORTS.some((x) => x.key === sort) ? sort : 'risk';
  const test = SHOWS.find((x) => x.key === showing)!.test;
  const shown = useMemo(() => sortItems(sided.filter(test), sorting), [sided, test, sorting]);

  const running = (s?.open ?? []).filter(isRunning).length;
  const waiting = items.filter((x) => x.waiting).length;
  const noPrice = items.filter((x) => kindOf(x) === 'noprice').length;
  const total = items.reduce((n, x) => n + (x.pnl ?? 0), 0);
  const shownTotal = shown.reduce((n, x) => n + (x.pnl ?? 0), 0);
  const used = s?.marginUsedUsd != null && s.walletUsd ? s.marginUsedUsd / s.walletUsd : null;
  const usedTone = used === null ? 'up' : used >= 0.9 ? 'down' : used >= MARGIN_WARN ? 'warn' : 'up';

  return (
    <>
      <Panel>
        <dl aria-label="positions summary" className="m-0 grid grid-cols-[1fr_1.25fr_1fr] divide-x divide-[var(--line-soft)]">
          <div className="min-w-0 pr-2.5">
            <dt className={SMALL}>Running</dt>
            <dd className={BIG}>{s ? running : '…'}</dd>
            <dd className={SMALL}>{waiting ? <span className="text-[var(--warn)]">+{waiting} waiting</span> : 'positions'}</dd>
          </div>
          <div className="min-w-0 px-2.5 [container-type:inline-size]">
            <dt className={SMALL}>Total P&amp;L</dt>
            {/* Rupees alone: with the dollars beside it, -₹3,983.20 does not fit a third of a 360px phone. */}
            <dd className={cn(MONEY, 'truncate', s && total > 0 && 'text-[var(--up)]', s && total < 0 && 'text-[var(--down)]')}>{s ? signedInr(usdToInr(total)) : '…'}</dd>
            <dd className={SMALL}>{noPrice ? <span className="text-[var(--warn)]">{noPrice} with no price</span> : 'if closed now'}</dd>
          </div>
          <div className="min-w-0 pl-2.5">
            <dt className={SMALL}>Margin used</dt>
            <dd className={cn(BIG, usedTone === 'down' && 'text-[var(--down)]', usedTone === 'warn' && 'text-[var(--warn)]')}>
              {used === null ? '—' : pct(used, 0)}
            </dd>
            <dd className="m-0 mt-1">{used !== null ? <Bar value={used} tone={usedTone} label="Margin used of the wallet" /> : null}</dd>
            <dd className={cn(SMALL, 'mt-0.5')}>of the wallet</dd>
          </div>
        </dl>
      </Panel>

      {/* The session loss limit, to read: each account's session, its money so far and what is left (6 Nov 2026). */}
      <SessionLossCard />

      {s && items.length > 0 && (
        <>
          {/* Equal tiles, the count over the word: every one fits a 360px phone, none scrolled off the edge. */}
          <div role="group" aria-label="Show positions" className={cn('grid gap-1.5', COLS[tiles.length] ?? 'grid-cols-6')}>
            {tiles.map((x) => {
              const n = sided.filter(x.test).length;
              const on = showing === x.key;
              // With CE or PE picked the counts are that side's: the All tile says so, beside a Running of both.
              const label = x.key === 'all' && sideOn !== 'all' ? `All ${sideOn}` : x.label;
              return (
                <button
                  key={x.key} type="button" aria-pressed={on} aria-label={`${label} ${n}`}
                  onClick={() => setShow(on ? 'all' : x.key)}
                  className={cn(
                    'flex h-14 min-w-0 flex-col items-center justify-center rounded-lg border px-0 font-[inherit] min-[360px]:px-1',
                    on ? 'border-foreground/60 bg-muted' : 'border-border bg-transparent',
                  )}
                >
                  <span className={cn('text-[17px] font-semibold leading-tight tabular-nums', n === 0 ? 'text-muted-foreground' : x.tone)}>{n}</span>
                  {/* 11px under 360px: five across a 320px phone leave 45px a word, and "Winning" was "Win…". */}
                  <span className={cn('max-w-full truncate text-[11px] tracking-[-0.2px] min-[360px]:text-[12px] min-[360px]:tracking-normal', on ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
                </button>
              );
            })}
          </div>
          {/* One row: how many, CE / PE in the middle, the sort -- each kept to its size so a 360px phone holds all three. */}
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 shrink flex-col leading-tight tabular-nums text-muted-foreground" aria-live="polite">
              <span className="truncate text-[13.5px] font-semibold text-foreground">{showing === 'all' && sideOn === 'all' ? shown.length : `${shown.length} of ${items.length}`}</span>
              <span className="truncate text-[11px]">
                {(showing !== 'all' || sideOn !== 'all') && shown.length > 0
                  ? <span className={shownTotal > 0 ? 'text-[var(--up)]' : shownTotal < 0 ? 'text-[var(--down)]' : ''}>{signedInr(usdToInr(shownTotal))}</span>
                  : 'shown'}
              </span>
            </span>
            <div role="group" aria-label="Option side" className="flex h-11 shrink-0 items-center rounded-lg border border-border bg-transparent p-0.5">
              {(['all', 'CE', 'PE'] as const).map((k) => {
                const on = sideOn === k;
                const n = k === 'all' ? items.length : items.filter((x) => x.t.optionSide === k).length;
                return (
                  <button
                    key={k} type="button" aria-pressed={on} aria-label={`${k === 'all' ? 'Both sides' : k} ${n}`} onClick={() => setSide(k)}
                    className={cn('h-full min-w-[38px] rounded-md border-0 px-2 font-[inherit] text-[13px] font-semibold',
                      on ? 'bg-muted text-foreground' : 'bg-transparent text-muted-foreground')}
                  >
                    {k === 'all' ? 'All' : k}
                  </button>
                );
              })}
            </div>
            <SortPicker value={sorting} onChange={setSort} />
          </div>
        </>
      )}

      {!s ? <Panel><Empty>Reading positions…</Empty></Panel> : items.length === 0 ? <Panel><Empty>No open positions.</Empty></Panel> : shown.length === 0 ? (
        <Panel>
          <Empty>
            No {SHOWS.find((x) => x.key === showing)!.label.toLowerCase()} positions right now.{' '}
            <button type="button" onClick={() => setShow('all')} className="m-0 border-0 bg-transparent p-0 font-[inherit] text-[var(--accent)] underline underline-offset-2">Show all</button>
          </Empty>
        </Panel>
      ) : (
        shown.map(({ t }) => (
          <PositionCard
            key={`${t.account?.id ?? ''}-${t.tradeId}`} trade={t} alarms={s.alarms} perpMark={perpMark} perpLive={p.perpLive}
            now={p.now} showAccount={p.shown === 'all'} onOpen={() => p.openTrade(t.tradeId)}
          />
        ))
      )}
    </>
  );
}

/** "Sort by / P&L high to low": the face, opening the sort sheet (`SortSheet`, 22 Nov 2026 -- a bare select before). */
function SortPicker({ value, onChange }: { value: Sort; onChange: (v: Sort) => void }) {
  return <SortSheet value={value} choices={SORTS} onChange={onChange} name="Sort positions by" />;
}
