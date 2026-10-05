import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllTrades } from '@/api/trade';
import { setAccountScope } from '@/lib/account-scope';

/**
 * Close all names the account it is pressed for (5 Oct 2026).
 *
 * It sent an empty body, and the server answers a request that names no account as the default account's desk:
 * pressed on the BUY account's tab it squared off the SELL account's two positions and left the BUY position on.
 */
const fetchMock = vi.fn();
const answer = { ok: true, cancelled: [], closed: [], failed: [] };

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } }));
});
afterEach(() => { setAccountScope(null); vi.unstubAllGlobals(); });

const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};

describe('close all', () => {
  it('[critical] is sent for the account whose tab is showing', async () => {
    setAccountScope(2);
    await closeAllTrades();
    expect(sent()).toEqual({ url: '/api/trade/close-all', body: { accountId: 2 } });
  });

  it('names none on All accounts, where the default account\'s positions are the ones shown', async () => {
    setAccountScope(null, true);
    await closeAllTrades();
    expect(sent()).toEqual({ url: '/api/trade/close-all', body: {} });
  });
});
