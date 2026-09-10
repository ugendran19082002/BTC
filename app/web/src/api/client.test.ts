import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetNetworkFailures, json, NotSignedIn, pathOf } from '@/api/client';

/**
 * What reaches the error log, and what does not.
 *
 * The log is only useful if everything in it needs fixing. The live log had
 * four `Failed to fetch` rows in it, all of them the poll running while the
 * container restarted under a deploy -- the desk working correctly, recorded as
 * a fault, next to the one row that mattered.
 */

vi.mock('@/lib/report-error', () => ({ reportError: vi.fn() }));
const { reportError } = await import('@/lib/report-error');
const reported = reportError as unknown as ReturnType<typeof vi.fn>;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  reported.mockReset();
  forgetNetworkFailures();
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fails = () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

describe('a network failure', () => {
  it('is not reported the first time — that is a blip, not a fault', async () => {
    fails();
    await expect(json('/api/spot')).rejects.toThrow();
    expect(reported).not.toHaveBeenCalled();
  });

  it('is reported once it keeps happening', async () => {
    fails();
    for (let i = 0; i < 3; i += 1) await expect(json('/api/spot')).rejects.toThrow();
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]![0]).toMatchObject({
      code: 'network', where: '/api/spot', level: 'warn',
    });
  });

  it('[critical] a reply of any kind resets the count, so a restart is forgotten', async () => {
    fails();
    await expect(json('/api/spot')).rejects.toThrow();
    await expect(json('/api/spot')).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(ok({ spot: 1 }));
    await json('/api/spot');

    // two more failures is two, not four
    fails();
    await expect(json('/api/spot')).rejects.toThrow();
    await expect(json('/api/spot')).rejects.toThrow();
    expect(reported).not.toHaveBeenCalled();
  });

  it('counts each endpoint separately', async () => {
    fails();
    for (const url of ['/api/spot', '/api/expiries', '/api/spot']) {
      await expect(json(url)).rejects.toThrow();
    }
    // /api/spot failed twice and /api/expiries once: neither has reached three
    expect(reported).not.toHaveBeenCalled();
  });
});

describe('where a failure says it happened', () => {
  it('is the endpoint, not the endpoint plus every parameter', async () => {
    // the chain is polled with eight parameters, which made a row per combination
    fails();
    const url = '/api/chain?at=now&width=20&minPremium=15&expiry=100926';
    for (let i = 0; i < 3; i += 1) await expect(json(url)).rejects.toThrow();

    const report = reported.mock.calls[0]![0] as { where: string; context: { url: string } };
    expect(report.where).toBe('/api/chain');
    // the parameters are kept, as context on the row rather than as its identity
    expect(report.context.url).toBe(url);
  });

  it('pathOf leaves a bare path alone', () => {
    expect(pathOf('/api/spot')).toBe('/api/spot');
    expect(pathOf('/api/chain?a=1&b=2')).toBe('/api/chain');
  });

  it('so three parameter sets fold into one row rather than three', async () => {
    fails();
    for (const q of ['width=10', 'width=20', 'width=30']) {
      await expect(json(`/api/chain?${q}`)).rejects.toThrow();
    }
    // three failures of one endpoint, so one report — not one each
    expect(reported).toHaveBeenCalledTimes(1);
  });
});

describe('what is a failure at all', () => {
  it('not being signed in is a state, and never reaches the log', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as never);
    await expect(json('/api/trade/status')).rejects.toBeInstanceOf(NotSignedIn);
    expect(reported).not.toHaveBeenCalled();
  });

  it('a 4xx the server explains is left to the screen to show', async () => {
    // the desk refuses orders for a living; those are answers, not faults
    fetchMock.mockResolvedValue(
      { ok: false, status: 422, json: async () => ({ error: 'spread too wide' }) } as never,
    );
    await expect(json('/api/trade/place')).rejects.toThrow('spread too wide');
    expect(reported).not.toHaveBeenCalled();
  });

  it('a 5xx is a fault and is recorded', async () => {
    fetchMock.mockResolvedValue(
      { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as never,
    );
    await expect(json('/api/spot')).rejects.toThrow('boom');
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it('a reply cut off half way is named for what it is, and counted like a dropped connection', async () => {
    fetchMock.mockResolvedValue(
      { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } } as never,
    );
    // once is a phone losing signal mid-reply, not a server fault
    await expect(json('/api/spot')).rejects.toThrow(/cut short/);
    expect(reported).not.toHaveBeenCalled();
    // three in a row is an outage, and is written down
    await expect(json('/api/spot')).rejects.toThrow(/cut short/);
    await expect(json('/api/spot')).rejects.toThrow(/cut short/);
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it('a failure while the page is hidden says nothing about the server, and is not counted', async () => {
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      for (let i = 0; i < 5; i++) await expect(json('/api/chain')).rejects.toThrow();
      expect(reported).not.toHaveBeenCalled();
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (hidden) Object.defineProperty(Document.prototype, 'visibilityState', hidden);
    }
  });
});
