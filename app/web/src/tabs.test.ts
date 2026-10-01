import { describe, expect, it } from 'vitest';
import { TABS, asTab } from '@/App';

/**
 * A tab exists in four places: the type, the nav button, the body, and this
 * runtime list. On 18 September Settings was added to three of them, so every
 * click on it fell back to Live — the button was there, and nothing happened.
 *
 * The list is the one that can silently disagree with the others, so it is the
 * one held to a test.
 */

describe('the tab list', () => {
  it('[critical] every screen the desk has is in the list a click is checked against', () => {
    expect([...TABS]).toEqual(['desk', 'trade', 'orders', 'strategy', 'pnl', 'methods', 'settings', 'errors']);
    for (const t of TABS) expect(asTab(t)).toBe(t);
  });

  it('a tab remembered from an older build falls back to Live rather than a blank screen', () => {
    expect(asTab('whatever-this-was')).toBe('desk');
    expect(asTab('')).toBe('desk');
    // The Option Chain tab (removed 22 Sep 2026): its board is at the bottom of Live now.
    expect(asTab('chain')).toBe('desk');
  });

  it('Signals was folded into Live, so its old tab falls back rather than blanking', () => {
    // A second tab for half a day (27 Sep 2026), then merged into the Live
    // screen beside the signal history. Anyone whose browser remembers it must
    // land on Live, not on nothing.
    expect(asTab('signals')).toBe('desk');
    expect(asTab('desk')).toBe('desk');
  });
});
