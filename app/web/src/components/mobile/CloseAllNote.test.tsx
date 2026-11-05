import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CloseAllNote } from '@/components/mobile/CloseAllNote';
import { signedInr, usdToInr } from '@/lib/format';
import type { Trade } from '@/types/trade';

/**
 * Home's day and Positions' total, the gap between them said on both (owner, 4 Nov 2026: "morning start aakum pothu home
 * pnl amount and position pnl match aakutha ilaya doubt iruku"). Two shorts open in the morning: at the mark −0.0021 and
 * +0.008, closed now −0.0053 and +0.006.
 */
const open = (unrealised: number, paid: number, ifClosed: number) => ({
  realisedPnl: 0, live: { markPrice: 1, unrealisedPnl: unrealised, decayed: null, netIfClosedUsd: ifClosed },
  charges: { entryUsd: paid, exitUsd: 0, paidUsd: paid, toCloseUsd: 0.001 },
}) as unknown as Trade;
const OPEN = [open(-0.0005, 0.0016, -0.0053), open(0.01, 0.002, 0.006)];
const money = (usd: number) => signedInr(Math.round(usdToInr(usd)!));

describe('CloseAllNote', () => {
  it('[critical] Home: the day closed now is the day at the mark less the cost of leaving -- the number Positions totals', () => {
    // The day at the mark: 0.003 booked earlier today, the two open at the mark, today's charges -- as the server sends it.
    const day = 0.003 + (-0.0021 + 0.008);
    render(<CloseAllNote on="home" open={OPEN} dayNetUsd={day} />);
    const cost = (-0.0021 + 0.008) - (-0.0053 + 0.006);
    const line = screen.getByLabelText('If every position closed now');
    expect(within(line).getByText('If you close all now').nextSibling).toHaveTextContent(money(day - cost));
    expect(within(line).getByText('Exit cost (spread + charges)').nextSibling).toHaveTextContent(money(-cost));
    // With nothing booked today, closing all now is exactly Positions' total.
    expect(day - 0.003 - cost).toBeCloseTo(-0.0053 + 0.006, 12);
  });

  it('[critical] Positions: the same trades at the mark, Home\'s way, and what closing pays beyond it', () => {
    render(<CloseAllNote on="positions" open={OPEN} />);
    const line = screen.getByLabelText('At the mark');
    expect(within(line).getByText("At mark (Home's P&L)").nextSibling).toHaveTextContent(money(-0.0021 + 0.008));
    expect(within(line).getByText('Exit cost (spread + charges)').nextSibling).toHaveTextContent(money(-((-0.0021 + 0.008) - (-0.0053 + 0.006))));
  });

  it('nothing open, or nothing priced yet: nothing said', () => {
    const { container, rerender } = render(<CloseAllNote on="home" open={[]} dayNetUsd={0.01} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CloseAllNote on="positions" open={[{ ...OPEN[0]!, live: undefined } as Trade]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
