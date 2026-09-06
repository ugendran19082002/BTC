import type { OptionStructure, SnapshotMeta } from '../types';

const n0 = (v: number | null | undefined) =>
  v === null || v === undefined ? '·' : Math.round(v).toLocaleString();

/**
 * The option board's own positioning: where open interest sits, where gamma
 * concentrates, how puts are priced against calls, and whether options are rich
 * against what BTC has actually been doing.
 *
 * Description, not instruction. None of it is wired into the recommendation —
 * every one of these was tested as a rule in feature_screen.py and none
 * survived being checked year by year.
 */
export function StructurePanel({
  structure: st,
  snap,
}: {
  structure: OptionStructure;
  snap: SnapshotMeta;
}) {
  return (
    <div className="card">
      <h2>Option structure</h2>

      <div className="kv"><span>put/call OI</span>
        <span>{st.pcrOi === null ? '·' : st.pcrOi.toFixed(2)}</span></div>
      <div className="kv"><span>put/call volume</span>
        <span>{st.pcrVolume === null ? '·' : st.pcrVolume.toFixed(2)}</span></div>
      <div className="kv"><span>call OI · put OI</span>
        <span>{n0(st.ceOi)} · {n0(st.peOi)}</span></div>

      <div className="kv" style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <span>heaviest call OI</span>
        <span>{st.ceOiWall ? `${st.ceOiWall.strike.toLocaleString()} (${n0(st.ceOiWall.value)})` : '·'}</span>
      </div>
      <div className="kv"><span>heaviest put OI</span>
        <span>{st.peOiWall ? `${st.peOiWall.strike.toLocaleString()} (${n0(st.peOiWall.value)})` : '·'}</span></div>
      <div className="kv"><span>gamma concentration</span>
        <span>{st.gammaWall ? st.gammaWall.strike.toLocaleString() : '·'}</span></div>

      <div className="kv" style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
        <span>25-delta IV skew</span>
        <span className={st.ivSkewPts === null ? '' : st.ivSkewPts > 0 ? 'down' : 'up'}>
          {st.ivSkewPts === null ? '·' : `${st.ivSkewPts >= 0 ? '+' : ''}${st.ivSkewPts.toFixed(1)} pt`}
        </span>
      </div>
      <div className="kv"><span>implied − realised</span>
        <span className={st.volPremiumPts === null ? '' : st.volPremiumPts > 0 ? 'up' : 'warn'}>
          {st.volPremiumPts === null ? '·' : `${st.volPremiumPts >= 0 ? '+' : ''}${st.volPremiumPts.toFixed(1)} pt`}
        </span>
      </div>

      {st.ranges.length > 0 && (
        <>
          <div className="kv" style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <span className="dim">where the market thinks it settles</span><span />
          </div>
          {st.ranges.map((r) => (
            <div className="kv" key={r.sigma}>
              <span>{r.sigma}σ</span>
              <span>{Math.round(r.low).toLocaleString()} – {Math.round(r.high).toLocaleString()}</span>
            </div>
          ))}
        </>
      )}

      <div className="note">
        Heaviest open interest marks where positions are, not where price must
        stop. Gamma concentration is where hedging flow is densest — price often
        behaves differently around it, which is not the same as being held there.
        {st.volPremiumPts !== null && st.volPremiumPts < 0 && (
          <> Implied vol currently sits <b>below</b> what BTC has actually been doing,
          which means options are cheap relative to recent movement — the wrong
          side of the trade for a seller.</>
        )}
      </div>
      <div className="note dim">
        Spot {snap.spot.toFixed(0)} · ATM {snap.atm.toLocaleString()} ·{' '}
        {snap.atmIv === null ? '' : `${(snap.atmIv * 100).toFixed(1)}% IV`}
      </div>
    </div>
  );
}
