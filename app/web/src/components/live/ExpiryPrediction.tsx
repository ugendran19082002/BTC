import type { ExpiryPrediction as Prediction } from '@/types/live';
import { Card, Row, Nothing, Provenance, usd0, pct0, TONE_TEXT } from './parts';
import { cn } from '@/lib/utils';

/**
 * Where this contract most probably settles, and what it would reach on the way.
 *
 * The headline is two numbers from two different places, and they are kept
 * visibly apart because merging them is how a screen ends up quoting a figure
 * nobody can source:
 *
 *  - **the range** is measured — the 68th-percentile move actually observed over
 *    this many hours, across 105,119 windows
 *  - **the percentage** is modelled — Black–Scholes at the board's own ATM IV
 *
 * The split bar underneath is below / inside / above, and the three add to one
 * so a reader can check them. The ladder is symmetric by construction: the
 * measured table gives no direction at any horizon, so drawing one rung longer
 * than its mirror would be inventing the only thing the data refuses to give.
 *
 * Touch odds, not finish odds. A strike that is touched has already cost a
 * short-seller their evening even when it settles out, and it is always the
 * larger of the two.
 */
export function ExpiryPredictionCard({ prediction, id }: { prediction: Prediction | null; id?: string }) {
  if (!prediction) {
    return (
      <Card id={id} title="Expiry prediction">
        <Nothing>No measured horizons are loaded, so no range can be drawn.</Nothing>
      </Card>
    );
  }

  const { band, targets } = prediction;
  const ups = targets.filter((t) => t.side === 'UP');
  const downs = targets.filter((t) => t.side === 'DOWN');
  const h = Math.floor(prediction.hoursToExpiry);
  const m = Math.round((prediction.hoursToExpiry - h) * 60);

  return (
    <Card
      id={id}
      title="Expiry prediction"
      hint="The measured range this contract most probably settles in, and the ladder to it."
      right={<span className="font-mono">{h}h {String(m).padStart(2, '0')}m left</span>}
    >
      <div className="text-[11px] text-muted-foreground">
        Most probable range at expiry
        <Provenance
          kind={prediction.bandMeasured ? 'measured' : 'modelled'}
          note={prediction.note}
        />
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <b className="font-mono text-[19px]">{usd0(band.low)} – {usd0(band.high)}</b>
        {band.pInside !== null && (
          <span className="text-[12px] text-muted-foreground">
            ({pct0(band.pInside)} probability<span className="ml-1 opacity-70">modelled</span>)
          </span>
        )}
      </div>

      {/* Below · inside · above. They add to one; a reader will check. */}
      {band.pInside !== null && band.pBelow !== null && band.pAbove !== null && (
        <>
          <div className="mt-2 flex h-5 overflow-hidden rounded" role="img"
            aria-label={`below ${pct0(band.pBelow)}, inside ${pct0(band.pInside)}, above ${pct0(band.pAbove)}`}>
            <span className="flex items-center justify-center bg-[var(--down)]/25 text-[10px] text-[var(--down)]"
              style={{ width: `${band.pBelow * 100}%` }}>{pct0(band.pBelow)}</span>
            <span className="flex items-center justify-center bg-[var(--up)]/25 text-[10px] text-[var(--up)]"
              style={{ width: `${band.pInside * 100}%` }}>{pct0(band.pInside)}</span>
            <span className="flex items-center justify-center bg-[var(--down)]/25 text-[10px] text-[var(--down)]"
              style={{ width: `${band.pAbove * 100}%` }}>{pct0(band.pAbove)}</span>
          </div>
          <div className="mt-0.5 flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>&lt; {usd0(band.low)}</span>
            <span>{usd0(band.low)} – {usd0(band.high)}</span>
            <span>&gt; {usd0(band.high)}</span>
          </div>
        </>
      )}

      <div className="mt-3 text-[11px] text-muted-foreground">
        Expiry targets <span className="opacity-70">(from {usd0(prediction.spot)})</span>
      </div>
      <div className="mt-1 grid gap-3 sm:grid-cols-2">
        {[{ side: 'UP' as const, rows: ups }, { side: 'DOWN' as const, rows: downs }].map(({ side, rows }) => (
          <div key={side}>
            {rows.map((t) => (
              <Row
                key={`${t.side}${t.label}`}
                label={(
                  <span className={side === 'UP' ? TONE_TEXT.up : TONE_TEXT.down}>
                    {side === 'UP' ? '↑' : '↓'} {t.label}{' '}
                    <span className="text-muted-foreground opacity-70">{t.from}</span>
                  </span>
                )}
                value={(
                  <>
                    {usd0(t.price)}
                    <span className={cn('ml-1.5', side === 'UP' ? TONE_TEXT.up : TONE_TEXT.down)}>
                      {t.movePct > 0 ? '+' : ''}{t.movePct.toFixed(2)}%
                    </span>
                    {t.pTouch !== null && (
                      <span className="ml-2 text-muted-foreground">{pct0(t.pTouch)}</span>
                    )}
                  </>
                )}
                tone="plain"
                hint={`${t.from} measured move. ${t.pTouch === null ? 'No IV, so no touch odds.' : `${pct0(t.pTouch)} chance of being touched before settlement — always higher than the chance of finishing through.`}`}
              />
            ))}
          </div>
        ))}
      </div>

      <p className={cn('mt-2 text-[11px] leading-snug', TONE_TEXT.dim)}>
        The last column is the chance of being <b>touched</b>, not of finishing through — it is the one that matters to a
        seller, and it is always the larger of the two. The ladder is symmetric because the measured table gives no
        direction at any horizon.
      </p>
    </Card>
  );
}
