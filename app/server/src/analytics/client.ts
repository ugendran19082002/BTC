import { noteError } from '../observability/errors.js';

/**
 * The analytics service, from the Node side.
 *
 * Display only. Nothing on the trading path calls this: the engine, the
 * strategy runner and every gate they read stay in Node. What comes back is
 * extra detail for a screen, and every caller has its own figures to show
 * without it -- so this never throws, never waits long, and says nothing more
 * than once when the service is away.
 *
 *   timeout      1.2 s, then the screen gets Node's own cards
 *   cool-off     30 s after a failure before asking again, so an outage costs
 *                one slow request every half minute rather than one per poll
 *   unset URL    off entirely (tests, local runs without the service)
 */

export type MeasuredRow = {
  label: string;
  minutes: number;
  /** The measured horizon it was answered from: settlement uses the nearest. */
  measuredMinutes: number;
  projected: number;
  low: number;
  high: number;
  pDown: number;
  pSide: number;
  pUp: number;
  sideBandPct: number;
  sideBandUsd: number;
  arrow: 'up' | 'down' | 'flat';
  calm: 'calmer' | 'livelier' | null;
  windows: number;
  basis: {
    feature: string;
    bucket: string;
    words: string;
    windows: number;
    independent: number;
    leanHolds: boolean;
    sideHolds: boolean;
  } | null;
};

export type MeasuredOutlook = { model: string; measuredAt: string | null; rows: MeasuredRow[] };

export type Series = Partial<Record<'5m' | '15m' | '1h' | '4h' | '1d', { t: number[]; c: number[] }>>;

export const ANALYTICS_TIMEOUT_MS = 1_200;
export const ANALYTICS_COOL_OFF_MS = 30_000;

type Deps = { fetch: typeof fetch; now: () => number; url: string | undefined };

let downUntil = 0;
let noted = false;

/** For tests: forget any outage. */
export function resetAnalyticsClient(): void {
  downUntil = 0;
  noted = false;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function rowFrom(r: Record<string, unknown>): MeasuredRow | null {
  const b = r.basis as Record<string, unknown> | null | undefined;
  const nums = ['minutes', 'measured_minutes', 'projected', 'low', 'high', 'p_down', 'p_side', 'p_up',
    'side_band_pct', 'side_band_usd', 'windows'];
  if (typeof r.label !== 'string' || !nums.every((k) => num(r[k]))) return null;
  if (r.arrow !== 'up' && r.arrow !== 'down' && r.arrow !== 'flat') return null;
  return {
    label: r.label,
    minutes: r.minutes as number,
    measuredMinutes: r.measured_minutes as number,
    projected: r.projected as number,
    low: r.low as number,
    high: r.high as number,
    pDown: r.p_down as number,
    pSide: r.p_side as number,
    pUp: r.p_up as number,
    sideBandPct: r.side_band_pct as number,
    sideBandUsd: r.side_band_usd as number,
    arrow: r.arrow,
    calm: r.calm === 'calmer' || r.calm === 'livelier' ? r.calm : null,
    windows: r.windows as number,
    basis: b && typeof b.words === 'string'
      ? {
          feature: String(b.feature), bucket: String(b.bucket), words: b.words,
          windows: Number(b.windows), independent: Number(b.independent),
          leanHolds: b.lean_holds === true, sideHolds: b.side_holds === true,
        }
      : null,
  };
}

export async function measuredOutlook(
  input: { now: number; spot: number; series: Series | null; extra: { label: string; minutes: number }[] },
  deps: Deps = { fetch: globalThis.fetch, now: Date.now, url: process.env.ANALYTICS_URL },
): Promise<MeasuredOutlook | null> {
  if (!deps.url || !input.series) return null;
  if (deps.now() < downUntil) return null;
  try {
    const res = await deps.fetch(`${deps.url.replace(/\/$/, '')}/v1/outlook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: Math.floor(input.now / 1000), spot: input.spot, series: input.series, extra: input.extra }),
      signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
    });
    // 503 is the service saying it has no measured table yet: not an outage, just nothing to add.
    if (res.status === 503) return null;
    if (!res.ok) throw new Error(`analytics answered ${res.status}`);
    const body = (await res.json()) as { model?: unknown; measured_at?: unknown; rows?: unknown };
    if (!Array.isArray(body.rows)) throw new Error('analytics answered without rows');
    const rows = body.rows.map((r) => rowFrom(r as Record<string, unknown>)).filter((r): r is MeasuredRow => r !== null);
    noted = false;
    return {
      model: typeof body.model === 'string' ? body.model : 'unknown',
      measuredAt: typeof body.measured_at === 'string' ? body.measured_at : null,
      rows,
    };
  } catch (e) {
    downUntil = deps.now() + ANALYTICS_COOL_OFF_MS;
    if (!noted) {
      noted = true;
      noteError({
        source: 'server', level: 'warn', where: 'analytics/client',
        message: `analytics service unavailable, showing the desk's own cards: ${(e as Error).message}`,
      });
    }
    return null;
  }
}
