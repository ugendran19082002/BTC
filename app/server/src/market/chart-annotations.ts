/**
 * Chart annotations — SL/TGT boxes, SMC labels, OB zones saved by the trader.
 *
 * Stored in `chart_annotations` in PostgreSQL. Each annotation belongs to a
 * symbol+timeframe and is kept until the trader deletes it or it expires.
 * The table is migration `chart-001-annotations` (29 Sep 2026). Until then it
 * was created by raw SQL when the routes registered, outside the ledger; the
 * statement is `IF NOT EXISTS`, so on a database that already has the table
 * the migration only records itself.
 */

import { migrate, type Migration } from '../db/migrate.js';
import { rows } from '../db/pool.js';

export type AnnotationKind =
  | 'sl'        // Stop Loss box  — red
  | 'tgt'       // Target box     — green
  | 'tgt2'      // Target 2
  | 'tgt3'      // Target 3
  | 'ob_bull'   // Bullish Order Block
  | 'ob_bear'   // Bearish Order Block
  | 'fvg_bull'  // Bullish Fair Value Gap
  | 'fvg_bear'  // Bearish Fair Value Gap
  | 'supply'    // Supply zone
  | 'demand'    // Demand zone
  | 'bos'       // Break of Structure line
  | 'choch'     // Change of Character line
  | 'eqh'       // Equal Highs
  | 'eql'       // Equal Lows
  | 'ssl'       // Sell-Side Liquidity
  | 'bsl'       // Buy-Side Liquidity
  | 'breaker';  // Breaker Block

export type Annotation = {
  id: number;
  symbol: string;       // e.g. 'BTCUSD' or a specific contract
  tf: string;           // '5m' | '15m' | '1h' | '4h' etc.
  kind: AnnotationKind;
  /** Left edge of the box — epoch seconds (chart time) */
  fromTime: number;
  /** Right edge of the box — epoch seconds. For a line, fromTime === toTime */
  toTime: number;
  /** Upper price bound */
  priceLow: number;
  /** Lower price bound. For a horizontal line, priceLow === priceHigh */
  priceHigh: number;
  /** Optional label override, e.g. "SL 83,500" */
  label: string | null;
  /** Any extra data: entry price, R:R, notes */
  meta: Record<string, unknown> | null;
  createdAt: number;
};

const ANNOTATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS public.chart_annotations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol      TEXT    NOT NULL DEFAULT 'BTCUSD',
  tf          TEXT    NOT NULL DEFAULT '5m',
  kind        TEXT    NOT NULL,
  from_time   BIGINT  NOT NULL,
  to_time     BIGINT  NOT NULL,
  price_low   DOUBLE PRECISION NOT NULL,
  price_high  DOUBLE PRECISION NOT NULL,
  label       TEXT,
  meta        JSONB,
  created_at  BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS chart_annotations_by_symbol
  ON public.chart_annotations (symbol, tf, to_time DESC);
`;

const MIGRATIONS: Migration[] = [{ id: 'chart-001-annotations', up: ANNOTATION_SCHEMA }];

let ready: Promise<void> | null = null;
export function annotationsSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

function row(r: {
  id: string; symbol: string; tf: string; kind: string;
  from_time: string; to_time: string; price_low: string; price_high: string;
  label: string | null; meta: Record<string, unknown> | null; created_at: string;
}): Annotation {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    tf: r.tf,
    kind: r.kind as AnnotationKind,
    fromTime: Number(r.from_time),
    toTime: Number(r.to_time),
    priceLow: Number(r.price_low),
    priceHigh: Number(r.price_high),
    label: r.label,
    meta: r.meta,
    createdAt: Number(r.created_at),
  };
}

/** All annotations for a symbol+tf, newest first. Max 200. */
export async function listAnnotations(symbol: string, tf: string): Promise<Annotation[]> {
  const r = await rows<Parameters<typeof row>[0]>(
    `SELECT id, symbol, tf, kind, from_time, to_time, price_low, price_high, label, meta, created_at
       FROM public.chart_annotations
      WHERE symbol = $1 AND tf = $2
      ORDER BY created_at DESC
      LIMIT 200`,
    [symbol, tf],
  );
  return r.map(row);
}

/** Create a new annotation. Returns the saved record with its id. */
export async function createAnnotation(a: Omit<Annotation, 'id' | 'createdAt'>): Promise<Annotation> {
  const results = await rows<Parameters<typeof row>[0]>(
    `INSERT INTO public.chart_annotations
       (symbol, tf, kind, from_time, to_time, price_low, price_high, label, meta, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, symbol, tf, kind, from_time, to_time, price_low, price_high, label, meta, created_at`,
    [a.symbol, a.tf, a.kind, a.fromTime, a.toTime, a.priceLow, a.priceHigh, a.label, a.meta ? JSON.stringify(a.meta) : null, Date.now()],
  );
  const r = results[0];
  if (!r) throw new Error('INSERT returned no row');
  return row(r);
}

/** Delete an annotation by id. */
export async function deleteAnnotation(id: number): Promise<void> {
  await rows('DELETE FROM public.chart_annotations WHERE id = $1', [id]);
}

/** Bulk-delete all annotations for a symbol+tf (e.g. clear all SL boxes). */
export async function clearAnnotations(symbol: string, tf: string, kind?: AnnotationKind): Promise<void> {
  if (kind) {
    await rows('DELETE FROM public.chart_annotations WHERE symbol = $1 AND tf = $2 AND kind = $3', [symbol, tf, kind]);
  } else {
    await rows('DELETE FROM public.chart_annotations WHERE symbol = $1 AND tf = $2', [symbol, tf]);
  }
}
