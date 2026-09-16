import type { Snapshot } from '../market/chain.js';
import { scoreLegs } from './score.js';
import { attachEv } from './ev.js';
import { findHedge, recommend } from './recommend.js';
import { bestTrade, type BestTrade } from './best-trade.js';
import type { MarketRead } from '../market/moves.js';

/**
 * The best pick from a board, the one way both callers work it out.
 *
 * The chain route and the watcher that sends "the best pick changed" both
 * need it, and if they built it separately the phone and the screen would
 * eventually name different strikes for the same board. So there is one
 * function, and both call it.
 */
export function bestTradeNow(i: {
  snap: Snapshot;
  market: MarketRead | null;
  lots: number;
  hedgeGap: number;
  minPremiumUsd: number;
}): BestTrade {
  const scored = scoreLegs(i.snap);
  const rec = recommend(i.snap, scored, i.market, i.minPremiumUsd, i.lots, i.hedgeGap, 'premium', 0.98);
  return bestTrade({
    legs: attachEv(scored, {
      spot: i.snap.spot, lots: i.lots, minPremium: i.minPremiumUsd,
      atmIv: i.snap.atmIv, expectedMove: i.snap.expectedMove,
    }),
    snap: i.snap,
    lots: i.lots,
    minPremiumUsd: i.minPremiumUsd,
    enginePicks: rec.sides.map((x) => ({ side: x.side, strike: x.leg.strike })),
    hedgeFor: (leg) => {
      const h = findHedge(scored, leg.cp === 'C' ? 'CE' : 'PE', leg.strike, i.hedgeGap);
      return h === null ? null : { strike: h.strike, askUsd: h.price, widthUsd: h.widthUsd };
    },
  });
}
