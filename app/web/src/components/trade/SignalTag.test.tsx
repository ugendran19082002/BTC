import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignalTag } from '@/components/trade/SignalTag';
import type { Trade } from '@/types/trade';

/** A signal strategy's trade on Positions and Orders: the method, BUY or SELL, the timeframe, and the perp SL / TGT. */
const plan = (o: Partial<NonNullable<Trade['plan']>> = {}) => ({
  lots: 1, origin: 'strategy', strategyId: 'sig', strategyName: 'Breakout PE',
  entry: { type: 'limit', timeoutMs: 0, marketFallback: false }, takeProfitPrice: 1, stopPrice: 40,
  signal: { method: 'breakout', n: 1, name: 'Breakout', mode: 'single', tf: '15m', dir: 1, triggerTime: 1 },
  underlying: { dir: 1, stop: 84_600, target: 85_500, source: 'BTC perp' },
  ...o,
}) as NonNullable<Trade['plan']>;

describe('the signal on a trade row', () => {
  it('[critical] the method, BUY, the timeframe, and the perp SL and TGT', () => {
    render(<SignalTag plan={plan()} />);
    expect(screen.getByLabelText('signal')).toHaveTextContent('#1 Breakout · BUY · 15m');
    expect(screen.getByLabelText('perp exits')).toHaveTextContent('perp SL 84,600 · TGT 85,500');
  });
  it('[critical] the perp entry, when there is one, before the SL and TGT', () => {
    render(<SignalTag plan={plan({ underlying: { dir: 1, stop: 86_398, target: 85_353, source: 'BTC perp', entry: 85_870 } })} />);
    expect(screen.getByLabelText('perp exits')).toHaveTextContent('perp entry 85,870 · SL 86,398 · TGT 85,353');
  });

  it('with the timeframe chain, and a SELL', () => {
    render(<SignalTag plan={plan({ signal: { method: 'bos', n: 6, name: 'BOS', mode: 'mtf', tf: '5m', dir: -1, triggerTime: 1 } })} />);
    expect(screen.getByLabelText('signal')).toHaveTextContent('#6 BOS · SELL · 5m + TF chain');
  });
  it('nothing on a trade that was not a signal\'s', () => {
    const { container } = render(<SignalTag plan={plan({ signal: null, underlying: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
