/**
 * Chart annotations API client.
 *
 * SL/TGT boxes, SMC zones (OB, FVG, BOS, CHoCH etc.) saved to the desk DB.
 */

import { json, post } from './client';

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

export async function createAnnotation(a: Omit<Annotation, 'id' | 'createdAt'>): Promise<Annotation> {
  return post<Annotation>('/api/chart/annotations', a);
}

export async function deleteAnnotationById(id: number): Promise<void> {
  await json<{ ok: boolean }>(`/api/chart/annotations/${id}`, { method: 'DELETE' });
}

export async function clearAnnotationsApi(symbol: string, tf: string, kind?: AnnotationKind): Promise<void> {
  let url = `/api/chart/annotations?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}`;
  if (kind) url += `&kind=${kind}`;
  await json<{ ok: boolean }>(url, { method: 'DELETE' });
}

/** Human-readable label for an annotation kind */
export function annotationLabel(kind: AnnotationKind): string {
  const MAP: Record<AnnotationKind, string> = {
    sl: 'SL', tgt: 'TP1', tgt2: 'TP2', tgt3: 'TP3',
    ob_bull: 'OB↑', ob_bear: 'OB↓',
    fvg_bull: 'FVG↑', fvg_bear: 'FVG↓',
    supply: 'Supply', demand: 'Demand',
    bos: 'BOS', choch: 'CHoCH',
    eqh: 'EQH', eql: 'EQL',
    ssl: 'SSL', bsl: 'BSL',
    breaker: 'Breaker',
  };
  return MAP[kind] ?? kind.toUpperCase();
}

/** Tone of an annotation for colour coding */
export function annotationTone(kind: AnnotationKind): 'bearish' | 'bullish' | 'neutral' {
  if (['sl', 'ob_bear', 'fvg_bear', 'supply', 'choch', 'eqh', 'ssl'].includes(kind)) return 'bearish';
  if (['tgt', 'tgt2', 'tgt3', 'ob_bull', 'fvg_bull', 'demand', 'bsl', 'eql'].includes(kind)) return 'bullish';
  return 'neutral';
}
