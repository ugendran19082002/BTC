import type { OptionStructure, SnapshotMeta } from '../types';
import { Card, CardTitle, Note } from './ui/card';
import { Stat, StatDivider } from './ui/stat';

const n0 = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : Math.round(v).toLocaleString();

/**
 * Where the money already sits on this board.
 *
 * Description only. Every one of these was tried as a trading rule and none of
 * them held up across all three years, so none of them touch the recommendation.
 */
export function StructurePanel({
  structure: st,
  snap,
}: {
  structure: OptionStructure;
  snap: SnapshotMeta;
}) {
  const cheapOptions = st.volPremiumPts !== null && st.volPremiumPts < 0;

  return (
    <Card>
      <CardTitle>Where the money sits</CardTitle>

      <Stat
        label="puts vs calls, open positions"
        value={st.pcrOi === null ? '—' : st.pcrOi.toFixed(2)}
        hint="Above 1 means more puts are open than calls."
      />
      <Stat
        label="puts vs calls, traded today"
        value={st.pcrVolume === null ? '—' : st.pcrVolume.toFixed(2)}
      />
      <Stat label="open: calls · puts" value={`${n0(st.ceOi)} · ${n0(st.peOi)}`} tone="dim" />

      <StatDivider />
      <Stat
        label="most calls sold at"
        value={st.ceOiWall ? st.ceOiWall.strike.toLocaleString() : '—'}
      />
      <Stat
        label="most puts sold at"
        value={st.peOiWall ? st.peOiWall.strike.toLocaleString() : '—'}
      />
      <Stat
        label="price reacts most around"
        value={st.gammaWall ? st.gammaWall.strike.toLocaleString() : '—'}
        hint="Where hedging flow is heaviest."
      />

      <StatDivider />
      <Stat
        label="puts pricier than calls by"
        value={st.ivSkewPts === null ? '—' : `${st.ivSkewPts >= 0 ? '+' : ''}${st.ivSkewPts.toFixed(1)} pt`}
        tone={st.ivSkewPts === null ? 'plain' : st.ivSkewPts > 0 ? 'down' : 'up'}
        hint="Positive means the market is paying up for downside protection."
      />
      <Stat
        label="options vs what BTC actually does"
        value={st.volPremiumPts === null ? '—' : `${st.volPremiumPts >= 0 ? '+' : ''}${st.volPremiumPts.toFixed(1)} pt`}
        tone={cheapOptions ? 'warn' : 'up'}
        hint="Implied volatility minus realised. Positive is good for a seller."
      />

      {st.ranges.length > 0 && (
        <>
          <StatDivider />
          {st.ranges.map((r) => (
            <Stat
              key={r.sigma}
              label={r.sigma === 1 ? 'likely range' : r.sigma === 2 ? 'wider range' : 'extreme range'}
              value={`${Math.round(r.low).toLocaleString()} – ${Math.round(r.high).toLocaleString()}`}
              tone={r.sigma === 1 ? 'plain' : 'dim'}
            />
          ))}
        </>
      )}

      {cheapOptions ? (
        <Note tone="warn">
          Options are priced cheaper than BTC has actually been moving. That is the
          wrong side of the trade for a seller — you are being paid less than the
          risk you are taking.
        </Note>
      ) : (
        <Note>
          Options are priced above what BTC has been doing, which is the side a
          seller wants to be on.
        </Note>
      )}
      <Note tone="dim">
        Heavy open interest shows where people are positioned, not where price has
        to stop. None of this is used to pick the trade.
      </Note>
      <Note tone="dim">
        Spot {snap.spot.toFixed(0)} · at-the-money {snap.atm.toLocaleString()} ·{' '}
        strikes {snap.step} apart
      </Note>
    </Card>
  );
}
