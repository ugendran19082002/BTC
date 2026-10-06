/**
 * The desk's health for the phone (6 Oct 2026): GET /api/desk/glance, judged at the server in observability/glance.ts.
 */
import { json } from '@/api/client';

/** The desk's health in one answer (GET /api/desk/glance): one word, the reasons, and the readings behind them. */
export type Health = 'ok' | 'warn' | 'down';

export type Glance = {
  at: number;
  health: Health;
  issues: { level: 'warn' | 'down'; text: string }[];
  /** How old the newest option price is, and the perp's tape; null when nothing has arrived. */
  boardAgeMs: number | null;
  tapeAgeMs: number | null;
  readings: {
    db: { ok: boolean; latencyMs: number };
    board: { source: string; connected: boolean; lastAt: number | null };
    tape: { source: string; connected: boolean; lastAt: number | null };
    delta: { usedPct: number; rateLimited: number; failed: number };
    /** The passes over the open trades in the last five minutes: how many, how many over their second, the slowest. */
    passes: { count: number; late: number; maxMs: number | null; tradesNow?: number };
    errors: { open: number; lastAt: number | null };
    schedulerOn: boolean;
    mode: 'live' | 'paper';
  };
  /** BTC now, and the perp's mark: a signal trade's SL and TGT are on the perp. */
  btc: { spot: number | null; perpMark: number | null };
};

export const getGlance = () => json<Glance>('/api/desk/glance');
