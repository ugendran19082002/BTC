import { describe, expect, it } from 'vitest';
import { tabTitle } from '@/lib/tab-title';

describe('the tab title', () => {
  it('[critical] carries the price, the day move and the P&L, in that order', () => {
    expect(tabTitle({ signedIn: true, spot: 78_397.2, dayMoveUsd: 88.4, todayInr: '+₹4,354' }))
      .toBe('78,397 +88 · +₹4,354 · BTC Desk');
  });

  it('shows a fall as a fall', () => {
    expect(tabTitle({ signedIn: true, spot: 78_000, dayMoveUsd: -212.6, todayInr: '−₹910' }))
      .toBe('78,000 −213 · −₹910 · BTC Desk');
  });

  it('leaves the move out until it is measured from 05:30, and the P&L out until it has arrived', () => {
    expect(tabTitle({ signedIn: true, spot: 78_000, dayMoveUsd: null, todayInr: null })).toBe('78,000 · BTC Desk');
    expect(tabTitle({ signedIn: true, spot: 78_000, dayMoveUsd: null, todayInr: '₹0' })).toBe('78,000 · ₹0 · BTC Desk');
  });

  it('[critical] says nothing about money while nobody is signed in', () => {
    expect(tabTitle({ signedIn: false, spot: 78_000, dayMoveUsd: 88, todayInr: '+₹4,354' })).toBe('BTC Desk');
    expect(tabTitle({ signedIn: true, spot: null, dayMoveUsd: null, todayInr: null })).toBe('BTC Desk');
  });
});
