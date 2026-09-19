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
    expect([...TABS]).toEqual(['overview', 'desk', 'trade', 'orders', 'strategy', 'pnl', 'settings', 'errors']);
    for (const t of TABS) expect(asTab(t)).toBe(t);
  });

  it('a tab remembered from an older build falls back to the Overview rather than a blank screen', () => {
    expect(asTab('whatever-this-was')).toBe('overview');
    expect(asTab('')).toBe('overview');
  });
});
