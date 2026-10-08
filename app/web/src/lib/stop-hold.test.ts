import { describe, expect, it } from 'vitest';
import { closeOutRoom, heldStopFor, stopHold, stopHoldNote } from '@/lib/stop-hold';

/**
 * The form's account of a stop held inside the close-out: the server's arithmetic (trading/margin.ts
 * `liquidationRoom`, trading/order-plan.ts `stopRoomInside`), said before the trade says it.
 */
describe('a stop held inside the close-out, as the form works it out', () => {
  it('[critical] the room and the hold are the server\'s: half of BTC over 200x, and nine tenths of it', () => {
    expect(closeOutRoom(80_000)).toBe(200);
    expect(stopHold(80_000)).toBe(180);
    // BTC 85,000, as the server's own test has it: 212.5 of room, 191.2 held.
    expect(closeOutRoom(85_000)).toBe(212.5);
    expect(stopHold(85_000)).toBe(191.2);
  });

  it('[critical] a share stop: up to which premium it stands as asked', () => {
    // 300% with BTC at 80,000: 180 / 3 = 60. A $60 entry's stop is 240, exactly the hold; a $73 entry's is held.
    expect(stopHoldNote({ mode: 'pct', value: 3 }, 80_000)).toEqual({ room: 200, hold: 180, fitsUpTo: 60, alwaysHeld: false });
    expect(heldStopFor(60, { mode: 'pct', value: 3 }, 80_000)).toEqual({ stop: 240, asked: 240, held: false });
    expect(heldStopFor(73, { mode: 'pct', value: 3 }, 80_000)).toEqual({ stop: 253, asked: 292, held: true });
    // 100% fits any premium this desk sells: up to $180.
    expect(stopHoldNote({ mode: 'pct', value: 1 }, 80_000)!.fitsUpTo).toBe(180);
  });

  it('a points stop is held only when it is itself past the hold; a price, no stop, or no BTC price says nothing', () => {
    expect(stopHoldNote({ mode: 'points', value: 100 }, 80_000)).toMatchObject({ fitsUpTo: null, alwaysHeld: false });
    expect(stopHoldNote({ mode: 'points', value: 250 }, 80_000)).toMatchObject({ alwaysHeld: true });
    expect(heldStopFor(50, { mode: 'points', value: 250 }, 80_000)).toEqual({ stop: 230, asked: 300, held: true });
    expect(stopHoldNote({ mode: 'price', value: 300 }, 80_000)).toBeNull();
    expect(stopHoldNote({ mode: 'pct', value: 0 }, 80_000)).toBeNull();
    expect(stopHoldNote({ mode: 'pct', value: 3 }, null)).toBeNull();
  });
});
