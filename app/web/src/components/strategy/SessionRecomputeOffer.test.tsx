import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/** The offer after a lot change saved while a session runs (owner, 20 Nov 2026: "1 & 2"). */

const recomputeSessionLimit = vi.fn();
const post = vi.fn();
vi.mock('@/api/desk', async (orig) => ({ ...(await orig<typeof import('@/api/desk')>()), recomputeSessionLimit: (...a: unknown[]) => recomputeSessionLimit(...a) }));
vi.mock('@/api/client', async (orig) => ({ ...(await orig<typeof import('@/api/client')>()), post: (...a: unknown[]) => post(...a) }));
const { SessionRecomputeOffer } = await import('@/components/strategy/SessionRecomputeOffer');
const { offerSessionRecompute } = await import('@/lib/session-recompute-offer');
const { saveStrategy } = await import('@/api/strategy');

const OFFER = { accountId: 3, accountName: 'Low', beforeInr: 1430, afterInr: 2860, from: '07:00', to: '15:00' };

beforeEach(() => { recomputeSessionLimit.mockReset(); post.mockReset(); act(() => offerSessionRecompute(null)); });

describe('Session limit offer after a lot change', () => {
  it('[critical] a save that comes back with the offer shows it, by account, with now and with the new lots', async () => {
    post.mockResolvedValue({ ok: true, strategy: { id: 's' }, sessionRecompute: OFFER });
    render(<SessionRecomputeOffer />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => { await saveStrategy({ id: 's', name: 's', config: { lots: 2 } as never }); });
    const box = screen.getByRole('alertdialog', { name: 'Recompute the session limit' });
    expect(box).toHaveTextContent('Low');
    expect(box).toHaveTextContent('₹1,430');
    expect(box).toHaveTextContent('₹2,860');
  });

  it('a save without it shows nothing', async () => {
    post.mockResolvedValue({ ok: true, strategy: { id: 's' } });
    render(<SessionRecomputeOffer />);
    await act(async () => { await saveStrategy({ id: 's', name: 's', config: { lots: 1 } as never }); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('[critical] "Recompute now" works it out for that account; "Keep" changes nothing', async () => {
    recomputeSessionLimit.mockResolvedValue({ ok: true, from: '07:00', to: '15:00', limit: 18, beforeInr: 1430, afterInr: 2860, lossInr: 0 });
    render(<SessionRecomputeOffer />);
    act(() => offerSessionRecompute(OFFER));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep ₹1,430' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(recomputeSessionLimit).not.toHaveBeenCalled();
    act(() => offerSessionRecompute(OFFER));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Recompute now' }));
    await waitFor(() => expect(recomputeSessionLimit).toHaveBeenCalledWith(3));
    expect(await screen.findByRole('status')).toHaveTextContent('Low: session limit now ₹2,860 until 15:00.');
  });

  it('a refusal from the server is said, not swallowed', async () => {
    recomputeSessionLimit.mockRejectedValue(new Error('Stopped for today.'));
    render(<SessionRecomputeOffer />);
    act(() => offerSessionRecompute(OFFER));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Recompute now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Low: not recomputed. Stopped for today.');
  });
});
