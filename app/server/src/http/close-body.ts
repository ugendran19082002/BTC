/**
 * A person's close, as the position card sends it, checked and shaped.
 *
 * Pure and separate from the route for the reason every parser here is: the
 * objections are the part worth testing, and a route that needs a live
 * exchange to exercise its input checks is one whose input checks go untested.
 *
 * `lots` absent means **all of it**. That is not a default chosen for
 * convenience: every close the desk sent before sizes existed meant all of it,
 * and an older client that still posts `{ tradeId }` must go on meaning the
 * same thing. Whether the number that *is* given is closable -- more than is
 * held, a position that has already gone -- is the engine's answer, which it
 * gives against the position as the exchange reports it a moment before
 * sending, not against whatever the screen last saw.
 */
export type CloseBody = {
  tradeId?: unknown;
  /** Contracts to buy back. Absent, null or empty means the whole position. */
  lots?: unknown;
};

export type ParsedClose = {
  tradeId: string;
  /** Null means everything. */
  lots: number | null;
};

export function parseCloseBody(b: CloseBody): { ok: true; close: ParsedClose } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const tradeId = typeof b.tradeId === 'string' ? b.tradeId.trim() : '';
  if (!tradeId) problems.push('tradeId is required');

  let lots: number | null = null;
  if (b.lots !== undefined && b.lots !== null && b.lots !== '') {
    const n = typeof b.lots === 'number' ? b.lots : Number(b.lots);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      problems.push('Lots must be a whole number, at least 1, or left out to close everything.');
    } else {
      lots = n;
    }
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, close: { tradeId, lots } };
}
