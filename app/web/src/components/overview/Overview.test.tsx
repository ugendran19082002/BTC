import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChainResponse } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import { Overview, screenSpot } from './Overview';

vi.mock('@/api/desk', () => ({
  getPerp: () => new Promise(() => {}),
  getChanges: () => new Promise(() => {}),
}));

const data = live as unknown as ChainResponse;

/**
 * One price on the screen, and it is the newest one available.
 *
 * The KPI strip read `data.market?.spot ?? snap.spot`, which *preferred* the
 * 5-minute candle close over the ticker. Measured live on 27 Sep 2026 that was
 * 36.8 points behind, so the strip said 84,358 while the header said 84,403.6 --
 * two prices on one screen, the stale one feeding every distance. The order is
 * now tick → chain snapshot → 5m close, each step staler than the last.
 */
describe('which price the screen measures from', () => {
  it('[critical] the one-second tick wins over the chain snapshot and the 5m close', () => {
    expect(screenSpot(99_111, 84_000, 83_900)).toBe(99_111);
  });

  it('[critical] with no tick it falls back to the chain snapshot, never to the 5m close', () => {
    expect(screenSpot(null, 84_000, 83_900)).toBe(84_000);
    expect(screenSpot(undefined, 84_000, 83_900)).toBe(84_000);
  });

  it('the 5m close only when there is nothing newer', () => {
    expect(screenSpot(null, null, 83_900)).toBe(83_900);
  });
});

describe('the market read', () => {
  it('draws the panels that remain from a real chain', () => {
    render(<Overview data={data} trade={null} />);
    expect(screen.getByText('Flow · BTC perpetual & options', { selector: 'h3' })).toBeInTheDocument();
    // The early warning stays (owner's request, 28 Sep 2026).
    expect(screen.getByText('Big move catch', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getAllByText(/^(BTC perpetual|Options · CE \/ PE)$/).length).toBe(2);
  });

  it('[critical] the panels removed on 28 Sep 2026 stay removed', () => {
    render(<Overview data={data} trade={null} />);
    for (const gone of ['Volatility & skew', 'Strategy decision', 'Multi-timeframe', 'Big move risk', /^What changed/]) {
      expect(screen.queryByText(gone, { selector: 'h3' })).toBeNull();
    }
    for (const gone of [/Big Move Catch/, 'Signal History', 'Expiry Prediction Engine', 'Market Analysis Score', /^Multi-Timeframe Hierarchy/, 'Key Levels', 'Market State', 'Market Regime']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('the bar lists the expiries and changes the contract from there', () => {
    const onExpiry = vi.fn();
    render(<Overview data={data} trade={null} expiries={[{ expiry: data.snapshot.expiry, expiryTs: data.snapshot.expiryTs, hoursAway: 5, isDaily: true, isNextEntry: true } as never, { expiry: '220926', expiryTs: data.snapshot.expiryTs + 2 * 86_400, hoursAway: 60 } as never]} onExpiry={onExpiry} />);
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '220926' } });
    expect(onExpiry).toHaveBeenCalledWith('220926');
  });
});

describe('the signal strategies, under the entry setups', () => {
  it('[critical] drawn right under the Entry setups header card (Perp / Mark / Index / Basis), before the panels', () => {
    render(<Overview data={data} trade={null} belowEntry={<section aria-label="Signal strategies">cards</section>} />);
    const entry = screen.getByRole('region', { name: 'entry setups' });
    const sig = screen.getByRole('region', { name: 'Signal strategies' });
    const read = screen.getByRole('region', { name: 'Market read' });
    expect(entry.contains(sig)).toBe(true);
    // right after the header card, in the part that stays when the setups fold
    expect(entry.querySelector(':scope > header')!.nextElementSibling!.contains(sig)).toBe(true);
    expect(sig.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
