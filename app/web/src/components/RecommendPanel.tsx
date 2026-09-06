import type { MarketRead, Recommendation } from '../types';
import { Card, CardTitle, Note } from './ui/card';
import { Stat, StatDivider } from './ui/stat';
import { Badge } from './ui/badge';

const pct = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? '—' : (v * 100).toFixed(d) + '%';

/** Green above 97, amber 90–97, red below. The bands the data splits on. */
function tone(p: number | null) {
  if (p === null) return 'dim' as const;
  if (p >= 0.97) return 'up' as const;
  if (p >= 0.9) return 'warn' as const;
  return 'down' as const;
}

/**
 * What to sell, in as few words as possible.
 *
 * The big number is the one that matters: how often strikes like this one
 * actually expired worthless. Everything below it is the working.
 */
export function RecommendPanel({
  rec,
  market,
  minPremium,
  usdinr,
}: {
  rec: Recommendation;
  market: MarketRead | null;
  minPremium: number;
  usdinr: number;
}) {
  if (!rec.ok) {
    return (
      <Card className="lg:col-span-2">
        <CardTitle>What to sell</CardTitle>
        <p className="m-0 text-[13.5px] text-foreground">{rec.why}</p>
        <Note>
          Sitting out is a decision too. The days with nothing cheap on the board
          were often the days that moved.
        </Note>
      </Card>
    );
  }

  const naked = rec.totalMaxLossUsd === null;

  return (
    <Card className="lg:col-span-2">
      <CardTitle right={<Badge tone="neutral">premium ≥ ${minPremium}</Badge>}>
        What to sell
      </CardTitle>

      {rec.sides.map((s) => (
        <div key={s.side} className="mb-2.5 rounded-md border border-border bg-[var(--bg)] p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[15px]">
            <span className={s.side === 'CE' ? 'text-[var(--ce)]' : 'text-[var(--pe)]'}>
              {s.side}
            </span>
            <b>{s.leg.strike.toLocaleString()}</b>
            <span className="text-[var(--dim)]">×{s.lots} lots</span>
            <span className="ml-auto">@ {s.price.toFixed(2)}</span>
          </div>
          {s.hedgeOrder && (
            <div className="mt-1 font-mono text-[12.5px] text-muted-foreground">{s.hedgeOrder}</div>
          )}

          <div className="mt-2.5 flex items-center gap-3">
            <span
              className={`flex-none font-mono text-[26px] font-semibold leading-none ${
                tone(s.zeroChance) === 'up' ? 'text-[var(--up)]'
                : tone(s.zeroChance) === 'warn' ? 'text-[var(--warn)]'
                : tone(s.zeroChance) === 'down' ? 'text-[var(--down)]'
                : 'text-muted-foreground'
              }`}
            >
              {pct(s.zeroChance, 2)}
            </span>
            <span className="text-[11.5px] leading-[1.5] text-muted-foreground">
              of strikes like this one expired worthless
              <br />
              <span className="text-[var(--dim)]">
                {s.sample ? `${s.sample.toLocaleString()} of them, across 733 days` : 'no history for this one'}
              </span>
              {s.leg.zero && !s.leg.zero.comparableHorizon && (
                <>
                  <br />
                  <span className="text-[var(--warn)]">
                    those were 12-hour trades — this contract runs longer, so treat it as a guide
                  </span>
                </>
              )}
            </span>
          </div>

          <StatDivider />
          <Stat
            label="ends out of the money"
            value={pct(s.pExpireWorthless, 2)}
            tone={tone(s.pExpireWorthless)}
            hint="What the maths model says. N(d2), not delta."
          />
          <Stat
            label="ever touches your strike"
            value={pct(s.pTouch, 1)}
            tone={s.pTouch !== null && s.pTouch > 0.2 ? 'warn' : 'plain'}
            hint="It can cross and come back. Still a win if it ends the right side."
          />
          <Stat
            label="premium drops to near zero first"
            value={pct(s.pNearZero, 1)}
            hint="Simulated. This is when you could close early instead of waiting."
          />
          <Stat
            label="how far the strike is"
            value={`${s.leg.distancePct >= 0 ? '+' : ''}${s.leg.distancePct.toFixed(2)}%`}
            tone="dim"
          />
          <Stat label="break-even" value={s.breakeven.toFixed(0)} tone="dim" />
          <Stat
            label="most you can lose here"
            value={s.maxLoss === null ? 'no limit' : `$${s.maxLoss.toFixed(4)}`}
            tone={s.maxLoss === null ? 'down' : 'warn'}
          />
        </div>
      ))}

      <StatDivider />
      <Stat
        label="lots"
        value={`${Math.round(rec.split.ce * 100)}% calls · ${Math.round(rec.split.pe * 100)}% puts`}
      />
      <Stat
        label="you keep if both expire worthless"
        value={`$${rec.totalCreditUsd.toFixed(4)} · ₹${rec.totalCreditInr.toFixed(2)}`}
        tone="up"
      />
      <Stat
        label="chance both expire worthless"
        value={pct(rec.bothZeroChance, 1)}
        tone={tone(rec.bothZeroChance)}
      />
      <Stat
        label="most you can lose"
        value={naked ? 'no limit — nothing bought to cap it' : `$${rec.totalMaxLossUsd!.toFixed(4)} · ₹${(rec.totalMaxLossUsd! * usdinr).toFixed(2)}`}
        tone="down"
      />
      {!naked && (
        <Stat
          label="reward ÷ risk"
          value={rec.rewardToRisk === null ? '—' : rec.rewardToRisk.toFixed(3)}
          tone={rec.rewardToRisk !== null && rec.rewardToRisk < 0.05 ? 'warn' : 'plain'}
        />
      )}
      <Stat
        label="margin it ties up"
        value={`$${rec.marginUsd.toFixed(2)} · ₹${rec.marginInr.toFixed(0)}`}
        tone="dim"
      />
      {rec.expectedProfitUsd !== null ? (
        <>
          <Stat
            label="expected profit"
            value={`$${rec.expectedProfitUsd.toFixed(4)} · ₹${rec.expectedProfitInr!.toFixed(2)}`}
            tone={rec.expectedProfitUsd >= 0 ? 'up' : 'down'}
            hint="Credit × chance it works, minus the loss × chance it does not."
          />
          <Stat
            label="return on margin"
            value={rec.returnOnMarginPct === null ? '—' : `${rec.returnOnMarginPct.toFixed(2)}%`}
            tone={
              rec.returnOnMarginPct !== null && rec.returnOnMarginPct >= 0 ? 'up' : 'down'
            }
          />
        </>
      ) : (
        <Stat
          label="expected profit"
          value="cannot be stated"
          tone="warn"
          hint="With no hedge the loss has no ceiling, so an average cannot be worked out."
        />
      )}

      {naked && (
        <Note tone="warn">
          Nothing is bought to cap the downside. If BTC runs past your strike, the
          loss keeps growing with it. Set a hedge gap above zero to cap it — but
          read the next line first.
        </Note>
      )}
      {!naked && rec.rewardToRisk !== null && rec.rewardToRisk < 0.05 && (
        <Note tone="warn">
          The strike you buy costs nearly as much as the one you sell, so the hedge
          eats the premium. That is why the tested version runs without one and
          keeps risk small by trading fewer lots instead.
        </Note>
      )}

      <Note>{rec.splitReason}</Note>

      <details className="mt-1.5">
        <summary className="cursor-pointer text-[11.5px] text-[var(--dim)] hover:text-muted-foreground">
          why 30/70 and not something calculated?
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-[var(--dim)]">
                <th className="py-1 pr-2 text-left font-normal">tried</th>
                <th className="px-1 py-1 text-right font-normal">profit factor</th>
                <th className="px-1 py-1 text-right font-normal">worst day</th>
                <th className="px-1 py-1 text-right font-normal">return ÷ drawdown</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rec.splitAlternatives.map((a) => (
                <tr key={a.name} className={a.chosen ? 'text-[var(--up)]' : 'text-muted-foreground'}>
                  <td className="py-[3px] pr-2 text-left font-sans">
                    {a.name}{a.chosen && ' ←'}
                  </td>
                  <td className="px-1 py-[3px] text-right">{a.profitFactor.toFixed(2)}</td>
                  <td className="px-1 py-[3px] text-right">−${Math.abs(a.worstDayUsd).toFixed(2)}</td>
                  <td className="px-1 py-[3px] text-right">{a.returnOverDrawdown.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Note tone="dim">
            The direction is worked out live from the 24-hour move and the daily
            trend. Only the size of the tilt is fixed, and it was picked from a wide
            flat region — 60/40 through 90/10 all beat an even split, so it is not
            balanced on a knife edge. Weighting by each side's measured edge made
            more money and took a worst day nearly twice as large, which is the
            trade nobody wants.
          </Note>
        </div>
      </details>

      {market && (
        <Note tone="dim">
          Market now: {market.regime}
          {market.return24h !== null && `, ${market.return24h >= 0 ? 'up' : 'down'} ${Math.abs(market.return24h).toFixed(2)}% today`}.
          {' '}{market.timeframes.map((t) => `${t.tf} ${t.label}`).join(' · ')}.
        </Note>
      )}

      <Note tone="dim">
        Nothing here is a sure thing. The safest strikes in two years still failed
        about 1 day in 240 — and those were the expensive days. Pick a size you can
        take that loss on.
      </Note>
    </Card>
  );
}
