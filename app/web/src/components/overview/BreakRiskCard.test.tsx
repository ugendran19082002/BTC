import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { risk } from '@/test/fixtures/break-risk';
import { BreakRiskCard } from './BreakRiskCard';

const NOW = 1_800_000; // half-way through the fixture's hour

describe('the big move risk card', () => {
  it('while loading, says so', () => {
    render(<BreakRiskCard risk={undefined} now={NOW} strikes={[]} />);
    expect(screen.getByText(/Reading the last hour/)).toBeInTheDocument();
  });

  it('with no break this hour, is quiet and says what it would show', () => {
    render(<BreakRiskCard risk={null} now={NOW} strikes={[]} />);
    expect(screen.getByText('Quiet')).toBeInTheDocument();
    expect(screen.getByText(/never calls a direction/)).toBeInTheDocument();
  });

  it('[critical] an hour that has ended is quiet, whatever the last read said', () => {
    render(<BreakRiskCard risk={risk({ until: NOW - 1 })} now={NOW} strikes={[]} />);
    expect(screen.getByText('Quiet')).toBeInTheDocument();
  });

  it('[critical] sizes the hour and calls the direction a coin flip, never a buy or a sell', () => {
    const { container } = render(<BreakRiskCard risk={risk()} now={NOW} strikes={[]} />);
    expect(screen.getByText('±440 pts')).toBeInTheDocument();
    expect(screen.getByText(/usual hour ±325 \(\+35%\)/)).toBeInTheDocument();
    expect(screen.getByText('±1,130 pts')).toBeInTheDocument();
    expect(screen.getByText('Coin flip')).toBeInTheDocument();
    expect(screen.getByText('46% kept going ↑')).toBeInTheDocument();
    expect(screen.getByText('30m left')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b(buy|sell|target|stop loss)\b/i);
  });

  it('draws the zones as prices from the break\'s close, both ways', () => {
    render(<BreakRiskCard risk={risk()} now={NOW} strikes={[]} />);
    const withRow = screen.getByText('↑ with the break').closest('tr')!;
    expect([...withRow.querySelectorAll('td')].map((t) => t.textContent)).toEqual(['84,350', '84,600', '85,000']);
    const againstRow = screen.getByText('↓ against it').closest('tr')!;
    expect([...againstRow.querySelectorAll('td')].map((t) => t.textContent)).toEqual(['83,860', '83,670', '83,350']);
  });

  it('[critical] a held short in the way is flagged with what to consider; a desk pick is not', () => {
    const { rerender } = render(<BreakRiskCard risk={risk()} now={NOW} strikes={[{ strike: 84_400, cp: 'C', held: true }]} />);
    expect(screen.getByText('In the way')).toBeInTheDocument();
    expect(screen.getByText('1 in 4 reached it')).toBeInTheDocument();
    expect(screen.getByText(/consider closing, rolling or hedging/)).toBeInTheDocument();
    rerender(<BreakRiskCard risk={risk()} now={NOW} strikes={[{ strike: 84_400, cp: 'C', held: false }]} />);
    expect(screen.getByText('In the way')).toBeInTheDocument();
    expect(screen.queryByText(/consider closing/)).toBeNull();
  });
});
