import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ChainResponse, Leg } from '@/types/desk';
import live from '@/test/fixtures/chain-live.json';
import { ChangesPanel, useChanges } from './TraderPanels';

const getChanges = vi.fn();
vi.mock('@/api/desk', () => ({ getChanges: (...a: unknown[]) => getChanges(...a) }));

const data = live as unknown as ChainResponse;
const legOf = (cp: 'C' | 'P') => data.legs.find((l) => l.cp === cp && l.moneyness === 'OTM')!;
const answer = (mark: number) => ({
  rows: [{ minutes: 60, markThen: mark, markChange: 1, markChangePct: 10, spotChangePct: 0, oiChange: 0, oiThen: 10, ivChangePts: 0, volumeChange: 0, pTouchThen: null, pTouchNow: null, emDistanceThen: null, emDistanceNow: null }],
  momentum: { velocity: null, acceleration: null },
  model: { pOtm: null, pTouch: null, emDistance: null },
});

/** The card reads one strike's record. When the strike changes, so must the card. */
function Harness({ leg }: { leg: Leg }) {
  const changes = useChanges(data, leg, data.snapshot.spot, null);
  return <ChangesPanel strikes={[{ leg, changes }]} />;
}

describe('what changed, for the strike that is actually selected', () => {
  it('[critical] a new strike never shows the old strike\'s numbers under its name', async () => {
    let resolve: (v: unknown) => void = () => {};
    getChanges.mockImplementationOnce(() => Promise.resolve(answer(10)))
      .mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const ce = legOf('C');
    const pe = legOf('P');
    const { rerender } = render(<Harness leg={ce} />);
    await waitFor(() => expect(screen.getByText(/^What changed · /)).toHaveTextContent(`${ce.strike.toLocaleString('en-US')} CE`));
    await screen.findByText((t) => t.replace(/\s+/g, ' ').includes('10.0 →'));

    // the strike changes; its record has not arrived yet
    rerender(<Harness leg={pe} />);
    expect(screen.getByText(/^What changed · /)).toHaveTextContent(`${pe.strike.toLocaleString('en-US')} PE`);
    expect(screen.getByText(/^Reading the record for /)).toBeInTheDocument();
    expect(screen.queryByText((t) => t.replace(/\s+/g, ' ').includes('10.0 →'))).toBeNull();

    // and when it lands, it is this strike's
    await act(async () => { resolve(answer(20)); });
    await screen.findByText((t) => t.replace(/\s+/g, ' ').includes('20.0 →'));
  });

  it('asks the server once per strike, for that strike', async () => {
    getChanges.mockResolvedValue(answer(10));
    getChanges.mockClear();
    const ce = legOf('C');
    render(<Harness leg={ce} />);
    await waitFor(() => expect(getChanges).toHaveBeenCalled());
    expect(getChanges.mock.calls[0]![0]).toContain(`${ce.cp}-BTC-${ce.strike}-`);
  });
});
