import type { Leg, SideRecommendation } from '@/types/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Badge } from '@/components/ui/badge';
import { Note } from '@/components/ui/card';
import { signedUsd, strike as fmtStrike } from '@/lib/format';
import { topByEv, otmPct, failing } from '@/lib/ev-view';

/**
 * The strikes with the richest expected value, ranked, against what the tested
 * engine picked.
 *
 * The two often disagree, and that disagreement is the point of the card. The
 * engine picks on rules that survived 2024, 2025 and 2026 separately; this list
 * ranks on arithmetic that has never been through that screen. Where they
 * differ the engine is the one to follow, and the row says so rather than
 * leaving a reader to infer it from two numbers.
 *
 * A table, because it is read *down* a column — five expected values compared
 * against each other — rather than row by row.
 *
 * One thing deliberately not copied from the reference this was drawn from:
 * calls stay green and puts stay red, as they are on the board directly above.
 * Colouring CE red here would have the two disagree about the same contract on
 * one screen.
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
          No strike clears the rules right now. The Signal column on the board says which
          rule each one is failing.
        </p>
      ) : (
        <div className="scroll evtable-wrap">
          <table className="evtable">
            <thead>
              <tr>
                <th className="r">#</th>
                <th>Strike</th>
                <th>Type</th>
                <th className="r">Prob</th>
                <th className="r">Out</th>
                <th className="r">Premium</th>
                <th className="r">Score</th>
                <th className="r">EV</th>
                {onSell && <th aria-label="action" />}
              </tr>
            </thead>
            <tbody>
              {ranked.map((l, i) => {
                const key = `${l.cp}${l.strike}`;
                const zero = l.zero?.adjusted ?? null;
                const dist = otmPct(l.strike, spot);
                return (
                  <tr key={key} className={picked.has(key) ? 'picked' : undefined}>
                    <td className="r rank">{i + 1}</td>
                    <td className="k">
                      {onInspect ? (
                        <button
                          type="button"
                          onClick={() => onInspect(l)}
                          aria-label={`inspect ${l.cp === 'C' ? 'call' : 'put'} ${l.strike}`}
                        >
                          {fmtStrike(l.strike)}
                        </button>
                      ) : (
                        fmtStrike(l.strike)
                      )}
                      {picked.has(key) && <span className="tag ok">pick</span>}
                      {l.ev.signal === 'watch' && (
                        <span className="tag warn" title={failing(l).map((c) => c.text).join(' ')}>
                          thin
                        </span>
                      )}
                    </td>
                    <td className={l.cp === 'C' ? 'ce' : 'pe'}>{l.cp === 'C' ? 'CE' : 'PE'}</td>
                    <td className="r">{zero === null ? '—' : `${(zero * 100).toFixed(1)}%`}</td>
                    <td className="r dim">{dist === null ? '—' : `${dist.toFixed(1)}%`}</td>
                    <td className="r">{l.sellPrice === null ? '—' : l.sellPrice.toFixed(2)}</td>
                    <td className={`sc score-${
                      (l.ev.score ?? 0) >= 80 ? 'strong'
                        : (l.ev.score ?? 0) >= 65 ? 'good'
                          : (l.ev.score ?? 0) >= 50 ? 'mid' : 'weak'
                    }`}>
                      <span className="scorebar" aria-hidden>
                        <i style={{ width: `${l.ev.score ?? 0}%` }} />
                      </span>
                      <b>{l.ev.score ?? '—'}</b>
                    </td>
                    <td className={`r ev ${l.ev.evUsd! >= 0 ? 'up' : 'down'}`}>
                      {signedUsd(l.ev.evUsd)}
                    </td>
                    {onSell && (
                      <td className="r">
                        <button type="button" className="ev-sell" onClick={() => onSell(l)}>
                          Sell
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Note>
        <b>EV</b> is the credit less the average payout of strikes like this one, after
        Delta’s charges, at the lots the board is set to. <b>Prob</b> is the chance it expires
        worthless, <b>Out</b> how far the strike sits from the price, and <b>Score</b> how the
        strike ranks against the rest of this board. A strike marked{' '}
        <b>thin</b> passes every rule about the bet and fails one about the fill — usually that
        almost none of its open interest traded today, which is ordinary this far out. Tap a
        strike for the full list. This is arithmetic on one strike, not a rule tested across
        years: where it and “What to sell” disagree, “What to sell” is the one that was
        measured.
      </Note>
    </CollapsibleCard>
  );
}
