import type { ReactNode } from 'react';
import { ChartInsight, IndicatorSummary, PatternStrip } from '@/components/desk/ChartReadout';
import { MarketState } from '@/components/desk/MarketState';
import type { MarketStateResponse, StateHistoryRow } from '@/api/desk';

/**
 * The chart and its reading, as one panel (23 Sep 2026).
 *
 * They were four cards in a column -- candles, then patterns and readings,
 * then the sentence, then the state -- each with its own border, its own
 * heading and its own patch of empty panel. Four boxes saying one thing is
 * three boxes too many: the eye has to cross a frame between the level on the
 * chart and the level in the plan, and on a phone the state card had scrolled
 * out of sight by the time you reached it.
 *
 * One card now, in the order somebody reads it: the candles, the shapes on
 * them, the numbers behind those, the sentence, then the plan. The parts are
 * still their own components -- `PriceChart`, `PatternStrip`,
 * `IndicatorSummary`, `ChartInsight`, `MarketState`, each tested on its own --
 * and this composes them and strips the inner chrome, rather than growing into
 * a fifth thing that knows all their rules.
 */
export function MarketPanel({
  chart, data, history, hitRate, tf, spot, ready = true,
}: {
  /** The price chart itself, passed in so this file never grows chart logic. */
  chart: ReactNode;
  data: MarketStateResponse | null;
  history?: StateHistoryRow[];
  hitRate?: { correct: number; graded: number };
  tf: string;
  /** BTC now, so each earlier call can say what price did after it. */
  spot?: number;
  /** False on a past date, where there is no live state to read. */
  ready?: boolean;
}) {
  return (
    <section className="bt-card bt-analysis" aria-label="Price chart and market analysis">
      <div className="bt-analysis__chart">
        {chart}

        {/* The shapes and the readings sit under the candles they were taken
            from, not beside the plan: they are how the chart was read, and the
            plan is what came of it. */}
        {ready ? (
          <>
            <div className="bt-analysis__strip">
              <PatternStrip patterns={data?.patterns.shown ?? []} />
              <IndicatorSummary items={data?.indicators.shown ?? []} />
            </div>
            {data ? <ChartInsight insight={data.state.insight} /> : null}
          </>
        ) : null}
      </div>

      {/* The analysis beside the chart, where the level on the card and the
          level on the candles can be seen at once. Under 1100px it drops below
          the chart instead, in the same reading order. */}
      {ready ? (
        <div className="bt-analysis__side">
          <MarketState
            data={data} history={history} hitRate={hitRate} spot={spot} tf={tf}
          />
        </div>
      ) : null}

    </section>
  );
}
