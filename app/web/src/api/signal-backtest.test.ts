import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSignalBacktest } from '@/api/signal-backtest';
import { getBacktestPortfolio } from '@/api/backtest-saves';
import { BACKTEST_DEFAULTS } from '@/components/report/backtest-words';

/** The most on one strike as it is asked for (22 Oct 2026): only where it is a limit, and skip only where asked. */
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
});
afterEach(() => { vi.unstubAllGlobals(); });
const asked = () => new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://desk').searchParams;
const q = (p: Partial<typeof BACKTEST_DEFAULTS>) => ({ from: '2026-10-14', to: '2026-10-21', params: { ...BACKTEST_DEFAULTS, ...p }, tfs: [], methods: [] });

describe('the most on one strike, asked', () => {
  it('[critical] a per cent under 100 with at most open: sent; skip only when chosen', async () => {
    await getSignalBacktest(q({ deskMax: 111, strikePct: 20 }));
    expect([asked().get('sk'), asked().get('skf')]).toEqual(['20', null]);
    await getSignalBacktest(q({ deskMax: 111, strikePct: 20, strikeFull: 'skip' }));
    expect([asked().get('sk'), asked().get('skf')]).toEqual(['20', 'skip']);
  });

  it('none: at 100%, absent, or with no "at most open" to take a per cent of -- nothing sent, the query as it always was', async () => {
    for (const p of [{ deskMax: 111, strikePct: 100 }, { deskMax: 111 }, { deskMax: 0, strikePct: 20 }]) {
      await getSignalBacktest(q(p));
      expect(asked().has('sk')).toBe(false);
    }
  });

  it('[critical] a run together: the one account\'s strike limit with its limit, and skip only when chosen', async () => {
    await getBacktestPortfolio(['a', 'b'], { from: '2026-10-14', to: '2026-10-21' }, 'shared', { max: 111, ce: 80, pe: 80, sk: 20, skf: 'skip' });
    expect([asked().get('max'), asked().get('sk'), asked().get('skf')]).toEqual(['111', '20', 'skip']);
    await getBacktestPortfolio(['a', 'b'], { from: '2026-10-14', to: '2026-10-21' }, 'shared', { max: 111, ce: 80, pe: 80 });
    expect(asked().has('sk')).toBe(false);
  });
});

describe('the chase guard, asked (22 Oct 2026)', () => {
  it('[critical] sent as from-after-points where it is right; nothing for none or a wrong one', async () => {
    await getSignalBacktest(q({ chase: { from: '07:00', after: '11:00', pts: 400 } }));
    expect(asked().get('chase')).toBe('07:00-11:00-400');
    for (const p of [{}, { chase: { from: '07:00', after: '11:00', pts: 10 } }]) {
      await getSignalBacktest(q(p));
      expect(asked().has('chase')).toBe(false);
    }
  });
});
