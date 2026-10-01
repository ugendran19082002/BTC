import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TradeClock } from './TradeClock';
import type { MethodRead, SetupClock } from '@/types/entry';

const NOW = Math.floor(Date.now() / 1000);
const read = (paper: SetupClock | null): MethodRead => ({
  id: 'liquidity-sweep', n: 3, name: 'Liquidity sweep', group: 'reversal', summary: '', mode: 'single', tf: '5m', dir: 'long', state: 'TRADE',
  steps: [], gates: [], plan: null, score: 60, scoreParts: [], alignment: null, reason: '', triggerTime: NOW - 400, paper,
});
const clock = (over: Partial<SetupClock> = {}): SetupClock => ({
  status: 'open', firstSeen: (NOW - 97) * 1000, fillBy: NOW + 125, filledAt: null, fillPrice: null, timeoutAt: null, exitAt: null, exitPrice: null,
  alertAt: (NOW - 96) * 1000, tp1At: null, tp2At: null, tp3At: null, runner: null, runnerEnd: null, ...over,
});

describe('the entry clock on the selected TRADE', () => {
  it('[critical] after the signal: the bar close, when it was seen and the alert went (with their lag), and the fill window counting down', () => {
    render(<TradeClock read={read(clock())} />);
    const c = screen.getByRole('region', { name: 'entry clock' });
    expect(within(c).getByLabelText('counter')).toHaveTextContent(/Fill window closes in 2:0[3-5]/);
    expect(c).toHaveTextContent('Seen');
    expect(c).toHaveTextContent('(+3 s)'); // the bar closed 100 s ago, seen 97 s ago
    expect(c).toHaveTextContent('(+4 s)'); // the alert a second later
  });

  it('[critical] in the trade: since when, at what fill, and the time-out counting down; a runner after TGT1 says so', () => {
    const { rerender } = render(<TradeClock read={read(clock({ status: 'filled', filledAt: NOW - 65, fillPrice: 84_210, timeoutAt: NOW + 3_600 }))} />);
    expect(screen.getByLabelText('counter')).toHaveTextContent(/In the trade 1:0[5-7] · time-out in (1:00:00|59:5\d)/);
    expect(screen.getByRole('region', { name: 'entry clock' })).toHaveTextContent('@ 84,210');
    rerender(<TradeClock read={read(clock({ status: 'tp1', filledAt: NOW - 600, fillPrice: 84_210, timeoutAt: NOW + 3_600, tp1At: NOW - 60, runner: 'running' }))} />);
    expect(screen.getByLabelText('counter')).toHaveTextContent('Runner, stop at breakeven TGT2 next');
  });

  it('before the paper log has written it, it counts from the signal bar and says it is being written', () => {
    render(<TradeClock read={read(null)} />);
    expect(screen.getByLabelText('counter')).toHaveTextContent(/Since the signal bar closed 1:(39|40|41)/);
    expect(screen.getByText(/Being written to the paper log/)).toBeInTheDocument();
  });
});
