/**
 * The offer to work a session's limit out again, after a lot change saved while the session runs (20 Nov 2026: Low went
 * to 2 lots at 07:05 and kept its 1-lot limit). `saveStrategy` hands the server's answer here; the strategy screen's
 * `SessionRecomputeOffer` shows it until it is taken or let go. One offer at a time: a newer save replaces it.
 */
export type RecomputeOffer = { accountId: number | null; accountName: string | null; beforeInr: number | null; afterInr: number; from: string; to: string };

let current: RecomputeOffer | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export const offerSessionRecompute = (o: RecomputeOffer | null) => { current = o; changed(); };
export const sessionRecomputeOffer = () => current;
export const onSessionRecomputeOffer = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
