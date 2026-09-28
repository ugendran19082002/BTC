import { json } from '@/api/client';
import type { LiveResponse } from '@/types/live';

/**
 * The Live screen's momentum call, with the price it is measured from.
 * `asOf` says which moment it describes.
 */
export function getLive(opts: { expiry?: string; at?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.expiry) q.set('expiry', opts.expiry);
  if (opts.at) q.set('at', opts.at);
  const s = q.toString();
  return json<LiveResponse>(`/api/live${s ? `?${s}` : ''}`);
}

