import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChainResponse } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import { Overview } from './Overview';

vi.mock('@/api/desk', () => ({
  getTerm: () => new Promise(() => {}),
  getOptionHistory: () => new Promise(() => {}),
}));

const data = live as unknown as ChainResponse;

/**
 * The Live screen's decision panels against a real /api/chain response
 * (19 Sep 2026): every panel draws, and the screen -- not the panels -- owns
 * the selected strike when it asks to.
 */
describe('the decision panels', () => {
  it('draw every panel from a real chain, with the chart and chain left to the screen', () => {
    render(<Overview data={data} spot={null} trade={null} contracts={1} chart={false} chain={false} />);
    for (const t of ['Key levels', 'Volatility', 'Model view (12h)', 'Strategy decision', 'Sell recommendation', 'IV term structure', 'Entry checklist', 'Place sell order']) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(screen.queryByText(/^Option chain/)).toBeNull();
    expect(screen.getByText(/^Selected strike: /)).toBeInTheDocument();
  });

  it('follow the strike the screen selects, and fall back when it is not on the board', () => {
    const leg = data.legs.find((l) => l.cp === 'P')!;
    const onSelect = vi.fn();
    const { rerender } = render(
      <Overview data={data} spot={null} trade={null} contracts={1} chart={false} chain={false} selected={{ cp: 'P', strike: leg.strike }} onSelect={onSelect} />,
    );
    expect(screen.getByText(`Selected strike: ${leg.strike.toLocaleString('en-US')} PE`)).toBeInTheDocument();
    rerender(<Overview data={data} spot={null} trade={null} contracts={1} chart={false} chain={false} selected={{ cp: 'P', strike: 1 }} onSelect={onSelect} />);
    expect(screen.getByText(/^Selected strike: /)).toBeInTheDocument();
  });

  it('with its own chain, a click on a strike selects it', () => {
    render(<Overview data={data} spot={null} trade={null} contracts={1} chart={false} />);
    const k = data.snapshot.atm;
    const row = screen.getByText(k.toLocaleString('en-US'), { selector: 'td.ov-strike' }).closest('tr')!;
    fireEvent.click(row.querySelectorAll('td')[0]!);
    expect(screen.getByText(`Selected strike: ${k.toLocaleString('en-US')} CE`)).toBeInTheDocument();
  });
});
