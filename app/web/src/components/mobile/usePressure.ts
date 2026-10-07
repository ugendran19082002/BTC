import { getChain, getChanges, getPerp, type OptionFlowSummary } from '@/api/desk';
import type { ChainResponse, Leg, SuddenMove } from '@/types/desk';
import { usePoll } from '@/hooks/usePoll';
import { earlyWarning, type EarlyWarning } from '@/lib/overview';
import { deskLeg } from '@/lib/pressure';

/**
 * The phone's read of pressure (owner, 7 Oct 2026), once, for the Pressure screen and for Home's row of three:
 * the option tape a side at a time and the big-move early warning. From what the desk's Live screen reads --
 * the chain (`/api/chain`), the perp and its tapes (`/api/perp`), and the 15-minute changes of the desk's own
 * strike (`/api/changes`) -- worked through the same `earlyWarning`, so the phone and the desk cannot say
 * different things.
 *
 * `everyMs` is how often the chain is asked: the screen itself asks often; Home, which only wears three words
 * of it, asks half as often.
 */

const WINDOW_MIN = 60;

export type Pressure = {
  /** The chain, once it has been read; everything below is null until then. */
  chain: ChainResponse | null;
  chainError: Error | null;
  /** The option tape, CE and PE, over the last hour. Null until the perp is read, or where there is no tape. */
  flow: OptionFlowSummary | null;
  /** Whether the perp (and with it the tape) has been read at all: a tape not read yet is not a tape with no prints. */
  perpRead: boolean;
  perpError: Error | null;
  warning: EarlyWarning | null;
  /** The strike the premium and IV changes are read on: the desk's own pick, the put first. */
  leg: Leg | null;
  shock: SuddenMove | null;
};

export function usePressure(everyMs = 15_000): Pressure {
  // The desk's own defaults for the chain: the nearest expiry, twenty strikes a side.
  const chain = usePoll(() => getChain('now', 20, 15, 0, 10), everyMs);
  const data = chain.data;
  const snap = data?.snapshot ?? null;
  const perp = usePoll(() => getPerp(WINDOW_MIN, snap?.expiry ?? null), Math.round(everyMs * 2 / 3), { enabled: snap !== null, deps: [snap?.expiry] });
  const leg = data ? deskLeg(data) : null;
  const symbol = leg && snap ? `${leg.cp}-BTC-${leg.strike}-${snap.expiry}` : null;
  const changes = usePoll(() => {
    const s = data!.structure;
    return getChanges(symbol!, {
      spot: snap!.spot, mark: leg!.mark, oi: leg!.oi, iv: leg!.iv, volume: leg!.volume,
      ceOi: s.ceOi, peOi: s.peOi, callVolume: s.ceVolume, putVolume: s.peVolume, pcr: s.pcrOi, atmIv: s.atmIv,
    });
  }, everyMs * 2, { enabled: symbol !== null, deps: [symbol] });

  const w15 = changes.data?.rows.find((r) => r.minutes === 15) ?? null;
  const warning = data ? earlyWarning({
    flow: perp.data?.flow ?? null, book: perp.data?.book ?? null, oi: perp.data?.oi ?? null, funding: perp.data?.ticker?.fundingRate ?? null,
    market: data.market, outlook: data.outlook, markChange15mPct: w15?.markChangePct ?? null, atmIvChange15mPts: w15?.atmIvChangePts ?? null,
  }) : null;
  const f = perp.data?.optionFlow ?? null;
  return {
    chain: data, chainError: chain.error,
    flow: f && f.source !== 'none' ? f : null, perpRead: perp.data !== null, perpError: perp.error,
    warning, leg, shock: data?.shocks?.[0] ?? null,
  };
}
