import type { MarketRead, SnapshotMeta } from '../types';
import { Card, CardTitle, Note } from './ui/card';
import { Stat, StatDivider } from './ui/stat';

const money = (v: number | null) =>
  v === null ? '—' : (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(0);

/** What BTC has actually done, next to what the market says it will do. */
export function MovePanel({ market, snap }: { market: MarketRead; snap: SnapshotMeta }) {
  const last24 = market.moves.find((m) => m.hours === 24);
  const em = snap.expectedMove;
  const ratio = em && em > 0 && last24?.rangeUsd ? last24.rangeUsd / em : null;

  return (
    <Card>
      <CardTitle>How far it has moved</CardTitle>

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
            {market.moves.map((m) => (
              <tr key={m.label} className="border-b border-[#ffffff08]">
                <td className="px-1 py-[3px] text-left font-sans text-muted-foreground">{m.label}</td>
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
            ))}
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
      <Stat label="market expects" value={em === null ? '—' : `±$${em.toFixed(0)}`} />
      <Stat
        label="yesterday vs that"
        value={ratio === null ? '—' : `${ratio.toFixed(2)}×`}
        tone={ratio === null ? 'plain' : ratio > 2 ? 'warn' : 'up'}
      />

      <Note>
        Over 733 days, the day before moved <b>1.72×</b> what the market was pricing
        that morning. A strike one expected move away is not one day's travel away —
        BTC covers that distance often.
      </Note>
      <Note tone="dim">
        Background only. Skipping days when this ran hot was tested and thrown out:
        it looked great in 2026 and lost money in 2024.
      </Note>
    </Card>
  );
}
