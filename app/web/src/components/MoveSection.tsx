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
    </>
  );
}
