import type { Leg, SideRecommendation } from '@/types/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Badge } from '@/components/ui/badge';
import { Note } from '@/components/ui/card';
import { signedUsd, signedInr, usdToInr, strike as fmtStrike } from '@/lib/format';
import { topByEv, otmPct, failing } from '@/lib/ev-view';

/**
 * The strikes with the richest expected value, and what the tested engine
 * picked, side by side.
 *
 * The two often disagree, and that disagreement is the point of the card. The
 * engine picks on rules that survived 2024, 2025 and 2026 separately; this list
 * ranks on arithmetic that has never been through that screen. Where they
 * differ the engine is the one to follow — the row says so rather than leaving
 * a reader to infer it from two numbers.
 */
export function TopCandidates({
  legs,
  sides,
  spot,
  onSell,
  onInspect,
}: {
  legs: Leg[];
  /** What the desk actually recommends, so agreement and disagreement are visible. */
  sides: SideRecommendation[];
  spot: number;
  onSell?: (leg: Leg) => void;
  onInspect?: (leg: Leg) => void;
}) {
  const ranked = topByEv(legs);
  const picked = new Set(sides.map((s) => `${s.side === 'CE' ? 'C' : 'P'}${s.leg.strike}`));

  return (
    <CollapsibleCard
      id="ev-candidates"
      title="Best expected value"
      // Open. This is one of the two lists a decision is read off, and a card
      // that has to be found before it can be read is a card nobody opens.
      defaultOpen
      right={<Badge tone="neutral">For information</Badge>}
    >
      {!ranked.length ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          No strike clears every eligibility rule right now. The Signal column on the board
          says which rule each one is failing.
        </p>
      ) : (
        <ol className="ev-list">
          {ranked.map((l, i) => {
            const key = `${l.cp}${l.strike}`;
            const isPick = picked.has(key);
            const dist = otmPct(l.strike, spot);
            return (
              <li key={key} className="ev-row">
                <span className="ev-rank">{i + 1}</span>
                <button
                  type="button"
                  className="ev-strike"
                  onClick={() => onInspect?.(l)}
                  aria-label={`inspect ${l.cp === 'C' ? 'call' : 'put'} ${l.strike}`}
                >
                  <span className={l.cp === 'C' ? 'ce' : 'pe'}>{l.cp === 'C' ? 'CE' : 'PE'}</span>
                  {' '}{fmtStrike(l.strike)}
                  {isPick && <span className="tag ok">desk’s pick</span>}
                  {l.ev.signal === 'watch' && (
                    <span className="tag warn" title={failing(l).map((c) => c.text).join(' ')}>
                      thin
                    </span>
                  )}
                </button>
                <span className="ev-meta">
                  {l.zero?.adjusted != null ? `${(l.zero.adjusted * 100).toFixed(1)}% → 0` : '—'}
                  {dist !== null && <> · {dist.toFixed(1)}% out</>}
                  {l.sellPrice !== null && <> · pays ${l.sellPrice.toFixed(2)}</>}
                </span>
                <span className="ev-value">
                  <b className={l.ev.evUsd! >= 0 ? 'up' : 'down'}>{signedUsd(l.ev.evUsd)}</b>
                  <small>{signedInr(usdToInr(l.ev.evUsd))}</small>
                </span>
                {onSell && (
                  <button type="button" className="ev-sell" onClick={() => onSell(l)}>
                    Sell
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <Note>
        Expected value is the credit less the average payout of strikes like this one, after
        Delta’s charges, at the lots set above. A strike marked <b>thin</b> passes every rule
        that is about the bet and fails one that is about the fill — usually that almost none
        of its open interest traded today, which is ordinary this far out. Tap a strike for
        the full list. This is arithmetic on one strike, not a rule that has been tested
        across years — where this list and “What to sell” disagree, “What to sell” is the one
        that was measured.
      </Note>
    </CollapsibleCard>
  );
}
