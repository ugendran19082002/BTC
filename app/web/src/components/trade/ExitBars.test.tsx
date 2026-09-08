import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ExitBars } from '@/components/trade/ExitBars';

/**
 * The bar's job is to turn a percentage into the two things a person actually
 * decides on: the price it exits at, and the money that changes hands. If those
 * are wrong the percentage does not matter.
 */

const base = {
  entry: 10,
  size: 5,
  targetPct: 0,
  stopPct: 0,
  targetOn: false,
  stopOn: false,
  onTargetPct: vi.fn(),
  onStopPct: vi.fn(),
  onTargetOn: vi.fn(),
  onStopOn: vi.fn(),
};

describe('off by default', () => {
  it('shows two unticked boxes and no bars at all', () => {
    render(<ExitBars {...base} />);
    expect(screen.getByRole('checkbox', { name: /take profit/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /stop loss/i })).not.toBeChecked();
    // an unticked box takes one line, not four
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('names the close-out as the real exit when there is no stop', () => {
    render(<ExitBars {...base} liquidationPrice={196.5} />);
    expect(screen.getByText(/close-out/)).toBeInTheDocument();
    expect(screen.getByText('196.50')).toBeInTheDocument();
  });

  it('ticking a box asks for it to be turned on', () => {
    const onStopOn = vi.fn();
    render(<ExitBars {...base} onStopOn={onStopOn} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /stop loss/i }));
    expect(onStopOn).toHaveBeenCalledWith(true);
  });

  it('a percentage set earlier does not apply while the box is unticked', () => {
    render(<ExitBars {...base} targetPct={0.8} stopPct={1.5} />);
    expect(screen.queryByText('2.00')).toBeNull();
    expect(screen.queryByText('25.00')).toBeNull();
  });
});

describe('the target', () => {
  it('shows the buy-back price and the money kept', () => {
    render(<ExitBars {...base} targetOn targetPct={0.8} />);
    expect(screen.getByText('−80%')).toBeInTheDocument();
    // sold at 10, bought back at 2, five contracts
    expect(screen.getByText('2.00')).toBeInTheDocument();
    expect(screen.getByText('$40.00')).toBeInTheDocument();
  });
});

describe('the stop', () => {
  it('shows the buy-back price and the money lost', () => {
    render(<ExitBars {...base} stopOn stopPct={1.5} />);
    expect(screen.getByText('+150%')).toBeInTheDocument();
    // sold at 10, stopped at 25, five contracts
    expect(screen.getByText('25.00')).toBeInTheDocument();
    expect(screen.getByText('$75.00')).toBeInTheDocument();
  });

  it('warns while your thumb is still on it if the stop is past the close-out', () => {
    render(<ExitBars {...base} stopOn stopPct={2} liquidationPrice={25} />);
    expect(screen.getByText(/would never fire/)).toBeInTheDocument();
    expect(screen.getByText(/past the 25.00 close-out/)).toBeInTheDocument();
  });

  it('does not warn when the stop sits safely inside the close-out', () => {
    render(<ExitBars {...base} stopOn stopPct={0.5} liquidationPrice={196} />);
    expect(screen.queryByText(/would never fire/)).toBeNull();
  });
});

describe('dragging', () => {
  it('reports the new percentage', () => {
    const onStopPct = vi.fn();
    render(<ExitBars {...base} stopOn onStopPct={onStopPct} />);
    const stop = screen.getByRole('slider', { name: 'stop percent' });
    stop.focus();
    fireEvent.keyDown(stop, { key: 'ArrowRight' });
    expect(onStopPct).toHaveBeenCalled();
    expect(onStopPct.mock.calls[0]![0]).toBeGreaterThan(0);
  });

  it('is reachable by keyboard, not only by thumb', () => {
    render(<ExitBars {...base} targetOn stopOn />);
    expect(screen.getByRole('slider', { name: 'target percent' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'stop percent' })).toBeInTheDocument();
  });
});

describe('before a quote arrives', () => {
  it('shows no price rather than a made-up one', () => {
    render(<ExitBars {...base} targetOn stopOn entry={null} targetPct={0.5} stopPct={0.5} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
