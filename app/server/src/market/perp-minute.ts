import { rows } from '../db/pool.js';

/**
 * The BTC perp's price in each of these minutes (epoch ms, on the minute): its
 * average traded price over the minute (`trade_flow_1m.vwap`, the tape), else
 * its mark at the minute (`index_1m.mark`). A minute recorded by neither is
 * absent from the answer -- never filled in from a neighbour.
 *
 * For the perp entry of trades placed before it was kept on the trade
 * (2 Oct 2026); the screens mark these as approximate.
 */
export async function perpAtMinutes(minutes: readonly number[]): Promise<Map<number, number>> {
  const at = [...new Set(minutes.map((m) => Math.floor(m / 60_000) * 60_000))];
  if (!at.length) return new Map();
  const xs = await rows<{ at: string; vwap: number | null; mark: number | null }>(
    `SELECT m.at, f.vwap, i.mark FROM unnest($1::bigint[]) AS m(at)
       LEFT JOIN trade_flow_1m f ON f.at = m.at LEFT JOIN index_1m i ON i.at = m.at`,
    [at],
  );
  return new Map(xs.flatMap((x) => {
    const p = x.vwap ?? x.mark;
    return p !== null && Number(p) > 0 ? [[Number(x.at), Number(p)] as const] : [];
  }));
}
