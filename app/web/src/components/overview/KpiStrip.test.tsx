import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChainResponse } from '@/types/desk';
import type { PerpResponse } from '@/api/desk';
import live from '@/test/fixtures/chain-live.json';
import { KpiStrip } from './MarketPanels';

const data = live as unknown as ChainResponse;
const perp = (fundingRate: number | null) => ({ ticker: { fundingRate } }) as unknown as PerpResponse;
const show = (rate: number | null) =>
  render(<KpiStrip data={data} spot={data.snapshot.spot} iv={null} perp={perp(rate)} now={Date.UTC(2026, 8, 22, 4, 0)} />);

/** The funding tile, read as who pays -- the reference's four cards, in one tile. */
describe('the funding tile', () => {
  it('[critical] 0.0095%: longs pay, bullish, 95 cents on $10,000, green', () => {
    const { container } = show(0.0095);
    expect(screen.getByText('0.0095%')).toBeInTheDocument();
    expect(screen.getByText(/\$10k pays \$0\.95 \/ 8h/)).toBeInTheDocument();
    expect(screen.getByText('Longs pay · bullish')).toBeInTheDocument();
    expect(container.querySelector('.ov-kpi-funding.ov-kpi-up')).not.toBeNull();
  });
  it('[critical] −0.0095%: shorts pay, bearish, red', () => {
    const { container } = show(-0.0095);
    expect(screen.getByText(/\$10k gets \$0\.95 \/ 8h/)).toBeInTheDocument();
    expect(screen.getByText('Shorts pay · bearish')).toBeInTheDocument();
    expect(container.querySelector('.ov-kpi-funding.ov-kpi-down')).not.toBeNull();
  });
  it('0.001% is mild; zero is neutral with no payment', () => {
    show(0.001);
    expect(screen.getByText('Longs pay · mild bullish')).toBeInTheDocument();
  });
  it('zero is neutral', () => {
    show(0);
    expect(screen.getByText('Neutral · no payment')).toBeInTheDocument();
    expect(screen.getByText(/^no payment · next/)).toBeInTheDocument();
  });
  it('the decimal and the rhythm are on hover', () => {
    const { container } = show(0.0095);
    expect(container.querySelector('.ov-kpi-funding')!.getAttribute('title')).toMatch(/0\.000095 as a decimal, every 8 hours\. Longs pay shorts/);
  });
  it('no reading says so rather than inventing one', () => {
    show(null);
    expect(screen.getByText('not read')).toBeInTheDocument();
  });
});
