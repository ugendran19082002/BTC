import type { MarketRead, SnapshotMeta } from '../types';
import { Note } from './ui/card';
import { Stat, StatDivider } from './ui/stat';

const money = (v: number | null) =>
  v === null ? '—' : (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(0);

/**
 * What BTC has actually done, under what the market says it will do.
 *
 * A section rather than a card of its own: it used to sit in the reference row
 * repeating the expected move that the contract card two feet away had already
 * given, and the two only mean anything read together -- ±$650 priced against
 * $1,772 travelled yesterday is the whole point, and it was split across the
 * page. So it lives under the contract it describes.
 */
export function MoveSection({ market, snap }: { market: MarketRead; snap: SnapshotMeta }) {
  const last24 = market.moves.find((m) => m.hours === 24);
  const em = snap.expectedMove;
  const ratio = em && em > 0 && last24?.rangeUsd ? last24.rangeUsd / em : null;

  return (
    <>
      <StatDivider />
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
        how far it has actually moved
      </div>

      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-[11.8px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--dim)]">
              <th className="px-1 py-1 text-left font-normal">window</th>
              <th className="px-1 py-1 text-right font-normal">moved</th>
              <th className="px-1 py-1 text-right font-normal">%</th>
              <th className="px-1 py-1 text-right font-normal">high to low</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {market.moves.map((m) => {
              // How much of this contract's own life has already been spent
              // moving. The fixed windows describe BTC; this row describes the
              // trade in front of you, so it gets to stand out.
              const inContract = m.label === 'this contract so far';
              return (
              <tr key={m.label} className={`border-b border-[#ffffff08]${inContract ? ' bg-[#6cb2ff10]' : ''}`}>
                <td className={`px-1 py-[3px] text-left font-sans ${inContract ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {m.label}
                  {inContract && <span className="text-[var(--dim)]"> · {m.hours.toFixed(1)}h in</span>}
                </td>
                <td className={`px-1 py-[3px] text-right ${(m.changeUsd ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
                  {money(m.changeUsd)}
                </td>
                <td className={`px-1 py-[3px] text-right ${(m.changePct ?? 0) >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'}`}>
                  {m.changePct === null ? '—' : `${m.changePct >= 0 ? '+' : ''}${m.changePct.toFixed(2)}%`}
                </td>
                <td className="px-1 py-[3px] text-right">
                  {m.rangeUsd === null ? '—' : `$${m.rangeUsd.toFixed(0)}`}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <StatDivider />
      <Stat
        label="biggest day this month"
        value={
          market.max24hRangeUsd === null
            ? '—'
            : `$${market.max24hRangeUsd.toFixed(0)} · ${market.max24hRangePct?.toFixed(2)}%`
        }
      />
      <Stat
        label="yesterday against what the market expects"
        value={ratio === null ? '—' : `${ratio.toFixed(2)}×`}
        tone={ratio === null ? 'plain' : ratio > 2 ? 'warn' : 'up'}
      />

      <Note>
        Over 733 days, the day before moved <b>1.72×</b> what the market was pricing
        that morning. A strike one expected move away is not one day's travel away —
        BTC covers that distance often.
      </Note>

      <ExpectedTable snap={snap} />
    </>
  );
}

/**
 * The same table, forwards.
 *
 * Above is what BTC did; this is what today's option prices say it can do over
 * the stretch you are about to hold. Same shape on purpose -- the two are only
 * worth anything read against each other, and a reader should be able to run an
 * eye down one column and across.
 *
 * Direction is deliberately absent, and it is not an omission to be fixed
 * later. Across 105,119 windows the chance of finishing higher never sat more
 * than 0.6 points from a coin flip at any horizon, and filtering by trend or by
 * the last bar moved it by under a point. How far it can travel is knowable;
 * which way is not. So every row is +/-.
 */
function ExpectedTable({ snap }: { snap: SnapshotMeta }) {
  const iv = snap.atmIv;
  if (iv === null) return null;

  const HOURS_IN_YEAR = 365 * 24;
  // spot x volatility x sqrt(time) -- volatility is quoted per year, so it is
  // scaled down to the window in question
  const move = (hours: number) => snap.spot * iv * Math.sqrt(hours / HOURS_IN_YEAR);

  const left = snap.hoursToExpiry;
  type Row = { label: string; hours: number; last?: boolean };
  const rows: Row[] = ([
    { label: 'next 5m', hours: 5 / 60 },
    { label: 'next 15m', hours: 0.25 },
    { label: 'next 1h', hours: 1 },
    { label: 'next 2h', hours: 2 },
    { label: 'next 4h', hours: 4 },
    { label: 'next 6h', hours: 6 },
    { label: 'next 12h', hours: 12 },
  ] as Row[])
    // a window longer than the contract has left is not a window you can hold
    .filter((r) => r.hours < left)
    .concat([{ label: 'to settlement', hours: left, last: true }]);

  return (
    <>
      <StatDivider />
      <div
        className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground"
        title={`spot x volatility x sqrt(hours / 8760) -- ${snap.spot.toFixed(0)} x ${(iv * 100).toFixed(1)}% at today's at-the-money volatility`}
      >
        how far it could move from here
      </div>

      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-[11.8px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--dim)]">
              <th className="px-1 py-1 text-left font-normal">window</th>
              <th className="px-1 py-1 text-right font-normal">could move</th>
              <th className="px-1 py-1 text-right font-normal">%</th>
              <th className="px-1 py-1 text-right font-normal">2 times in 3</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r) => {
              const m = move(r.hours);
              return (
                <tr
                  key={r.label}
                  className={`border-b border-[#ffffff08]${r.last ? ' bg-[#6cb2ff10]' : ''}`}
                >
                  <td className={`px-1 py-[3px] text-left font-sans ${r.last ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {r.label}
                    {r.last && <span className="text-[var(--dim)]"> · {r.hours.toFixed(1)}h</span>}
                  </td>
                  <td className="px-1 py-[3px] text-right">±${m.toFixed(m < 100 ? 1 : 0)}</td>
                  <td className="px-1 py-[3px] text-right text-[var(--dim)]">
                    ±{((m / snap.spot) * 100).toFixed(2)}%
                  </td>
                  <td className="px-1 py-[3px] text-right text-[var(--dim)]">
                    {(snap.spot - m).toFixed(0)} – {(snap.spot + m).toFixed(0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Note>
        Plus <i>or</i> minus — never one or the other. Direction over these windows
        was measured and is a coin flip: across 105,119 windows the chance of
        finishing higher never moved further than 0.6 points from even, at any
        horizon, and filtering by trend changed it by under a point.
      </Note>
      <Note tone="dim">
        These are one standard deviation: BTC stays inside about two times in three,
        and steps outside the third. Double the figure for the 19-in-20 range. The
        table above is the check on this one — every day that broke the strategy
        travelled further than the market had priced that morning.
      </Note>
    </>
  );
}
