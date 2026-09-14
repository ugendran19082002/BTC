import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SuddenMove } from '@/components/desk/SuddenMove';
import type {
  MarketRead, OptionStructure, SnapshotMeta, SuddenMove as Shock,
} from '@/types/desk';

/**
 * Whether something is happening right now.
 *
 * Two properties carry the panel. Every reading shows the two numbers behind
 * its headline — a ratio says how unusual something is and nothing about
 * whether it is worth anything, so "3.2×" without "12.4k against a 3.8k
 * median" is unreadable. And a reading the desk *cannot take* says so rather
 * than showing a zero: before the first five-minute bucket there is no
 * volatility history, and printing +0.0% would report calm on the strength of
 * not knowing, which is the one failure that gets somebody short into a move.
 */

const snap = {
  ts: 1_789_000_000,
  spot: 76_841, atmIv: 0.287, expectedMove: 832, live: true,
  expiry: '140926', hoursToExpiry: 20,
} as unknown as SnapshotMeta;

const structure = {
  pcrOi: 0.44, ceOi: 2_250_000, peOi: 1_000_000, ceVolume: 5_000, peVolume: 3_800,
} as unknown as OptionStructure;

const market = { return24h: -0.03, high24h: 78_431, low24h: 76_102 } as unknown as MarketRead;

const shock = (over: Partial<Shock> = {}): Shock => ({
  score: 12,
  band: 'normal',
  parts: [
    {
      name: 'Move against expected', value: 0.1, weight: 0.3,
      note: '0.40× the 5-minute expected move',
      detail: { headline: '0.4×', now: '5m range: 0.33%', before: 'Expected (5m): 0.83%' },
    },
    {
      name: 'Volume spike', value: 0, weight: 0.25,
      note: '1.0× the 20-bar median',
      detail: { headline: '1.0×', now: 'Current: 3.9k', before: '20-bar median: 3.8k' },
    },
    { name: 'Volatility repricing', value: 0, weight: 0.2, note: null, detail: null },
    { name: 'Open interest moving', value: 0, weight: 0.15, note: null, detail: null },
    {
      name: 'One-sided positioning', value: 0.4, weight: 0.1,
      note: '0.44 puts per call',
      detail: { headline: '0.44', now: 'PE OI: 1.00M', before: 'CE OI: 2.25M' },
    },
  ],
  reasons: [],
  direction: 0,
  directionLabel: 'no clear side',
  directionParts: [],
  odds: { overMinutes: 240, thresholdPct: 1, up: 0.09, down: 0.10, inside: 0.81, either: 0.19 },
  window: 5,
  ...over,
});

const panel = (over: Partial<Shock> = {}, onWindow = () => {}) =>
  render(
    <SuddenMove
      shocks={[shock(over)]} window={5} onWindow={onWindow}
      snap={snap} structure={structure} market={market}
    />,
  );

describe('sudden move analytics', () => {
  it('[critical] draws nothing at all when it could not take a single reading', () => {
    const { container } = render(
      <SuddenMove
        shocks={[shock({ score: null })]} window={5} onWindow={() => {}}
        snap={snap} structure={structure} market={market}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the risk, its band and what the band means', () => {
    panel({ score: 72, band: 'high' });
    expect(screen.getByRole('img', { name: '72 out of 100' })).toBeInTheDocument();
    expect(screen.getByText('High risk')).toBeInTheDocument();
    expect(screen.getByText('Abnormal move possible in the next few hours')).toBeInTheDocument();
  });

  it('[critical] every reading carries the two numbers behind its headline', () => {
    panel();
    expect(screen.getByText('5m range: 0.33%')).toBeInTheDocument();
    expect(screen.getByText('Expected (5m): 0.83%')).toBeInTheDocument();
    expect(screen.getByText('Current: 3.9k')).toBeInTheDocument();
    expect(screen.getByText('20-bar median: 3.8k')).toBeInTheDocument();
  });

  it('[critical] a reading it cannot take says so rather than showing a zero', () => {
    panel();
    expect(screen.getByText('No reading yet')).toBeInTheDocument();
    expect(screen.getByText('The desk records one every five minutes')).toBeInTheDocument();
    expect(screen.queryByText('+0.0%')).not.toBeInTheDocument();
  });

  it('names what is raised, and stays quiet when nothing is', () => {
    expect(panel().container.querySelector('.smr-reasons')).toBeNull();

    panel({
      score: 78, band: 'sudden',
      reasons: ['5m volume is 4.0× its median', 'implied volatility is up 9.0% in 15 minutes'],
    });
    expect(screen.getByText('5m volume is 4.0× its median')).toBeInTheDocument();
  });

  it('[critical] breaks the direction into the readings it is made of', () => {
    panel({
      direction: -0.68,
      directionLabel: 'downside pressure',
      directionParts: [
        { name: 'Price momentum', value: -0.72 },
        { name: 'Call against put activity', value: -0.61 },
      ],
    });
    expect(screen.getByText('Downside 68%')).toBeInTheDocument();
    expect(screen.getByText('Price momentum')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
  });

  it('says there is no side rather than picking one', () => {
    panel();
    expect(screen.getByText('No clear side')).toBeInTheDocument();
  });

  it('says so when nothing readable points either way', () => {
    panel({ direction: null, directionParts: [] });
    expect(screen.getByText('Nothing readable points either way')).toBeInTheDocument();
  });

  it('carries the market the readings were taken from', () => {
    panel();
    expect(screen.getByText('76,841')).toBeInTheDocument();
    expect(screen.getByText('78,431')).toBeInTheDocument();
    expect(screen.getByText('76,102')).toBeInTheDocument();
    expect(screen.getByText('28.7%')).toBeInTheDocument();
    expect(screen.getByText('0.44')).toBeInTheDocument();
    expect(screen.getByText('2.25M')).toBeInTheDocument();
  });

  it('[critical] the odds say which horizon they were counted over', () => {
    panel();
    const odds = screen.getByText(/How often a move like this followed/)
      .closest('.smr-odds') as HTMLElement;
    expect(within(odds).getByText('9%')).toBeInTheDocument();
    expect(within(odds).getByText('10%')).toBeInTheDocument();
    expect(within(odds).getByText('81%')).toBeInTheDocument();
    expect(screen.getByText(/over the next 4 hours, measured/)).toBeInTheDocument();
  });

  it('[critical] the three outcomes on screen add to a hundred', () => {
    // Three boxes read as a breakdown. Up and down and "either side" is up plus
    // down again, which does not add up and leaves out the outcome a seller is
    // actually hoping for.
    panel();
    const odds = screen.getByText(/How often a move like this followed/)
      .closest('.smr-odds') as HTMLElement;
    const shown = [...odds.querySelectorAll('.smr-odd b')]
      .map((b) => Number(b.textContent!.replace('%', '')));
    expect(shown).toHaveLength(3);
    expect(shown.reduce((a, v) => a + v, 0)).toBe(100);
  });

  it('leaves the odds out entirely when there is no table to count from', () => {
    panel({ odds: null });
    expect(screen.queryByText(/How often a move like this followed/)).not.toBeInTheDocument();
  });

  it('shows a dash where the market itself is unreadable', () => {
    render(
      <SuddenMove
        shocks={[shock()]} window={5} onWindow={() => {}}
        snap={snap} structure={structure} market={null}
      />,
    );
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('says on its face that nothing trades on it', () => {
    panel();
    expect(screen.getByText(/Nothing on the trading side reads any of this/)).toBeInTheDocument();
  });
});

/**
 * The window control.
 *
 * Five minutes says whether something is happening *now*; four hours says
 * whether the session has been unusual. They are different questions, so the
 * control has to actually change the readings — a toggle that redraws the same
 * numbers is a control that lies about what it does.
 */
describe('choosing the window', () => {
  const at = (window: number, headline: string): Shock => ({
    ...shock(),
    window,
    parts: [{
      name: 'Move against expected', value: 0.1, weight: 0.3, note: `${headline} whatever`,
      detail: { headline, now: `${window}m range: 1.00%`, before: `Expected (${window}m): 0.50%` },
    }],
  });

  const both = [at(5, '0.4×'), at(240, '2.1×')];

  it('[critical] shows the reading for the window it is on', () => {
    const { unmount } = render(
      <SuddenMove shocks={both} window={5} onWindow={() => {}} snap={snap} structure={structure} market={market} />,
    );
    expect(screen.getByText('0.4×')).toBeInTheDocument();
    expect(screen.getByText('5m range: 1.00%')).toBeInTheDocument();
    unmount();

    render(
      <SuddenMove shocks={both} window={240} onWindow={() => {}} snap={snap} structure={structure} market={market} />,
    );
    expect(screen.getByText('2.1×')).toBeInTheDocument();
    expect(screen.getByText('240m range: 1.00%')).toBeInTheDocument();
  });

  it('offers every window the server computed, and marks the one showing', () => {
    render(
      <SuddenMove shocks={both} window={240} onWindow={() => {}} snap={snap} structure={structure} market={market} />,
    );
    expect(screen.getByRole('radio', { name: '5m' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: '4h' })).toHaveAttribute('aria-checked', 'true');
  });

  it('asks for a window rather than fetching one', () => {
    const onWindow = vi.fn();
    render(
      <SuddenMove shocks={both} window={5} onWindow={onWindow} snap={snap} structure={structure} market={market} />,
    );
    screen.getByRole('radio', { name: '4h' }).click();
    expect(onWindow).toHaveBeenCalledWith(240);
  });

  it('falls back to the first reading when the stored window is not offered', () => {
    render(
      <SuddenMove shocks={both} window={999} onWindow={() => {}} snap={snap} structure={structure} market={market} />,
    );
    expect(screen.getByText('0.4×')).toBeInTheDocument();
  });

  it('says when it last read the board', () => {
    render(
      <SuddenMove shocks={both} window={5} onWindow={() => {}} snap={snap} structure={structure} market={market} />,
    );
    expect(screen.getByText('Last updated')).toBeInTheDocument();
    expect(screen.getByText(/IST$/)).toBeInTheDocument();
  });
});
