import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChainResponse } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import { Overview } from './Overview';

vi.mock('@/api/desk', () => ({
  getTerm: () => new Promise(() => {}),
  getPerp: () => new Promise(() => {}),
  getChanges: () => new Promise(() => {}),
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
    for (const t of ['Key levels', 'Volatility', 'Multi-timeframe', 'Strategy decision', 'Strikes', 'IV term structure', /^Entry checklist/, /^Sell-side risk engine/]) {
      expect(screen.getByText(t, { selector: 'h3' })).toBeInTheDocument();
    }
    // The settings strip shows every setting the screen decides with, and no order panel: orders have their own tab.
    for (const l of ['Entry', 'Horizon', 'Side mode', 'Strictness', 'Risk', 'Execution', 'Size']) {
      expect(screen.getByText(l, { selector: '.ov-ctx-label' })).toBeInTheDocument();
    }
    expect(screen.queryByText('Order panel', { selector: 'h3' })).toBeNull();
    // Said once: no model view beside the outlook, no sell recommendation beside the strikes, no entry setup beside the decision card.
    for (const gone of [/^Model view/, 'Sell recommendation', 'Entry → expiry setup', 'Scenario P&L (−3% … +3%)']) expect(screen.queryByText(gone, { selector: 'h3' })).toBeNull();
    expect(screen.queryByText('Probability', { selector: '.ov-ctx-label' })).toBeNull();
    // The decision, first and largest: one of the four answers, at the moment of entry.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/^(SELL CE|SELL PE|SELL BOTH|NO TRADE)/);
    for (const t of [/^Early warning/, 'Outlook · movement to expiry', /^What changed/]) {
      expect(screen.getByText(t, { selector: 'h3' })).toBeInTheDocument();
    }
    expect(screen.getAllByText(/ENTRY READY|NO TRADE/).length).toBeGreaterThan(0);
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

  it('with its own chain, a click on a strike selects it', () => {
    render(<Overview data={data} trade={null} contracts={1} />);
    const k = data.snapshot.atm;
    const row = screen.getByText(k.toLocaleString('en-US'), { selector: 'td.ov-strike' }).closest('tr')!;
    fireEvent.click(row.querySelectorAll('td')[0]!);
    expect(screen.getByText(`Selected strike: ${k.toLocaleString('en-US')} CE`)).toBeInTheDocument();
  });
});
