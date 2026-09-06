import { useState } from 'react';
import type { Forecast, ForecastRow, SideRecommendation } from '../types';
import { Card, CardTitle, Note } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const money = (v: number) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(0);

/**
 * How far BTC could move, drawn rather than tabulated.
 *
 * Each row is one horizon. The bar is centred on the current price: the solid
 * part is where it lands two times in three, the faint part nineteen times in
 * twenty. The strikes you are being told to sell are drawn on the same scale,
 * which is the whole point — a strike inside the faint band is a strike the
 * market reaches one day in twenty.
 *
 * Deliberately not a direction chart. Over 105,119 windows the odds of
 * finishing higher never left 48-52% at any horizon, so the bars are symmetric
 * and the measured figure is shown underneath instead of being dressed up.
 */
export function ForecastPanel({
  forecast: f,
  sides,
}: {
  forecast: Forecast;
  sides: SideRecommendation[];
}) {
  const [showTable, setShowTable] = useState(false);

  // scale the chart to the widest band plus any strike, so nothing falls off
  const widestPct = Math.max(...f.rows.map((r) => r.outerPct));
  const strikePcts = sides.map((s) => Math.abs((s.leg.strike - f.spot) / f.spot) * 100);
  const halfSpan = Math.max(widestPct, ...strikePcts, 0.5) * 1.12;
  const x = (pct: number) => 50 + (pct / halfSpan) * 50;

  return (
    <Card className="lg:col-span-2">
      <CardTitle
        right={
          <span className="flex items-center gap-2">
            <Badge tone="neutral">{f.sampleDays} days measured</Badge>
            <Button size="sm" variant="ghost" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'chart' : 'numbers'}
            </Button>
          </span>
        }
      >
        How far it could move
      </CardTitle>

      {!showTable ? (
        <div className="mt-1">
          <div className="mb-1 flex items-baseline justify-between px-1 text-[10px] uppercase tracking-wide text-[var(--dim)]">
            <span>← down</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {Math.round(f.spot).toLocaleString()}
            </span>
            <span>up →</span>
          </div>

          {f.rows.map((r) => {
            const down = -(f.spot * r.likelyPct) / 100;
            const up = (f.spot * r.likelyPct) / 100;
            return (
              <div key={r.label} className={`py-[5px] ${r.isExpiry ? 'rounded bg-[#58a6ff10]' : ''}`}>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-[86px] flex-none text-[11.5px] ${
                      r.isExpiry ? 'font-semibold text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {r.label}
                  </span>

                  <div className="relative h-[18px] flex-1">
                    {/* nineteen times in twenty */}
                    <div
                      className="absolute top-[5px] h-[8px] rounded-sm bg-[#d2992226]"
                      style={{ left: `${x(-r.outerPct)}%`, width: `${x(r.outerPct) - x(-r.outerPct)}%` }}
                    />
                    {/* two times in three */}
                    <div
                      className="absolute top-[3px] h-[12px] rounded-sm bg-[#58a6ff4d]"
                      style={{ left: `${x(-r.likelyPct)}%`, width: `${x(r.likelyPct) - x(-r.likelyPct)}%` }}
                    />
                    {/* what the option market is pricing over the same stretch */}
                    {r.impliedPct !== null && (
                      <>
                        <span className="absolute top-[1px] h-[16px] w-px bg-[var(--up)]"
                          style={{ left: `${x(-r.impliedPct)}%` }} />
                        <span className="absolute top-[1px] h-[16px] w-px bg-[var(--up)]"
                          style={{ left: `${x(r.impliedPct)}%` }} />
                      </>
                    )}
                    {/* now */}
                    <span className="absolute top-0 h-[18px] w-px bg-[var(--text)]" style={{ left: '50%' }} />
                    {/* the strikes you would be selling */}
                    {sides.map((s) => {
                      const pct = ((s.leg.strike - f.spot) / f.spot) * 100;
                      if (Math.abs(pct) > halfSpan) return null;
                      return (
                        <span
                          key={s.side}
                          title={`${s.side} ${s.leg.strike.toLocaleString()}`}
                          className={`absolute top-[-1px] h-[20px] w-[2px] ${
                            s.side === 'CE' ? 'bg-[var(--ce)]' : 'bg-[var(--pe)]'
                          }`}
                          style={{ left: `${x(pct)}%` }}
                        />
                      );
                    })}
                  </div>

                  <span className="w-[152px] flex-none text-right font-mono text-[11px] text-muted-foreground">
                    {money(down)} / {money(up)}
                    <span className="ml-1 text-[var(--dim)]">±{r.likelyPct.toFixed(2)}%</span>
                  </span>
                </div>
              </div>
            );
          })}

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-[var(--dim)]">
            <span><i className="mr-1 inline-block h-[8px] w-[14px] rounded-sm bg-[#58a6ff4d] align-middle" />2 times in 3</span>
            <span><i className="mr-1 inline-block h-[8px] w-[14px] rounded-sm bg-[#d2992226] align-middle" />19 times in 20</span>
            <span><i className="mr-1 inline-block h-[10px] w-px bg-[var(--up)] align-middle" /> what the market is pricing</span>
            {sides.map((s) => (
              <span key={s.side}>
                <i className={`mr-1 inline-block h-[10px] w-[2px] align-middle ${s.side === 'CE' ? 'bg-[var(--ce)]' : 'bg-[var(--pe)]'}`} />
                your {s.side} {s.leg.strike.toLocaleString()}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full text-[11.8px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-[var(--dim)]">
                <th className="px-1.5 py-1 text-left font-normal">next</th>
                <th className="px-1.5 py-1 text-right font-normal">usually</th>
                <th className="px-1.5 py-1 text-right font-normal">2 in 3</th>
                <th className="px-1.5 py-1 text-right font-normal">19 in 20</th>
                <th className="px-1.5 py-1 text-right font-normal">worst seen</th>
                <th className="px-1.5 py-1 text-right font-normal">market says</th>
                <th className="px-1.5 py-1 text-right font-normal">down / up</th>
                <th className="px-1.5 py-1 text-right font-normal">up</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {f.rows.map((r: ForecastRow) => (
                <tr key={r.label} className={`border-b border-[#ffffff08] ${r.isExpiry ? 'bg-[#58a6ff14]' : ''}`}>
                  <td className="px-1.5 py-[3px] text-left font-sans">
                    {r.isExpiry ? <b>{r.label}</b> : <span className="text-muted-foreground">{r.label}</span>}
                  </td>
                  <td className="px-1.5 py-[3px] text-right">{r.typicalPct.toFixed(2)}%</td>
                  <td className="px-1.5 py-[3px] text-right">{r.likelyPct.toFixed(2)}%</td>
                  <td className="px-1.5 py-[3px] text-right text-[var(--warn)]">{r.outerPct.toFixed(2)}%</td>
                  <td className="px-1.5 py-[3px] text-right text-[var(--down)]">{r.worstPct.toFixed(1)}%</td>
                  <td className="px-1.5 py-[3px] text-right text-muted-foreground">
                    {r.impliedPct === null ? '—' : `${r.impliedPct.toFixed(2)}%`}
                  </td>
                  <td className="px-1.5 py-[3px] text-right text-muted-foreground">
                    {Math.round(r.low).toLocaleString()} – {Math.round(r.high).toLocaleString()}
                  </td>
                  <td className="px-1.5 py-[3px] text-right text-[var(--dim)]">{(r.pUp * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Note>
        Read one row across: the blue band is where BTC lands two times in three,
        the amber band nineteen times in twenty. The green ticks are what today's
        option prices are pricing over the same stretch — when they sit inside the
        blue band, options are cheap against what BTC has actually been doing.
      </Note>

      {sides.length > 0 && (
        <Note>
          Your strikes are the coloured lines. A strike outside the amber band is one
          the market reached on fewer than one day in twenty. A strike inside it is
          one it reaches regularly.
        </Note>
      )}

      <Note tone="warn">
        Up or down is not forecast here and will not be. Across{' '}
        {f.sampleWindows.toLocaleString()} windows the chance of finishing higher never
        moved further than {f.directionEdgePts.toFixed(1)} points from a coin flip, at
        any horizon. Filtering by trend or by the last bar changed it by under a point.
        How far it can travel is knowable; which way is not.
      </Note>
    </Card>
  );
}
