import type { Leg, SnapshotMeta } from '../types';

const n = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined ? '·' : v.toFixed(d);

/** A traded price nobody has hit in a while is not a price you can sell at. */
function Age({ min }: { min: number | null }) {
  if (min === null) return <span className="dim">—</span>;
  if (min === 0) return <span className="up">live</span>;
  if (min <= 15) return <span className="muted">{min}m</span>;
  return <span className="warn">{min}m</span>;
}

export function ChainTable({ legs, snap }: { legs: Leg[]; snap: SnapshotMeta }) {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const at = (k: number, cp: 'C' | 'P') => legs.find((l) => l.strike === k && l.cp === cp);

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th colSpan={6} className="left ce">CALLS</th>
            <th>STRIKE</th>
            <th colSpan={6} className="left pe">PUTS</th>
          </tr>
          <tr>
            <th>LTP</th><th>Mark</th><th>Age</th><th>IV</th><th>Δ</th><th>P(OTM)</th>
            <th></th>
            <th>P(OTM)</th><th>Δ</th><th>IV</th><th>Age</th><th>Mark</th><th>LTP</th>
          </tr>
        </thead>
        <tbody>
          {strikes.map((k) => {
            const c = at(k, 'C');
            const p = at(k, 'P');
            return (
              <tr key={k} className={k === snap.atm ? 'atm' : undefined}>
                <td>{n(c?.ltp ?? null)}</td>
                <td>{n(c?.mark ?? null)}</td>
                <td><Age min={c?.ageMin ?? null} /></td>
                <td>{c?.iv != null ? (c.iv * 100).toFixed(1) : '·'}</td>
                <td>{n(c?.delta ?? null, 3)}</td>
                <td>{c?.pOtm != null ? (c.pOtm * 100).toFixed(0) + '%' : '·'}</td>
                <td className="mono">
                  {k}
                  {k === snap.atm && <span className="tag">ATM</span>}
                </td>
                <td>{p?.pOtm != null ? (p.pOtm * 100).toFixed(0) + '%' : '·'}</td>
                <td>{n(p?.delta ?? null, 3)}</td>
                <td>{p?.iv != null ? (p.iv * 100).toFixed(1) : '·'}</td>
                <td><Age min={p?.ageMin ?? null} /></td>
                <td>{n(p?.mark ?? null)}</td>
                <td>{n(p?.ltp ?? null)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
