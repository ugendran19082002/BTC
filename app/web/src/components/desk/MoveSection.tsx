import { TODAY_MOVE, type MarketRead, type SnapshotMeta } from '@/types/desk';
import { Note } from '@/components/ui/card';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Stat, StatDivider } from '@/components/ui/stat';
import { cn } from '@/lib/utils';

const grouped = (v: number) => Math.round(v).toLocaleString('en-US');
const money = (v: number | null) =>
  v === null ? '—' : (v >= 0 ? '+' : '−') + '$' + grouped(Math.abs(v));

/**
 * What BTC has actually done, beside what the market says it can still do.
 *
 * Two cards under the Market card. They were a section inside it, which made
 * the contract card the tallest thing on the screen and put the two tables in
 * half its width; as cards of their own they sit side by side where the column
 * is wide, stack where it is not, and each folds on its own. The pairing is the
 * point -- ±$650 priced against $1,772 travelled yesterday -- so they stay next
 * to each other, and next to the contract they describe.
 */
export function MoveSection({ market, snap, defaultOpen = true }: {
  market: MarketRead;
  snap: SnapshotMeta;
  /** Open on a desk, folded on a phone -- the same rule as the Market card. */
  defaultOpen?: boolean;
}) {
  const last24 = market.moves.find((m) => m.hours === 24);
  const em = snap.expectedMove;
  const ratio = em && em > 0 && last24?.rangeUsd ? last24.rangeUsd / em : null;

  return (
    <div className="move-cards">
      <CollapsibleCard id="moved" title="How far BTC has moved" defaultOpen={defaultOpen} className="move-card">
        <div className="-mx-1 overflow-x-auto">
          <table className="move-table" aria-label="how far BTC has moved">
            <thead>
              <tr>
                <th>Period</th>
                <th>Change</th>
                <th>%</th>
                <th>Range</th>
              </tr>
            </thead>
            <tbody>
              {market.moves.map((m) => {
                // How far the day has come since 05:30, the moment the morning
                // entry was sold from. The fixed windows describe BTC; this row
                // describes the trade in front of you, so it gets to stand out.
                const inContract = m.label === TODAY_MOVE;
                const tone = (m.changeUsd ?? 0) >= 0 ? 'up' : 'down';
                return (
                  <tr key={m.label} className={cn(inContract && 'today')}>
                    <td>
                      {m.label}
                      {inContract && <span className="dim"> · {m.hours.toFixed(1)}h in</span>}
                    </td>
                    <td className={tone}>{money(m.changeUsd)}</td>
                    <td className={cn((m.changePct ?? 0) >= 0 ? 'up' : 'down')}>
                      {m.changePct === null ? '—' : `${m.changePct >= 0 ? '+' : '−'}${Math.abs(m.changePct).toFixed(2)}%`}
                    </td>
                    <td>{m.rangeUsd === null ? '—' : `$${grouped(m.rangeUsd)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <StatDivider />
        <Stat
          label="Biggest day this month"
          value={
            market.max24hRangeUsd === null
              ? '—'
              : `$${grouped(market.max24hRangeUsd)} · ${market.max24hRangePct?.toFixed(2)}%`
          }
        />
        <Stat
          label="Yesterday's range ÷ today's expected move"
          value={ratio === null ? '—' : `${ratio.toFixed(2)}×`}
          tone={ratio === null ? 'plain' : ratio > 2 ? 'warn' : 'up'}
          hint="On average BTC moved 1.72× the expected move. A strike one expected move away is not a full day's move away."
        />
      </CollapsibleCard>

      {snap.atmIv !== null && (
        <CollapsibleCard id="can-move" title="How far it can move from here" defaultOpen={defaultOpen} className="move-card">
          <MoveLadder snap={snap} iv={snap.atmIv} />
        </CollapsibleCard>
      )}
    </div>
  );
}

/**
 * How far BTC can travel from here, drawn rather than tabulated.
 *
 * The same numbers as a table of dollars and percentages, except a table asks
 * you to compare 57.7 against 643 in your head. A bar does that for you: you
 * see the strike distance you need before you read a single figure. Spot is the
 * line down the middle and every bar is centred on it, because direction over
 * these windows is a coin flip -- so the picture is symmetrical, which is the
 * honest shape.
 */
function MoveLadder({ snap, iv }: { snap: SnapshotMeta; iv: number }) {
  const HOURS_IN_YEAR = 365 * 24;
  const move = (hours: number) => snap.spot * iv * Math.sqrt(hours / HOURS_IN_YEAR);

  const left = snap.hoursToExpiry;
  type Row = { label: string; hours: number; last?: boolean };
  const rows: Row[] = ([
    { label: '5 min', hours: 5 / 60 },
    { label: '1 hour', hours: 1 },
    { label: '4 hours', hours: 4 },
  ] as Row[])
    // a window longer than the contract has left is not one you can hold
    .filter((r) => r.hours < left)
    .concat([{ label: 'By expiry', hours: left, last: true }]);

  const widest = move(rows[rows.length - 1]!.hours) || 1;

  return (
    <div
      className="move-ladder"
      aria-label="how far it can move from here"
      title="spot × volatility × √(hours ÷ 8760), at today's volatility. BTC stays inside about 2 times in 3; double it for 19 in 20."
    >
      <div className="move-ladder-scale">
        <span>Lower</span>
        <span className="move-ladder-now">Now <b>{grouped(snap.spot)}</b></span>
        <span>Higher</span>
      </div>

      {rows.map((r) => {
        const m = move(r.hours);
        const w = Math.max(4, (m / widest) * 100);
        return (
          <div key={r.label} className={cn('move-ladder-row', r.last && 'last')}>
            <span className="move-ladder-label">{r.label}</span>
            <span className="move-ladder-track">
              <i className="move-ladder-bar" style={{ left: `${50 - w / 2}%`, width: `${w}%` }} />
              <i className="move-ladder-spot" />
            </span>
            <span className="move-ladder-value">
              ±${grouped(m)}
              <span className="dim">{((m / snap.spot) * 100).toFixed(2)}%</span>
            </span>
          </div>
        );
      })}

      <div className="move-ladder-ends">
        <span>{grouped(snap.spot - widest)}</span>
        <span className="move-ladder-inside">2 in 3 chance inside</span>
        <span>{grouped(snap.spot + widest)}</span>
      </div>

      <Note>Direction can't be predicted — only distance.</Note>
    </div>
  );
}
