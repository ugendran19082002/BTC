import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { OptionFlowSummary, SideFlow } from '@/api/desk';

/** Pressure, under More (owner, 7 Oct 2026): the option tape a side at a time, and the big-move readings. */

const getChain = vi.fn(), getPerp = vi.fn(), getChanges = vi.fn();
vi.mock('@/api/desk', () => ({
  getChain: (...a: unknown[]) => getChain(...a), getPerp: (...a: unknown[]) => getPerp(...a), getChanges: (...a: unknown[]) => getChanges(...a),
}));

const { PressureScreen } = await import('@/components/mobile/screens/PressureScreen');

const side = (o: Partial<SideFlow>): SideFlow => ({
  buyVolume: 1_606_500, sellVolume: 2_063_100, deltaVolume: -456_634, trades: 15_472, aggressorBuyPct: 0.438, pressure: 'SELL PRESSURE',
  strikes: [{ strike: 87_000, buyVolume: 183_400, sellVolume: 200_000 }, { strike: 87_400, buyVolume: 100_000, sellVolume: 159_400 }],
  cvd: [{ at: 1, cvd: -100, delta: -100 }, { at: 2, cvd: -456_634, delta: -300 }], ...o,
});
const FLOW: OptionFlowSummary = {
  expiry: '071026', windowMin: 60, minutesCovered: 60, source: 'socket',
  ce: side({}),
  pe: side({ buyVolume: 1_680_900, sellVolume: 1_416_900, deltaVolume: 263_987, trades: 19_888, aggressorBuyPct: 0.543, pressure: 'BALANCED', strikes: [{ strike: 83_200, buyVolume: 300_000, sellVolume: 322_800 }], cvd: [{ at: 1, cvd: 10, delta: 10 }, { at: 2, cvd: 263_987, delta: 5 }] }),
  combined: { buyVolume: 3_287_400, sellVolume: 3_480_000, deltaVolume: -192_647, bias: 'MIXED' },
};
const leg = (cp: 'C' | 'P', strike: number, bidSize: number, askSize: number) => ({ cp, strike, bid: 39.5, ask: 40.5, bidSize, askSize, mark: 40, oi: 100, iv: 0.5, volume: 10 });
const PE = leg('P', 83_200, 10, 10);
const CHAIN = {
  snapshot: { expiry: '071026', atm: 83_800, spot: 83_774, live: true },
  legs: [leg('C', 83_800, 60, 40), leg('P', 83_800, 121, 79), PE],
  recommendation: { sides: [{ side: 'PE', leg: PE }] }, best: { pick: null, bestOfNone: false },
  structure: { ceOi: 1, peOi: 2, ceVolume: 3, peVolume: 4, pcrOi: 2, atmIv: 0.5 },
  // a 5m bar at 1.92x its median: 96% of the way to the volume-burst trigger
  market: { volume: [{ tf: '5m', spike: 1.92 }], moves: [{ label: 'last 15m', changePct: -0.1 }] },
  outlook: { rows: [{ minutes: 15, impliedUsd: 300, spot: 83_774 }] },
  shocks: [{ score: 80, band: 'sudden' }],
};
const PERP = {
  at: 1, ticker: { fundingRate: 0.0001 }, book: { imbalance: 0.1 }, optionFlow: FLOW,
  flow: { aggressorBuyPct: 0.4, cvd: [], minutesCovered: 60, totalVolume: 1000 },
  oi: { ceChange1h: 0, peChange1h: 0, ceAcceleration: 0, peAcceleration: 0 },
};

beforeEach(() => {
  for (const m of [getChain, getPerp, getChanges]) m.mockReset();
  getChain.mockResolvedValue(CHAIN);
  getPerp.mockResolvedValue(PERP);
  getChanges.mockResolvedValue({ rows: [{ minutes: 15, markChangePct: 2, atmIvChangePts: 0.1 }] });
});

describe('PressureScreen', () => {
  it('[critical] each side of the option tape: bought against sold, its delta, its book, its busiest strikes, and what it reads as', async () => {
    render(<PressureScreen />);
    const ce = (await screen.findByText('CE flow')).closest('h2')!.parentElement!.parentElement!;
    expect(ce).toHaveTextContent('CALL');
    expect(ce).toHaveTextContent('SELL PRESSURE');
    expect(ce).toHaveTextContent('Buy 1,606.5K');
    expect(ce).toHaveTextContent('2,063.1K Sell');
    expect(within(ce).getByRole('img', { name: '44% bought, 56% sold' })).toBeInTheDocument();
    expect(within(ce).getByText('Delta').parentElement!).toHaveTextContent('−456,634');
    expect(within(ce).getByText('Aggressor buys').parentElement!).toHaveTextContent('43.8%');
    expect(within(ce).getByText('Trades').parentElement!).toHaveTextContent('15,472');
    // the at-the-money call's top of book: (60 − 40) ÷ 100, and a 1-point spread on a 40 mid
    expect(within(ce).getByText('Book · 83,800').parentElement!).toHaveTextContent('+20%');
    expect(within(ce).getByText('Spread').parentElement!).toHaveTextContent('2.5%');
    expect(ce).toHaveTextContent('87,000 383.4K');
    expect(within(ce).getByRole('img', { name: /CE flow: cumulative volume delta/ })).toBeInTheDocument();
    const pe = screen.getByText('PE flow').closest('h2')!.parentElement!.parentElement!;
    expect(pe).toHaveTextContent('PUT');
    expect(pe).toHaveTextContent('BALANCED');
    expect(within(pe).getByText('Book · 83,800').parentElement!).toHaveTextContent('+21%');
    // the two together
    const all = screen.getByText('Overall option flow').parentElement!.parentElement!;
    expect(all).toHaveTextContent('MIXED');
    expect(all).toHaveTextContent('Buy 3,287.4K');
    expect(all).toHaveTextContent('−192,647');
    expect(screen.getByText('60 of 60 min · 071026')).toBeInTheDocument();
    // asked for the chain's own expiry, over the hour
    expect(getPerp).toHaveBeenCalledWith(60, '071026');
  });

  it('[critical] big move catch: every reading with its score, its lamp, and the reading and threshold in words', async () => {
    render(<PressureScreen />);
    const list = within(await screen.findByRole('list', { name: 'Big move readings' }));
    const rows = list.getAllByRole('listitem');
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const burst = rows.find((r) => r.textContent!.includes('Volume burst'))!;
    expect(burst).toHaveTextContent('96/100');
    expect(burst).toHaveTextContent('WATCH');
    expect(burst).toHaveTextContent('1.9× median · triggers ≥ 2.0×');
    expect(within(burst).getByRole('meter', { name: 'Volume burst score' })).toHaveAttribute('aria-valuenow', '96');
    expect(screen.getByText(/Measured sudden-move score 80 \(sudden\)/)).toBeInTheDocument();
    expect(screen.getByText(/^(CALM|WATCH|HIGH|SUDDEN) · \d+\/100$/)).toBeInTheDocument();
    // the strike the premium and IV changes are read on is the desk's own pick, the put first
    expect(getChanges).toHaveBeenCalledWith('P-BTC-83200-071026', expect.objectContaining({ spot: 83_774, mark: 40, pcr: 2 }));
    expect(screen.getByText(/read on 83,200 PE, the desk's own pick/)).toBeInTheDocument();
  });

  it('an answer that is not a chain (an error\'s body, another shape) is "not read", not a crash', async () => {
    getChain.mockResolvedValue({ error: 'upstream' });
    render(<PressureScreen />);
    await vi.waitFor(() => expect(getChain).toHaveBeenCalled());
    expect(screen.queryByText('Big move catch')).toBeNull();
    expect(getPerp).not.toHaveBeenCalled();
  });

  it('no option prints: says so, and the big-move readings are still there', async () => {
    getPerp.mockResolvedValue({ ...PERP, optionFlow: { ...FLOW, source: 'none' } });
    render(<PressureScreen />);
    expect(await screen.findByText(/No option prints in the last hour/)).toBeInTheDocument();
    expect(screen.queryByText('CE flow')).toBeNull();
    expect(screen.getByRole('list', { name: 'Big move readings' })).toBeInTheDocument();
  });
});
