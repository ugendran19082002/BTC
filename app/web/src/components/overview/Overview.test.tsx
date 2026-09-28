import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChainResponse } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import { Overview } from './Overview';

vi.mock('@/api/desk', () => ({
  getTerm: () => new Promise(() => {}),
  getPerp: () => new Promise(() => {}),
}));

const data = live as unknown as ChainResponse;

/**
 * The Live screen's decision panels against a real /api/chain response
 * (19 Sep 2026): every panel draws, and the screen -- not the panels -- owns
 * the selected strike when it asks to.
 */
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
  const marketSpot = (data.market as { spot?: number } | null)?.spot;

  it('[critical] the one-second tick wins over the chain snapshot and the 5m close', () => {
    render(<Overview data={data} tick={99_111} />);
    expect(screen.getByText('99,111.0')).toBeInTheDocument();
  });

  it('[critical] with no tick it falls back to the chain snapshot, never to the 5m close', () => {
    render(<Overview data={data} />);
    expect(screen.getByText(data.snapshot.spot.toLocaleString('en-US', {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    }))).toBeInTheDocument();
  });

  it('[critical] the 5m candle close is never preferred over a ticker price', () => {
    // The regression this guards: if the fixture's two spots differ, the stale
    // one must not be the one drawn.
    if (marketSpot === undefined || marketSpot === data.snapshot.spot) return;
    render(<Overview data={data} />);
    expect(screen.queryByText(marketSpot.toLocaleString('en-US', {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    }))).not.toBeInTheDocument();
  });
});

describe('the market read', () => {
  it('draws the panels that remain from a real chain', () => {
    render(<Overview data={data} />);
    expect(screen.getByText('Flow · BTC perpetual & options', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getAllByText(/^(BTC perpetual|Options · CE \/ PE)$/).length).toBe(2);
    expect(screen.getByText(/^Skew · /)).toBeInTheDocument();
  });

  it('[critical] the panels removed on 28 Sep 2026 stay removed', () => {
    render(<Overview data={data} />);
    for (const gone of ['Strategy decision', 'Multi-timeframe', 'Big move risk', /^What changed/, 'Big move catch']) {
      expect(screen.queryByText(gone, { selector: 'h3' })).toBeNull();
    }
    for (const gone of [/Big Move Catch/, 'Signal History', 'Expiry Prediction Engine', 'Market Analysis Score', /^Multi-Timeframe Hierarchy/, 'Key Levels', 'Market State', 'Market Regime']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('the bar lists the expiries and changes the contract from there', () => {
    const onExpiry = vi.fn();
    render(<Overview data={data} expiries={[{ expiry: data.snapshot.expiry, expiryTs: data.snapshot.expiryTs, hoursAway: 5, isDaily: true, isNextEntry: true } as never, { expiry: '220926', expiryTs: data.snapshot.expiryTs + 2 * 86_400, hoursAway: 60 } as never]} onExpiry={onExpiry} />);
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '220926' } });
    expect(onExpiry).toHaveBeenCalledWith('220926');
  });
});
