import { duration } from '@/lib/format';
import { timeIst } from '@/lib/market-report';

/**
 * A waiting order's time limit, as the server reads it from the journal and the plan (`tradeView.entryWait`): when
 * the entry was sent, when it gives up (null: no limit), what follows, and how long it walks toward the bid.
 */
export type EntryWait = { sentAt: number | null; deadline: number | null; then: 'cancel' | 'market' | null; chaseMs: number | null };

/**
 * That limit in a line for the card of an order still waiting (owner, 14 Oct 2026: "is a waiting order's expiry
 * shown -- desk and phone?"). The card said where the order rested and since when; this is until when, and what
 * then -- a signal strategy's order is cancelled five minutes after it is sent if nobody has taken it.
 * Null on a server from before the field: nothing is said rather than guessed.
 */
export function entryWaitWords(w: EntryWait | null | undefined, now: number): { text: string; urgent: boolean } | null {
  if (!w) return null;
  const walking = w.chaseMs !== null && w.sentAt !== null && now < w.sentAt + w.chaseMs
    ? ` Walking toward the bid for another ${duration(w.sentAt + w.chaseMs - now)}.` : '';
  if (w.then === null) return { text: `No time limit: it rests until it fills or is cancelled.${walking}`, urgent: false };
  const what = w.then === 'market' ? 'Goes to the market' : 'Cancelled';
  if (w.deadline === null) return { text: `${what} if it does not fill in its time.${walking}`, urgent: false };
  const left = w.deadline - now;
  if (left <= 0) return { text: `Its time is up: ${w.then === 'market' ? 'going to the market' : 'being cancelled'}.`, urgent: true };
  return { text: `${what} if not filled in ${duration(left)} · at ${timeIst(w.deadline)}.${walking}`, urgent: left <= 60_000 };
}
