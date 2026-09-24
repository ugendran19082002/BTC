import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChainResponse } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import { Overview } from './Overview';

vi.mock('@/api/desk', () => ({
  getTerm: () => new Promise(() => {}),
  getPerp: () => new Promise(() => {}),
  getChanges: () => new Promise(() => {}),
  getMovement: () => new Promise(() => {}),
}));

const data = live as unknown as ChainResponse;

/**
 * The Live screen's decision panels against a real /api/chain response
 * (19 Sep 2026): every panel draws, and the screen -- not the panels -- owns
 * the selected strike when it asks to.
 */
describe('the decision panels', () => {
  it('draw every panel from a real chain, with the chart and chain left to the screen', () => {
    render(<Overview data={data} trade={null} contracts={1} />);
    for (const t of ['Volatility & skew', 'Flow · BTC perpetual & options', 'Strategy decision', 'Multi-timeframe']) {
      expect(screen.getByText(t, { selector: 'h3' })).toBeInTheDocument();
    }
    // No settings toolbar and no order panel: the desk's configuration is fixed, and orders have their own tab.
    expect(document.querySelector('.ov-ctx')).toBeNull();
    expect(screen.queryByText('Order panel', { selector: 'h3' })).toBeNull();
    // The two sides, on the strategy decision.
    for (const t of ['SELL CE', 'SELL PE']) expect(screen.getByText(t, { selector: '.ov-card4 > header > b' })).toBeInTheDocument();
    /*
     * Removed on the owner's request, 22 Sep 2026: the final-decision card, the
     * IV term structure, the compact chain and the desk events; skew is inside
     * the volatility card now. And on 24 Sep: price action and key levels,
     * whose readings are under the chart; the expiry read and the CE/PE bias,
     * which are tabs on the analysis card; and the strike finder, whose job the
     * strategy decision already does.
     */
    for (const gone of ['Price action', 'Key levels', 'Strike finder', 'Expiry direction', 'Option bias · CE / PE']) {
      expect(screen.queryByText(gone, { selector: 'h3' })).toBeNull();
    }
    expect(screen.queryByText('FINAL EXPIRY SELL DECISION')).toBeNull();
    for (const gone of ['IV term structure', 'Desk events', /^Skew \(/, 'Volatility', /^Sell-side risk engine/, 'BTC flow · perpetual', 'Option flow · CE / PE']) expect(screen.queryByText(gone, { selector: 'h3' })).toBeNull();
    // one flow card, two sections, one window picker
    expect(screen.getAllByText(/^(BTC perpetual|Options · CE \/ PE)$/).length).toBe(2);
    expect(screen.getByText(/^Skew · /)).toBeInTheDocument();
    expect(screen.getByText(/^Put − call skew/)).toBeInTheDocument();
    // Said once: no model view beside the outlook, no sell recommendation beside the strikes, no entry setup beside the decision card.
    for (const gone of [/^Model view/, 'Sell recommendation', 'Entry → expiry setup', 'Scenario P&L (−3% … +3%)']) expect(screen.queryByText(gone, { selector: 'h3' })).toBeNull();

    // The answer, once, on the strategy decision: one of the four.
    expect(screen.getByText(/^Desk side: (CE|PE|BOTH|NO TRADE)$/)).toBeInTheDocument();
    for (const t of [/^Big move catch/, /^What changed/]) {
      expect(screen.getByText(t, { selector: 'h3' })).toBeInTheDocument();
    }
    expect(screen.queryByText(/^Option chain/)).toBeNull();
    // Removed on the owner's request, 22 Sep 2026: the selected-strike card.
    expect(screen.queryByText(/^Selected strike: /)).toBeNull();
  });

  it('follow the strike the screen selects, and fall back when it is not on the board', () => {
    const leg = data.legs.find((l) => l.cp === 'P')!;
    const onSelect = vi.fn();
    const { rerender } = render(
      <Overview data={data} trade={null} contracts={1} selected={{ cp: 'P', strike: leg.strike }} onSelect={onSelect} />,
    );
    expect(screen.getByText(new RegExp(`^What changed · .*${leg.strike.toLocaleString('en-US')} PE`))).toBeInTheDocument();
    rerender(<Overview data={data} trade={null} contracts={1} selected={{ cp: 'P', strike: 1 }} onSelect={onSelect} />);
    expect(screen.getByText(/^What changed · /)).toBeInTheDocument();
  });

  it('the bar lists the expiries and changes the contract from there', () => {
    const onExpiry = vi.fn();
    render(<Overview data={data} trade={null} contracts={1} expiries={[{ expiry: data.snapshot.expiry, expiryTs: data.snapshot.expiryTs, hoursAway: 5, isDaily: true, isNextEntry: true } as never, { expiry: '220926', expiryTs: data.snapshot.expiryTs + 2 * 86_400, hoursAway: 60 } as never]} onExpiry={onExpiry} />);
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '220926' } });
    expect(onExpiry).toHaveBeenCalledWith('220926');
  });

});
