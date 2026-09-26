import type { StrikeSafety as Safety } from '@/types/live';
import { Card, Nothing, Provenance, pct0, usd0, TONE_TEXT } from './parts';
import { cn } from '@/lib/utils';

/**
 * How safe each strike is to sell, to settlement.
 *
 * Three questions and no others:
 *
 *  - **Does it settle worthless?** The model's answer, from ATM IV.
 *  - **Is it touched on the way?** Always at least as likely as finishing
 *    through, and it is the number that costs a seller their evening even when
 *    the strike settles out. Shown next to it so the gap between them is
 *    visible, because that gap is the whole risk of a short.
 *  - **How far away is it, in measured moves?** This one needs no model at
 *    all: the distance divided by the 95th-percentile move actually observed
 *    over this horizon. Under 1.00 means price has routinely travelled that
 *    far in this much time.
 *
 * The measured column is the one to trust when they disagree, and it is sorted
 * on, because it is the only one of the three that is counted rather than
 * assumed.
 */
export function StrikeSafety({ strikes, id }: { strikes: readonly Safety[]; id?: string }) {
  if (!strikes.length) {
    return (
      <Card id={id} title="Strike safety">
        <Nothing>No strikes selected. Pick one on the chain below and it will be judged here.</Nothing>
      </Card>
    );
  }

  const sorted = [...strikes].sort((a, b) => (b.distanceInP95 ?? 0) - (a.distanceInP95 ?? 0));

  return (
    <Card
      id={id}
      title="Strike safety"
      hint="Each strike against the same measured band the settlement cone is drawn from."
      right={<span>to settlement</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[440px] border-collapse text-[12px]">
          <caption className="sr-only">Selected strikes, judged against the measured move to settlement</caption>
          <thead>
            <tr className="text-[10.5px] uppercase tracking-[0.6px] text-muted-foreground">
              <th scope="col" className="py-1 pr-2 text-left font-semibold">Strike</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold">Away</th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold" title="Distance ÷ the measured 95th-percentile move. Under 1.00 is inside what has routinely happened.">
                × P95
                <Provenance kind="measured" />
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-semibold" title="Black–Scholes, from ATM IV">
                Expires OTM
              </th>
              <th scope="col" className="py-1 text-right font-semibold" title="Chance price touches the strike at any point before settlement">
                Touched
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const safe = s.outsideMeasured95;
              return (
                <tr key={`${s.cp}${s.strike}`} className="border-t border-border/60">
                  <th scope="row" className="py-1.5 pr-2 text-left font-mono font-normal">
                    <span className={s.cp === 'C' ? TONE_TEXT.up : TONE_TEXT.down}>{s.cp === 'C' ? 'CE' : 'PE'}</span>{' '}
                    {usd0(s.strike)}
                  </th>
                  <td className="py-1.5 pr-2 text-right font-mono text-muted-foreground">{usd0(s.distanceUsd)}</td>
                  <td
                    className={cn('py-1.5 pr-2 text-right font-mono', safe ? TONE_TEXT.up : TONE_TEXT.warn)}
                    title={s.why}
                  >
                    {s.distanceInP95 === null ? '—' : `${s.distanceInP95.toFixed(2)}×`}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-mono">
                    {s.pExpireWorthless === null ? '—' : pct0(s.pExpireWorthless)}
                  </td>
                  <td className="py-1.5 text-right font-mono text-muted-foreground">
                    {s.pTouch === null ? '—' : pct0(s.pTouch)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2.5 text-[11.5px] leading-snug text-muted-foreground">
        “Touched” is always at least as likely as finishing through, and it is the one that wakes you up.
        The × P95 column is counted rather than modelled; when it and the model disagree, it is the one to believe.
      </p>
    </Card>
  );
}
