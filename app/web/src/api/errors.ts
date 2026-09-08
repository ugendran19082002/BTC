import { json, post } from '@/api/client';
import type { ErrorList, ErrorSource } from '@/types/errors';

export function getErrors(opts: { source?: ErrorSource; resolved?: boolean; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (opts.source) q.set('source', opts.source);
  if (opts.resolved) q.set('resolved', '1');
  q.set('limit', String(opts.limit ?? 100));
  return json<ErrorList>(`/api/errors?${q}`);
}

export const resolveError = (id: number) => post<{ ok: true }>('/api/errors/resolve', { id });
export const resolveAllErrors = () => post<{ ok: true; resolved: number }>('/api/errors/resolve', { all: true });
