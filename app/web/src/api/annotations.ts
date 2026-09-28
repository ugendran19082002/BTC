/**
 * Chart annotations API client.
 *
 * SL/TGT boxes, SMC zones (OB, FVG, BOS, CHoCH etc.) saved to the desk DB.
 */

import { json } from './client';

export type AnnotationKind =
  | 'sl' | 'tgt' | 'tgt2' | 'tgt3'
  | 'ob_bull' | 'ob_bear'
  | 'fvg_bull' | 'fvg_bear'
  | 'supply' | 'demand'
  | 'bos' | 'choch'
  | 'eqh' | 'eql'
  | 'ssl' | 'bsl'
  | 'breaker';

export type Annotation = {
  id: number;
  symbol: string;
  tf: string;
  kind: AnnotationKind;
  fromTime: number;
  toTime: number;
  priceLow: number;
  priceHigh: number;
  label: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
};

export async function getAnnotations(symbol: string, tf: string): Promise<Annotation[]> {
  const r = await json<{ annotations: Annotation[] }>(
    `/api/chart/annotations?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`,
  );
  return r.annotations;
}

export async function clearAnnotationsApi(symbol: string, tf: string, kind?: AnnotationKind): Promise<void> {
  let url = `/api/chart/annotations?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`;
  if (kind) url += `&kind=${kind}`;
  await json<{ ok: boolean }>(url, { method: 'DELETE' });
}

