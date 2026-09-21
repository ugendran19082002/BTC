import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChainResponse } from '@/types/desk';
import type { MovementRow } from '@/api/desk';
import live from '@/test/fixtures/chain-live.json';
import { expectedMove, mtfConsensus } from '@/lib/overview';
import { MovementPanel } from './TraderPanels';

const data = live as unknown as ChainResponse;
const row = (minutes: number, type: MovementRow['type'], direction: MovementRow['direction']): MovementRow => ({
  minutes, pricePct: 0.3, oiPct: 0.5, volumeRatio: 1.6, cvd: 10, aggressorBuyPct: 0.6, type, direction, strength: 'STRONG', flow: 'CONFIRMS', thresholds: { pricePct: 0.1, oiPct: 0.3 },
});

describe('MovementPanel', () => {
  it('says what each move type means for the price, and nothing for a mixed one', () => {
    render(<MovementPanel data={data} em={expectedMove(data.snapshot)} activeMin={720} mtf={mtfConsensus(data.market, data.outlook)}
      movement={[row(5, 'LONG_BUILDUP', 'UP'), row(15, 'SHORT_BUILDUP', 'DOWN'), row(60, 'SHORT_COVERING', 'UP'), row(360, 'LONG_UNWINDING', 'DOWN'), row(720, 'MIXED', null)]} />);
    expect(screen.getByText('Bullish pressure')).toHaveClass('ov-up');
    expect(screen.getByText('Bearish pressure')).toHaveClass('ov-down');
    expect(screen.getByText('Potential bullish')).toHaveClass('ov-up');
    expect(screen.getByText('Potential bearish')).toHaveClass('ov-down');
    expect(document.querySelectorAll('.ov-mtf-pressure')).toHaveLength(4);
  });
});
