import { getPriceChange } from '@/api/desk';
import { usePoll } from '@/hooks/usePoll';
import { priceMoves, type PriceMove } from '@/lib/price-change';
import { usePhoneData } from '@/components/mobile/phone-context';
import { nextSettlement } from '@/components/mobile/settlement';

/**
 * BTC's index now against each window back and the desk's own marks (7 Oct 2026), read once for the Price
 * changes screen and for Home's BTC card. "Since entry" runs from the first fill of anything the desk holds
 * now; "last settlement" is a day before the next one. From `/api/price-change`, which the desk's card reads.
 */
export function usePriceMoves(everyMs = 15_000): {
  at: number | null; index: number | null; read: boolean; error: Error | null; windows: PriceMove[]; marks: PriceMove[];
} {
  const p = usePhoneData();
  const fills = (p.status?.open ?? []).filter((t) => t.position !== 0).flatMap((t) => t.fills.map((f) => f.ts)).filter((v) => v > 0);
  const entryMs = fills.length ? Math.min(...fills) : null;
  const expiryTs = Math.round(nextSettlement(p.now) / 1000);
  const res = usePoll(() => getPriceChange(entryMs, expiryTs), everyMs, { deps: [entryMs, expiryTs] });
  // An answer without rows (an error's body) is "not read", as with the chain.
  const data = res.data && Array.isArray(res.data.rows) ? res.data : null;
  return { at: data?.at ?? null, index: data?.spot ?? null, read: data !== null, error: res.error, ...priceMoves(data) };
}
