import { useMemo } from 'react';
import { ArrowUpDown, ChevronDown } from 'lucide-react';
import { usePhone } from '@/components/mobile/phone-context';
import { PositionCard } from '@/components/mobile/PositionCard';
import { Bar, Empty, Panel } from '@/components/mobile/parts';
import { positionRisk } from '@/lib/position-risk';
import { MARGIN_WARN } from '@/lib/phone-alerts';
import { isRunning, isWaiting } from '@/lib/trade-events';
import { usePersisted } from '@/hooks/usePersisted';
import { pct, signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';
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
 */

export type Show = 'all' | 'win' | 'loss' | 'waiting' | 'alert';
export type Sort = 'risk' | 'pnl-desc' | 'pnl-asc' | 'new' | 'old' | 'perp-sl' | 'perp-tgt' | 'opt-sl' | 'opt-tgt';

export const SORTS: { key: Sort; label: string }[] = [
  { key: 'risk', label: 'Riskiest first' },
  { key: 'pnl-desc', label: 'P&L high to low' },
  { key: 'pnl-asc', label: 'P&L low to high' },
  { key: 'new', label: 'Newest first' },
  { key: 'old', label: 'Oldest first' },
  // Nearest exit first (owner, 9 Oct 2026). The perp's in points -- one price for every position, so points and
  // percent rank alike; the option's as a share of its own price, since a 20 and a 200 premium do not compare in points.
  { key: 'perp-sl', label: 'Nearest perp SL' },
  { key: 'perp-tgt', label: 'Nearest perp TGT' },
  { key: 'opt-sl', label: 'Nearest option SL' },
  { key: 'opt-tgt', label: 'Nearest option TGT' },
];

const pnlOf = (t: Trade): number | null => t.live?.netIfClosedUsd ?? t.live?.unrealisedPnl ?? null;
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

const SHOWS: { key: Show; label: string; tone: string; test: (x: Item) => boolean }[] = [
  { key: 'all', label: 'All', tone: 'text-foreground', test: () => true },
  { key: 'win', label: 'Winning', tone: 'text-[var(--up)]', test: (x) => !x.waiting && (x.pnl ?? 0) > 0 },
  { key: 'loss', label: 'Losing', tone: 'text-[var(--down)]', test: (x) => !x.waiting && (x.pnl ?? 0) < 0 },
  { key: 'waiting', label: 'Waiting', tone: 'text-[var(--warn)]', test: (x) => x.waiting },
  { key: 'alert', label: 'Alerts', tone: 'text-[var(--down)]', test: (x) => x.problem },
];

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

  // A remembered choice the screen no longer offers (Problems with none left) reads as All.
  const problems = items.filter((x) => x.problem).length;
  const showing = show === 'alert' && problems === 0 ? 'all' : (SHOWS.some((x) => x.key === show) ? show : 'all');
  const sorting: Sort = SORTS.some((x) => x.key === sort) ? sort : 'risk';
  const test = SHOWS.find((x) => x.key === showing)!.test;
  const shown = useMemo(() => sortItems(items.filter(test), sorting), [items, test, sorting]);

  const running = (s?.open ?? []).filter(isRunning).length;
  const waiting = items.filter((x) => x.waiting).length;
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
            <dd className={SMALL}>if closed now</dd>
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

      {s && items.length > 0 && (
        <>
          {/* Equal tiles, the count over the word: every one fits a 360px phone, none scrolled off the edge. */}
          <div role="group" aria-label="Show positions" className={cn('grid gap-1.5', problems > 0 ? 'grid-cols-5' : 'grid-cols-4')}>
            {SHOWS.filter((x) => x.key !== 'alert' || problems > 0).map((x) => {
              const n = items.filter(x.test).length;
              const on = showing === x.key;
              return (
                <button
                  key={x.key} type="button" aria-pressed={on} aria-label={`${x.label} ${n}`}
                  onClick={() => setShow(on ? 'all' : x.key)}
                  className={cn(
                    'flex h-14 min-w-0 flex-col items-center justify-center rounded-lg border px-0 font-[inherit] min-[360px]:px-1',
                    on ? 'border-foreground/60 bg-muted' : 'border-border bg-transparent',
                  )}
                >
                  <span className={cn('text-[17px] font-semibold leading-tight tabular-nums', n === 0 ? 'text-muted-foreground' : x.tone)}>{n}</span>
                  {/* 11px under 360px: five across a 320px phone leave 45px a word, and "Winning" was "Win…". */}
                  <span className={cn('max-w-full truncate text-[11px] tracking-[-0.2px] min-[360px]:text-[12px] min-[360px]:tracking-normal', on ? 'text-foreground' : 'text-muted-foreground')}>{x.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[12.5px] tabular-nums text-muted-foreground" aria-live="polite">
              {showing === 'all' ? `${shown.length} shown` : `${shown.length} of ${items.length}`}
              {showing !== 'all' && shown.length > 0 && <> · <span className={shownTotal > 0 ? 'text-[var(--up)]' : shownTotal < 0 ? 'text-[var(--down)]' : ''}>{signedInr(usdToInr(shownTotal))}</span></>}
            </span>
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

/** "Sort by / P&L high to low": a native select under a two-line face, so the phone's own picker opens. */
function SortPicker({ value, onChange }: { value: Sort; onChange: (v: Sort) => void }) {
  return (
    <label className="relative flex h-11 shrink-0 items-center gap-2 rounded-lg border border-border bg-muted pl-2.5 pr-8">
      <ArrowUpDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex flex-col leading-tight">
        <span className="text-[11px] text-muted-foreground">Sort by</span>
        <span className="text-[13.5px] font-semibold text-foreground">{SORTS.find((x) => x.key === value)!.label}</span>
      </span>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      {/* The select covers the face, invisible: the tap opens the phone's own list, with 16px text so iOS does not zoom. */}
      <select aria-label="Sort positions by" value={value} onChange={(e) => onChange(e.target.value as Sort)}
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 text-[16px]">
        {SORTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
      </select>
    </label>
  );
}
