import { getChain, getChanges, getPerp, type ChangesResponse, type OptionFlowSummary } from '@/api/desk';
import type { ChainResponse, Leg, SuddenMove } from '@/types/desk';
import { usePoll } from '@/hooks/usePoll';
import { usePersisted } from '@/hooks/usePersisted';
import { earlyWarning, type EarlyWarning } from '@/lib/overview';
import { deskLeg } from '@/lib/pressure';

/**
 * The phone's read of pressure (owner, 7 Oct 2026), once, for the Pressure screen and for Home's row of three:
 * the option tape a side at a time and the big-move early warning. From what the desk's Live screen reads --
 * the chain (`/api/chain`), the perp and its tapes (`/api/perp`), and the 15-minute changes of the desk's own
 * strike (`/api/changes`) -- worked through the same `earlyWarning`, so the phone and the desk cannot say
 * different things.
 *
 * `everyMs` is how often the chain is asked: the screen itself asks often; Home, which wears a card a reading,
 * asks half as often. `window` is how far back the tapes are summed.
 */

/** The windows the tapes are summed over: the last five minutes out to four hours. An hour unless one is picked. */
export const PRESSURE_WINDOWS = [
  { key: '5', label: '5m', spoken: '5 minutes' }, { key: '15', label: '15m', spoken: '15 minutes' },
  { key: '60', label: '1h', spoken: '1 hour' }, { key: '240', label: '4h', spoken: '4 hours' },
] as const;
export type PressureWindow = (typeof PRESSURE_WINDOWS)[number]['key'];

/** The window picked, remembered, and shared by Home's cards and the Pressure screen so the two say the same thing. */
export function usePressureWindow(): [PressureWindow, (w: PressureWindow) => void] {
  const [w, setW] = usePersisted<PressureWindow>('m-pressure-window', '60');
  return [PRESSURE_WINDOWS.some((x) => x.key === w) ? w : '60', setW];
}

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
  /** The window all of it was read over. */
  window: PressureWindow;
  /** The perp's own running delta over the window, minute by minute: the line on Home's big-move card. */
  perpCvd: number[];
  /** The strike the premium and IV changes are read on: the desk's own pick, the put first. */
  leg: Leg | null;
  shock: SuddenMove | null;
};

export function usePressure(everyMs = 15_000, window: PressureWindow = '60'): Pressure {
  // The desk's own defaults for the chain: the nearest expiry, twenty strikes a side.
  const chain = usePoll(() => getChain('now', 20, 15, 0, 10), everyMs);
  const data = isChain(chain.data) ? chain.data : null;
  const snap = data?.snapshot ?? null;
  const perp = usePoll(() => getPerp(Number(window), snap?.expiry ?? null), Math.round(everyMs * 2 / 3), { enabled: snap !== null, deps: [snap?.expiry, window] });
  const leg = data ? deskLeg(data) : null;
  const symbol = leg && snap ? `${leg.cp}-BTC-${leg.strike}-${snap.expiry}` : null;
  const changes = usePoll<ChangesResponse>(() => {
    const s = data!.structure;
    return getChanges(symbol!, {
      spot: snap!.spot, mark: leg!.mark, oi: leg!.oi, iv: leg!.iv, volume: leg!.volume,
      ceOi: s.ceOi, peOi: s.peOi, callVolume: s.ceVolume, putVolume: s.peVolume, pcr: s.pcrOi, atmIv: s.atmIv,
    });
  }, everyMs * 2, { enabled: symbol !== null, deps: [symbol] });

  const w15 = changes.data?.rows?.find((r) => r.minutes === 15) ?? null;
  let warning: EarlyWarning | null = null;
  // Home wears this: a reading that will not work out is a tile that says "reading", never a screen that falls over.
  try {
    warning = data ? earlyWarning({
      flow: perp.data?.flow ?? null, book: perp.data?.book ?? null, oi: perp.data?.oi ?? null, funding: perp.data?.ticker?.fundingRate ?? null,
      market: data.market, outlook: data.outlook, markChange15mPct: w15?.markChangePct ?? null, atmIvChange15mPts: w15?.atmIvChangePts ?? null,
    }) : null;
  } catch { warning = null; }
  const f = perp.data?.optionFlow ?? null;
  const flow = f && f.source !== 'none' && f.ce && f.pe && f.combined ? f : null;
  return {
    chain: data, chainError: chain.error,
    flow, perpRead: perp.data !== null, perpError: perp.error,
    warning, window, perpCvd: (perp.data?.flow?.cvd ?? []).map((c) => c.cvd), leg, shock: data?.shocks?.[0] ?? null,
  };
}

/** An answer with the parts this read needs: anything else (an error's body, an older server's shape) is "not read". */
function isChain(x: ChainResponse | null): x is ChainResponse {
  return !!x && !!x.snapshot && Array.isArray(x.legs) && Array.isArray(x.outlook?.rows) && Array.isArray(x.recommendation?.sides) && !!x.best && !!x.structure;
}
