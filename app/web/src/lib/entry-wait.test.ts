import { describe, expect, it } from 'vitest';
import { entryWaitWords } from '@/lib/entry-wait';

/** 13 Oct 2026, 9:30:00 PM IST. */
const SENT = Date.parse('2026-10-13T21:30:00+05:30');

describe('a waiting order\'s time limit, in words', () => {
  it('[critical] a signal order: cancelled five minutes after it is sent, counting down, walking toward the bid at first', () => {
    const w = { sentAt: SENT, deadline: SENT + 300_000, then: 'cancel' as const, chaseMs: 5_000 };
    expect(entryWaitWords(w, SENT + 2_000)).toEqual({ text: 'Cancelled if not filled in 4m 58s · at 9:35 PM. Walking toward the bid for another 3s.', urgent: false });
    expect(entryWaitWords(w, SENT + 60_000)).toEqual({ text: 'Cancelled if not filled in 4m 00s · at 9:35 PM.', urgent: false });
    // the last minute is marked
    expect(entryWaitWords(w, SENT + 255_000)).toEqual({ text: 'Cancelled if not filled in 45s · at 9:35 PM.', urgent: true });
    expect(entryWaitWords(w, SENT + 300_000)).toEqual({ text: 'Its time is up: being cancelled.', urgent: true });
  });

  it('an order that crosses at the end of its wait says the market, not a cancel', () => {
    const w = { sentAt: SENT, deadline: SENT + 30_000, then: 'market' as const, chaseMs: null };
    expect(entryWaitWords(w, SENT + 10_000)!.text).toBe('Goes to the market if not filled in 20s · at 9:30 PM.');
    expect(entryWaitWords(w, SENT + 31_000)!.text).toBe('Its time is up: going to the market.');
  });

  it('[critical] no limit is said as no limit -- and nothing at all on a server that does not say', () => {
    expect(entryWaitWords({ sentAt: SENT, deadline: null, then: null, chaseMs: null }, SENT + 5_000)).toEqual({ text: 'No time limit: it rests until it fills or is cancelled.', urgent: false });
    // a limit whose start is not on record: said without a clock, never with a made-up one
    expect(entryWaitWords({ sentAt: null, deadline: null, then: 'cancel', chaseMs: null }, SENT)!.text).toBe('Cancelled if it does not fill in its time.');
    expect(entryWaitWords(undefined, SENT)).toBeNull();
    expect(entryWaitWords(null, SENT)).toBeNull();
  });
});
