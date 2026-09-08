import type { MarketRead, SnapshotMeta } from '../types';
import { Note } from './ui/card';
import { Stat, StatDivider } from './ui/stat';
import { SectionTitle } from './ui/section';

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
      <SectionTitle>how far it has already moved</SectionTitle>

      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-[11.8px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--dim)]">
              <th className="px-1 py-1 text-left font-normal">when</th>
              <th className="px-1 py-1 text-right font-normal">moved</th>
              <th className="px-1 py-1 text-right font-normal">%</th>
              <th className="px-1 py-1 text-right font-normal">swing</th>
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
        label="wildest day this month"
        value={
          market.max24hRangeUsd === null
            ? '—'
            : `$${market.max24hRangeUsd.toFixed(0)} · ${market.max24hRangePct?.toFixed(2)}%`
        }
      />
      <Stat
        label="yesterday, against what today is priced at"
        value={ratio === null ? '—' : `${ratio.toFixed(2)}×`}
        tone={ratio === null ? 'plain' : ratio > 2 ? 'warn' : 'up'}
        hint="Over 733 days the day before moved 1.72x what the market was pricing that morning. A strike one expected move away is not one day's travel away."
      />

      <MoveLadder snap={snap} />
    </>
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
function MoveLadder({ snap }: { snap: SnapshotMeta }) {
  const iv = snap.atmIv;
  if (iv === null) return null;

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
    .concat([{ label: 'by close', hours: left, last: true }]);

  const widest = move(rows[rows.length - 1]!.hours) || 1;

  return (
    <>
      <StatDivider />
      <SectionTitle hint="spot x volatility x sqrt(hours / 8760), at today's at-the-money volatility. One standard deviation: BTC stays inside about two times in three. Double it for the 19-in-20 range.">
        how far it can go from here
      </SectionTitle>

      <div className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-wide text-[var(--dim)]">
        <span>lower</span>
        <span className="font-mono normal-case tracking-normal text-muted-foreground">
          now {snap.spot.toFixed(0)}
        </span>
        <span>higher</span>
      </div>

      {rows.map((r) => {
        const m = move(r.hours);
        const w = Math.max(4, (m / widest) * 100);
        return (
          <div key={r.label} className="flex items-center gap-2 py-[3px]">
            <span className={`w-[52px] flex-none text-[11.5px] ${r.last ? 'text-foreground' : 'text-muted-foreground'}`}>
              {r.label}
            </span>
            <span className="relative h-3.5 min-w-0 flex-1 rounded bg-[var(--panel-2)]">
              <i
                className="absolute inset-y-0 rounded"
                style={{
                  left: `${50 - w / 2}%`,
                  width: `${w}%`,
                  background: r.last ? '#6cb2ff55' : '#6cb2ff2e',
                }}
              />
              <i className="absolute inset-y-0 left-1/2 w-px bg-[var(--muted)]" />
            </span>
            <span className="w-[92px] flex-none text-right font-mono text-[11.5px]">
              ±${m.toFixed(0)}
              <span className="ml-1 text-[var(--dim)]">{((m / snap.spot) * 100).toFixed(2)}%</span>
            </span>
          </div>
        );
      })}

      <div className="mt-1 flex justify-between font-mono text-[11px] text-[var(--dim)]">
        <span>{(snap.spot - widest).toFixed(0)}</span>
        <span className="text-muted-foreground">2 times in 3, by close</span>
        <span>{(snap.spot + widest).toFixed(0)}</span>
      </div>

      <Note>Which way is not shown because it cannot be known. Only how far.</Note>
    </>
  );
}

