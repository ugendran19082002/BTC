/**
 * Chart annotations API routes.
 *
 * GET  /api/chart/annotations?symbol=BTCUSD&tf=5m  — list all
 * POST /api/chart/annotations                        — create
 * DELETE /api/chart/annotations/:id                 — remove one
 * DELETE /api/chart/annotations?symbol=…&tf=…       — clear all for tf
 */

import type { FastifyInstance } from 'fastify';
import {
  listAnnotations,
  createAnnotation,
  deleteAnnotation,
  clearAnnotations,
  ANNOTATION_SCHEMA,
  type AnnotationKind,
} from '../../market/chart-annotations.js';
import { rows } from '../../db/pool.js';

let ready = false;

async function ensureSchema() {
  if (ready) return;
  // Inline schema: simple enough not to need the full migration runner here.
  await rows(ANNOTATION_SCHEMA);
  ready = true;
}

const VALID_KINDS = new Set<string>([
  'sl', 'tgt', 'tgt2', 'tgt3',
  'ob_bull', 'ob_bear', 'fvg_bull', 'fvg_bear',
  'supply', 'demand', 'bos', 'choch', 'eqh', 'eql', 'ssl', 'bsl', 'breaker',
]);

const VALID_TFS = new Set(['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d']);

export function registerAnnotationRoutes(app: FastifyInstance) {
  /** List annotations for a symbol+tf. */
  app.get<{ Querystring: { symbol?: string; tf?: string } }>(
    '/api/chart/annotations',
    async (req, reply) => {
      await ensureSchema();
      const symbol = (req.query.symbol ?? 'BTCUSD').slice(0, 40);
      const tf = VALID_TFS.has(req.query.tf ?? '') ? (req.query.tf ?? '5m') : '5m';
      const list = await listAnnotations(symbol, tf);
      return reply.send({ annotations: list });
    },
  );

  /** Create an annotation (SL box, TGT box, OB zone, etc.). */
  app.post<{
    Body: {
      symbol?: string; tf?: string; kind: string;
      fromTime: number; toTime: number;
      priceLow: number; priceHigh: number;
      label?: string; meta?: Record<string, unknown>;
    };
  }>(
    '/api/chart/annotations',
    async (req, reply) => {
      await ensureSchema();
      const b = req.body;
      if (!VALID_KINDS.has(b.kind)) {
        return reply.code(400).send({ error: `invalid kind: ${b.kind}` });
      }
      if (typeof b.fromTime !== 'number' || typeof b.toTime !== 'number') {
        return reply.code(400).send({ error: 'fromTime and toTime must be numbers (epoch seconds)' });
      }
      if (typeof b.priceLow !== 'number' || typeof b.priceHigh !== 'number') {
        return reply.code(400).send({ error: 'priceLow and priceHigh must be numbers' });
      }
      const ann = await createAnnotation({
        symbol: (b.symbol ?? 'BTCUSD').slice(0, 40),
        tf: VALID_TFS.has(b.tf ?? '') ? (b.tf ?? '5m') : '5m',
        kind: b.kind as AnnotationKind,
        fromTime: Math.round(b.fromTime),
        toTime: Math.round(b.toTime),
        priceLow: b.priceLow,
        priceHigh: b.priceHigh,
        label: b.label?.slice(0, 80) ?? null,
        meta: b.meta ?? null,
      });
      return reply.code(201).send(ann);
    },
  );

  /** Delete a single annotation by id. */
  app.delete<{ Params: { id: string }; Querystring: { symbol?: string; tf?: string } }>(
    '/api/chart/annotations/:id',
    async (req, reply) => {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      await deleteAnnotation(id);
      return reply.send({ ok: true });
    },
  );

  /** Clear all annotations for a symbol+tf, or a specific kind within it. */
  app.delete<{ Querystring: { symbol?: string; tf?: string; kind?: string } }>(
    '/api/chart/annotations',
    async (req, reply) => {
      await ensureSchema();
      const symbol = (req.query.symbol ?? 'BTCUSD').slice(0, 40);
      const tf = VALID_TFS.has(req.query.tf ?? '') ? (req.query.tf ?? '5m') : '5m';
      const kind = req.query.kind && VALID_KINDS.has(req.query.kind)
        ? (req.query.kind as AnnotationKind) : undefined;
      await clearAnnotations(symbol, tf, kind);
      return reply.send({ ok: true });
    },
  );
}
