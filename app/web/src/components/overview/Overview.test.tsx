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
    render(<Overview data={data} trade={null} contracts={1} chain={false} />);
    for (const t of ['Key levels', 'Volatility', 'Strategy decision', 'IV term structure', 'Strike finder', /^Sell-side risk engine/, /^Scenario/]) {
      expect(screen.getByText(t, { selector: 'h3' })).toBeInTheDocument();
    }
    // No settings toolbar and no order panel: the desk's configuration is fixed, and orders have their own tab.
    expect(document.querySelector('.ov-ctx')).toBeNull();
    expect(screen.queryByText('Order panel', { selector: 'h3' })).toBeNull();
    // The two sides, side by side; the desk's answer is the panel's tag.
    for (const t of ['SELL CE', 'SELL PE']) expect(screen.getByText(t, { selector: '.ov-card4 > header > b' })).toBeInTheDocument();
    // Said once: no model view beside the outlook, no sell recommendation beside the strikes, no entry setup beside the decision card.
    for (const gone of [/^Model view/, 'Sell recommendation', 'Entry → expiry setup', 'Scenario P&L (−3% … +3%)']) expect(screen.queryByText(gone, { selector: 'h3' })).toBeNull();

    // The answer, once, on the strategy decision: one of the four.
    expect(screen.getByText(/^Desk side: (CE|PE|BOTH|NO TRADE)$/)).toBeInTheDocument();
    for (const t of [/^Early warning/, 'Horizon / MTF · movement to expiry', /^What changed/]) {
      expect(screen.getByText(t, { selector: 'h3' })).toBeInTheDocument();
    }
    expect(screen.queryByText(/^Option chain/)).toBeNull();
    expect(screen.getByText(/^Selected strike: /)).toBeInTheDocument();
  });

  it('follow the strike the screen selects, and fall back when it is not on the board', () => {
    const leg = data.legs.find((l) => l.cp === 'P')!;
    const onSelect = vi.fn();
    const { rerender } = render(
      <Overview data={data} trade={null} contracts={1} chain={false} selected={{ cp: 'P', strike: leg.strike }} onSelect={onSelect} />,
    );
    expect(screen.getByText(`Selected strike: ${leg.strike.toLocaleString('en-US')} PE`)).toBeInTheDocument();
    rerender(<Overview data={data} trade={null} contracts={1} chain={false} selected={{ cp: 'P', strike: 1 }} onSelect={onSelect} />);
    expect(screen.getByText(/^Selected strike: /)).toBeInTheDocument();
  });

  it('the bar lists the expiries and changes the contract from there', () => {
    const onExpiry = vi.fn();
    render(<Overview data={data} trade={null} contracts={1} chain={false} expiries={[{ expiry: data.snapshot.expiry, hoursAway: 5, isDaily: true, isNextEntry: true } as never, { expiry: '220926', hoursAway: 60 } as never]} onExpiry={onExpiry} />);
    fireEvent.change(screen.getByLabelText('Expiry'), { target: { value: '220926' } });
    expect(onExpiry).toHaveBeenCalledWith('220926');
  });

  it('with its own chain, a click on a strike selects it', () => {
    render(<Overview data={data} trade={null} contracts={1} />);
    const k = data.snapshot.atm;
    const row = screen.getByText(k.toLocaleString('en-US'), { selector: 'td.ov-strike' }).closest('tr')!;
    fireEvent.click(row.querySelectorAll('td')[0]!);
    expect(screen.getByText(`Selected strike: ${k.toLocaleString('en-US')} CE`)).toBeInTheDocument();
  });
});
