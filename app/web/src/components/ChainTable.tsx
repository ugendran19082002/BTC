import type { Leg, SnapshotMeta } from '../types';

const n = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '·' : v.toFixed(d);

const compact = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '·';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(0);
};

/** A traded price nobody has hit in a while is not a price you can sell at. */
function Age({ min }: { min: number | null }) {
  if (min === null) return <span className="dim">—</span>;
  if (min === 0) return <span className="up">live</span>;
  if (min <= 15) return <span className="muted">{min}m</span>;
  return <span className="warn">{min}m</span>;
}

/**
 * Laid out the way the exchange lays it out — calls left, puts right, strike in
 * the middle — with bid and ask shown separately from the mark.
 *
 * The separation matters for a seller: you receive the BID, not the mark and
 * not the last trade. Reading the mark as your fill is how a backtest that
 * looks profitable turns into a live account that is not.
 */
export function ChainTable({ legs, snap }: { legs: Leg[]; snap: SnapshotMeta }) {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const at = (k: number, cp: 'C' | 'P') => legs.find((l) => l.strike === k && l.cp === cp);
  const hasBook = legs.some((l) => l.bid !== null || l.ask !== null);

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th colSpan={8} className="left ce">CALLS</th>
            <th>STRIKE</th>
            <th colSpan={8} className="left pe">PUTS</th>
          </tr>
          <tr>
            <th>OI</th><th>Vol</th><th>Age</th><th>Δ</th><th>P(OTM)</th>
            <th>IV</th><th className="bidcol">Bid</th><th>Mark</th>
            <th></th>
            <th>Mark</th><th className="bidcol">Bid</th><th>IV</th>
            <th>P(OTM)</th><th>Δ</th><th>Age</th><th>Vol</th><th>OI</th>
          </tr>
        </thead>
        <tbody>
          {strikes.map((k) => {
            const c = at(k, 'C');
            const p = at(k, 'P');
            return (
              <tr key={k} className={k === snap.atm ? 'atm' : undefined}>
                <td className="dim">{compact(c?.oi ?? null)}</td>
                <td className="dim">{compact(c?.volume ?? null)}</td>
                <td><Age min={c?.ageMin ?? null} /></td>
                <td>{n(c?.delta ?? null, 3)}</td>
                <td>{c?.pOtm != null ? (c.pOtm * 100).toFixed(0) + '%' : '·'}</td>
                <td className="dim">{c?.iv != null ? (c.iv * 100).toFixed(1) : '·'}</td>
                <td className="bidcol">{n(c?.bid ?? null)}</td>
                <td>{n(c?.mark ?? null)}</td>

                <td className="mono strikecell">
                  {k}
                  {k === snap.atm && <span className="tag">ATM</span>}
                </td>

                <td>{n(p?.mark ?? null)}</td>
                <td className="bidcol">{n(p?.bid ?? null)}</td>
                <td className="dim">{p?.iv != null ? (p.iv * 100).toFixed(1) : '·'}</td>
                <td>{p?.pOtm != null ? (p.pOtm * 100).toFixed(0) + '%' : '·'}</td>
                <td>{n(p?.delta ?? null, 3)}</td>
                <td><Age min={p?.ageMin ?? null} /></td>
                <td className="dim">{compact(p?.volume ?? null)}</td>
                <td className="dim">{compact(p?.oi ?? null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!hasBook && (
        <div className="note" style={{ padding: '8px 12px', margin: 0 }}>
          No order book on a historical snapshot — bid and ask are live-only, so the
          mark stands in as the sell estimate here.
        </div>
      )}
    </div>
  );
}
