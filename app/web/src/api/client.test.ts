import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetNetworkFailures, json, NotSignedIn, pathOf } from '@/api/client';

/**
 * What reaches the error log, and what does not.
 *
 * The log is only useful if everything in it needs fixing. The live log had
 * four `Failed to fetch` rows in it, all of them the poll running while the
 * container restarted under a deploy -- the desk working correctly, recorded as
 * a fault, next to the one row that mattered. On 10 September another came from
 * a laptop whose connection dropped for fourteen seconds.
 */

vi.mock('@/lib/report-error', () => ({ reportError: vi.fn() }));
const { reportError } = await import('@/lib/report-error');
const reported = reportError as unknown as ReturnType<typeof vi.fn>;

const fetchMock = vi.fn();

beforeEach(() => {
  // Only the clock is faked, so the fetch promises still settle on their own.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-10T16:22:21Z'));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  reported.mockReset();
  forgetNetworkFailures();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Move the clock on. */
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fails = () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

/** Fail `times` in a row, spread evenly across `spanMs`. */
async function failInARow(url: string, times: number, spanMs: number) {
  for (let i = 0; i < times; i += 1) {
    if (i > 0) later(spanMs / (times - 1));
    await expect(json(url)).rejects.toThrow();
  }
}

describe('a network failure', () => {
  it('is not reported the first time — that is a blip, not a fault', async () => {
    fails();
    await expect(json('/api/spot')).rejects.toThrow();
    expect(reported).not.toHaveBeenCalled();
  });

  it('[critical] three quick failures from a connection that dropped for 14 seconds are not reported', async () => {
    // exactly the 10 September row: the chain poll, five seconds apart, a
    // laptop's Wi-Fi reconnecting
    fails();
    await failInARow('/api/chain', 3, 14_000);
    expect(reported).not.toHaveBeenCalled();
  });

  it('is reported once it has kept failing for a minute, with how long', async () => {
    fails();
    await failInARow('/api/spot', 3, 61_000);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]![0]).toMatchObject({
      code: 'network', where: '/api/spot', level: 'warn',
      context: { consecutiveFailures: 3, failingForSeconds: 61 },
    });
  });

  it('a minute of failing is not enough on its own -- it has to be three in a row as well', async () => {
    fails();
    await expect(json('/api/spot')).rejects.toThrow();
    later(90_000);
    await expect(json('/api/spot')).rejects.toThrow();
    expect(reported).not.toHaveBeenCalled();
  });

  it('[critical] a reply of any kind resets the run, so a restart is forgotten', async () => {
    fails();
    await expect(json('/api/spot')).rejects.toThrow();
    later(40_000);
    await expect(json('/api/spot')).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(ok({ spot: 1 }));
    await json('/api/spot');

    // the minute starts again from the next failure, not from the first one
    fails();
    later(1_000);
    await failInARow('/api/spot', 3, 30_000);
    expect(reported).not.toHaveBeenCalled();
  });

  it('counts each endpoint separately', async () => {
    fails();
    await expect(json('/api/spot')).rejects.toThrow();
    later(40_000);
    await expect(json('/api/expiries')).rejects.toThrow();
    later(40_000);
    await expect(json('/api/spot')).rejects.toThrow();
    // /api/spot failed twice and /api/expiries once: neither has reached three
    expect(reported).not.toHaveBeenCalled();
  });
});

describe('where a failure says it happened', () => {
  it('is the endpoint, not the endpoint plus every parameter', async () => {
    // the chain is polled with eight parameters, which made a row per combination
    fails();
    const url = '/api/chain?at=now&width=20&minPremium=15&expiry=100926';
    await failInARow(url, 3, 61_000);

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
    for (const [i, q] of ['width=10', 'width=20', 'width=30'].entries()) {
      if (i > 0) later(31_000);
      await expect(json(`/api/chain?${q}`)).rejects.toThrow();
    }
    // three failures of one endpoint over a minute, so one report — not one each
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

  it('a 5xx is a fault and is recorded at once -- the server answered, so the connection is not the problem', async () => {
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
    // still cut short a minute later, three in a row: an outage, and written down
    later(30_000);
    await expect(json('/api/spot')).rejects.toThrow(/cut short/);
    later(31_000);
    await expect(json('/api/spot')).rejects.toThrow(/cut short/);
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it('a failure while the page is hidden says nothing about the server, and is not counted', async () => {
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      await failInARow('/api/chain', 5, 120_000);
      expect(reported).not.toHaveBeenCalled();
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
      if (hidden) Object.defineProperty(Document.prototype, 'visibilityState', hidden);
    }
  });
});
