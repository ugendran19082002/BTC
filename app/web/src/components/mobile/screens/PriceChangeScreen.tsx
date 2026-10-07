import { ArrowDown, ArrowRight, ArrowUp, Minus } from 'lucide-react';
import { getPriceChange } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { clock } from '@/lib/format';
import { points, priceMoves, signedPct, signedPoints, type PriceMove } from '@/lib/price-change';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { Empty, Loading, Panel } from '@/components/mobile/parts';
import { nextSettlement } from '@/components/mobile/screens/MarketScreen';

/**
 * Price changes (owner, 7 Oct 2026): the desk's "Price change" card, made for a phone. BTC's index now, then a
 * line for each window back -- 1m out to 12h -- and for the desk's own marks, the first entry of what it holds
 * and the last 17:30 settlement. Each line says where the price was and where it is ("84,991 → 83,774"), how far
 * that is in points and percent, and which way, with a bar for its size against the largest move on the screen.
 *
 * Read-only, from `/api/price-change`, which the desk's own card reads; asked again every fifteen seconds.
 */

const TONE = { up: 'text-[var(--up)]', down: 'text-[var(--down)]', flat: 'text-muted-foreground' } as const;
const FILL = { up: 'bg-[var(--up)]', down: 'bg-[var(--down)]', flat: 'bg-[var(--dim)]' } as const;
const ICON = { up: ArrowUp, down: ArrowDown, flat: Minus } as const;
const SAID = { up: 'up', down: 'down', flat: 'no change' } as const;

export function PriceChangeScreen() {
  const p = usePhone();
  // "Since entry": the first fill of anything the desk holds now. "Last settlement": a day before the next one.
  const fills = (p.status?.open ?? []).filter((t) => t.position !== 0).flatMap((t) => t.fills.map((f) => f.ts)).filter((v) => v > 0);
  const entryMs = fills.length ? Math.min(...fills) : null;
  const expiryTs = Math.round(nextSettlement(p.now) / 1000);
  const res = usePoll(() => getPriceChange(entryMs, expiryTs), 15_000, { deps: [entryMs, expiryTs] });
  const { windows, marks } = priceMoves(res.data ?? null);
  const now = res.data?.spot ?? null;

  return (
    <>
      <Panel>
        <span className="flex items-baseline justify-between gap-2 text-[13px] text-muted-foreground">
          <span>BTC index now</span>
          {res.data && <span className="tabular-nums text-[var(--time)]">{clock(res.data.at)}</span>}
        </span>
        {!res.data ? <Loading error={res.error} what="the price" /> : (
          <>
            <div className="text-[30px] font-semibold leading-tight tabular-nums">{points(now)}</div>
            {p.perp !== null && (
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                Perp {p.perpLive ? 'last' : 'mark'} <span className="tabular-nums text-foreground">{points(p.perp)}</span>
                {now !== null && <span className="tabular-nums"> · {signedPoints(p.perp - now)} to the index</span>}
              </div>
            )}
          </>
        )}
      </Panel>

      {res.data && (
        <>
          {marks.length > 0 && (
            <Panel title="Since the desk's marks" right={<span className="text-[11.5px] text-muted-foreground">from → now</span>}>
              <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0">
                {marks.map((m) => <MoveRow key={m.key} move={m} />)}
              </ul>
            </Panel>
          )}
          <Panel title="Each window back" right={<span className="text-[11.5px] text-muted-foreground">from → now</span>}>
            {windows.length === 0 ? <Empty>No price record yet.</Empty> : (
              <ul className="m-0 list-none divide-y divide-[var(--line-soft)] p-0" aria-label="Price change by window">
                {windows.map((m) => <MoveRow key={m.key} move={m} />)}
              </ul>
            )}
          </Panel>
          <p className="m-0 px-1 text-[12px] text-muted-foreground">
            Points are on the BTC index, from the desk's candles: where the price was at the start of each window, and where it is now.
            A dash means the candles do not reach that far back yet.
          </p>
        </>
      )}
    </>
  );
}

/** One window or mark: its name and when it starts, the move in points; under them from → now and the percent; then its bar. */
function MoveRow({ move: m }: { move: PriceMove }) {
  const Icon = ICON[m.way];
  return (
    <li
      className="py-2.5"
      aria-label={`${m.label}, from ${clock(m.at)}: ${m.pts === null ? 'no record' : `${SAID[m.way]} ${signedPoints(m.pts)} points, ${signedPct(m.pct)}, from ${points(m.from)} to ${points(m.to)}`}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">
          <span className="text-[15px] font-semibold">{m.label}</span>
          <span className="ml-2 text-[12px] tabular-nums text-[var(--time)]">{clock(m.at)}</span>
        </span>
        <span className={cn('flex shrink-0 items-center gap-1 whitespace-nowrap text-[15px] font-semibold tabular-nums', TONE[m.way])}>
          {m.pts !== null && <Icon aria-hidden="true" className="h-4 w-4" />}
          {signedPoints(m.pts)}{m.pts !== null && <span className="text-[12px] font-medium"> pts</span>}
        </span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-3 text-[13px] tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span>{points(m.from)}</span>
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium text-foreground">{points(m.to)}</span>
        </span>
        <span className={cn('shrink-0 whitespace-nowrap', TONE[m.way])}>{signedPct(m.pct)}</span>
      </div>
      <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--panel-3)]">
        <div className={cn('h-full rounded-full', FILL[m.way])} style={{ width: `${m.pts === null ? 0 : Math.max(2, m.share * 100)}%` }} />
      </div>
    </li>
  );
}
