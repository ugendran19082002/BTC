import { json } from '@/api/client';
import type { LiveResponse } from '@/types/live';

/**
 * The Live screen, in one request.
 *
 * One call rather than the eight the old screen made on four intervals: every
 * row on the screen is then describing the same moment, and `asOf` says which
 * moment that is.
 *
 * `strikes` are judged against the same measured band the cone is drawn from,
 * so a strike's "outside the 95%" and the cone's upper edge can never
 * disagree. Capped server-side at forty.
 */
export function getLive(opts: { expiry?: string; strikes?: readonly string[]; at?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.expiry) q.set('expiry', opts.expiry);
  if (opts.at) q.set('at', opts.at);
  if (opts.strikes?.length) q.set('strikes', opts.strikes.join(','));
  const s = q.toString();
  return json<LiveResponse>(`/api/live${s ? `?${s}` : ''}`);
}

/** The key a strike is asked for by: `C:84000`. */
export const strikeKey = (cp: 'C' | 'P', strike: number) => `${cp}:${strike}`;
