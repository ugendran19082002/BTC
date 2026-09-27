/**
 * "Checked 40s ago · still Range" — the sentence the signal history could not say.
 *
 * `market_states` is a change log, and a change log has one blind spot: silence
 * means two different things. A timeframe holding RANGE for thirteen hours
 * writes nothing, and a recorder that died at 19:37 also writes nothing. On the
 * morning of 27 September the second was true, the list looked exactly as it
 * does when the market is quiet, and nobody could tell — the hit rate on the
 * card was meanwhile being computed from the gap.
 *
 * So the journal now records every *look* as well as every change
 * (`market_state_checks`), and this is how the screen says so. Three states, and
 * they must never be confusable:
 *
 *   never run     the recorder has not looked at this timeframe at all
 *   watching      looked recently; no new row because nothing changed
 *   not running   last look is older than it should be — something is wrong
 */

export type Checked = {
  tf: string;
  at: number;
  event: string;
  stage: string;
  wrote: number | null;
} | null;

/**
 * How long a gap between looks is too long, by timeframe, in ms.
 *
 * Three times the recorder's own interval (`CHECK_MS` in
 * `market/state-recorder.ts`): one missed tick is a slow candle fetch, three in
 * a row is not. Deliberately generous — a false "not running" teaches the reader
 * to ignore the badge, which is worse than no badge.
 */
const STALE_AFTER_MS: Record<string, number> = {
  '5m': 3 * 60_000,
  '15m': 3 * 60_000,
  '30m': 6 * 60_000,
  '1h': 15 * 60_000,
  '2h': 30 * 60_000,
  '4h': 45 * 60_000,
};
const DEFAULT_STALE_MS = 10 * 60_000;

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

/** Words for the state of the WORD — what a human should read, and how alarmed to be. */
export function livenessOf(checked: Checked, now: number): {
  tone: 'ok' | 'warn' | 'dim';
  text: string;
  title: string;
} {
  if (!checked) {
    return {
      tone: 'warn',
      text: 'never recorded',
      title: 'The recorder has not looked at this timeframe yet. If this persists, the API has not picked up the state recorder.',
    };
  }
  const age = now - checked.at;
  const limit = STALE_AFTER_MS[checked.tf] ?? DEFAULT_STALE_MS;
  const stale = age > limit;
  const word = checked.event
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

  if (stale) {
    return {
      tone: 'warn',
      text: `not checked for ${ago(age)}`,
      title: `The last look at ${checked.tf} was ${ago(age)}, past the ${Math.round(limit / 60_000)}-minute limit. `
        + 'No new rows here may mean the recorder has stopped, not that the market is quiet.',
    };
  }
  return {
    tone: 'ok',
    text: `checked ${ago(age)} · still ${word}`,
    title: `The recorder looked at ${checked.tf} ${ago(age)} and saw ${checked.event} / ${checked.stage}. `
      + 'No new row because nothing changed — this list is a change log, so quiet is silence.',
  };
}

const TONE = {
  ok: 'text-[var(--muted)]',
  warn: 'text-[var(--warn)]',
  dim: 'text-[var(--dim)]',
} as const;

/** The compact form, for the signal-history heading. */
export function Liveness({ checked, now = Date.now() }: { checked: Checked; now?: number }) {
  const l = livenessOf(checked, now);
  return (
    <span className={TONE[l.tone]} title={l.title}>
      {l.text}
    </span>
  );
}
