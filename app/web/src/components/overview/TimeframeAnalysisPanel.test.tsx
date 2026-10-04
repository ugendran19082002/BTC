import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TimeframeAnalysisPanel } from './TimeframeAnalysisPanel';

describe('the timeframe analysis card', () => {
  it('[critical] each timeframe: its trend, what its swings did, and its job in the chain', () => {
    render(<TimeframeAnalysisPanel rows={[
      { tf: '4h', role: 'macro context', trend: 1, label: 'Bullish', structure: 'HH / HL' },
      { tf: '1h', role: 'major structure', trend: -1, label: 'Bearish', structure: 'LH / LL' },
      { tf: '1m', role: 'execution', trend: 0, label: 'Not read', structure: '4 candles' },
    ]} />);
    expect(screen.getByRole('heading', { name: 'Timeframe analysis' })).toBeInTheDocument();
    const t = screen.getByLabelText('timeframe analysis');
    const rows = within(t).getAllByRole('row').map((r) => r.textContent);
    expect(rows).toEqual(['TFDirectionSwingsRole', '4H↑ BullishHH / HLmacro context', '1H↓ BearishLH / LLmajor structure', '1M? Not read4 candlesexecution']);
    expect(within(t).getByLabelText('timeframe trend view')).toHaveTextContent('4H ↑1H ↓1M ?');
  });

  it('says it is reading until the entry board has answered', () => {
    render(<TimeframeAnalysisPanel rows={[]} />);
    expect(screen.getByText('Reading the timeframes…')).toBeInTheDocument();
  });
});
