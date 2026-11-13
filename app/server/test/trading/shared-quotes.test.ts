import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaExchange, QUOTE_SHARE_MS, clearSharedQuotes } from '../../src/trading/exchange/delta.js';
import { clearRateLimitWaits } from '../../src/delta/signed.js';

/*
 * One contract's ticker read once for every desk in the process (13 Nov 2026): the four accounts read the same contracts'
 * tickers each on their own login, and price reads were two thirds of the day's rate-limit refusals (172 of 235).
 */

const real = globalThis.fetch;
const realNow = Date.now;
afterEach(() => { globalThis.fetch = real; Date.now = realNow; clearRateLimitWaits(); clearSharedQuotes(); });

const SYM = 'C-BTC-72200-131126';
function delta(answer: (key: string) => Response) {
  const sent: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string>)['api-key'];
    sent.push(`${key} ${new URL(String(url)).pathname}`);
    return answer(key);
  }) as typeof fetch;
  return sent;
}
const ticker = (bid: number, ask: number) => new Response(JSON.stringify({ success: true, result: { symbol: SYM, quotes: { best_bid: String(bid), best_ask: String(ask) }, mark_price: String((bid + ask) / 2), timestamp: Date.now() * 1000 } }), { status: 200 });

test('[critical] four desks asking the same contract inside the window: one read, the same quote for all', async () => {
  const sent = delta(() => ticker(5.1, 7));
  const desks = ['a', 'b', 'c', 'd'].map((k) => new DeltaExchange({ key: `login-${k}`, secret: 's' }));
  const got = await Promise.all(desks.map((d) => d.getQuote(SYM)));
  assert.deepEqual(got.map((q) => [q?.bid, q?.ask]), [[5.1, 7], [5.1, 7], [5.1, 7], [5.1, 7]]);
  assert.equal(sent.length, 1, 'one request to Delta, on the first login');
  // Inside the window: nothing more, whichever desk asks.
  await desks[3]!.getQuote(SYM);
  assert.equal(sent.length, 1);
});

test('[critical] past the window it is read again -- by whichever desk asks -- and a fresh print is seen', async () => {
  let now = 1_794_540_000_000;
  Date.now = () => now;
  let bid = 5;
  const sent = delta(() => ticker(bid, bid + 1));
  const a = new DeltaExchange({ key: 'login-a', secret: 's' });
  const b = new DeltaExchange({ key: 'login-b', secret: 's' });
  assert.equal((await a.getQuote(SYM))?.bid, 5);
  now += QUOTE_SHARE_MS;
  bid = 6;
  assert.equal((await b.getQuote(SYM))?.bid, 6, 'read again, on b\'s login');
  assert.deepEqual(sent, ['login-a /v2/tickers/C-BTC-72200-131126', 'login-b /v2/tickers/C-BTC-72200-131126']);
});

test('[critical] a refusal is shared only with its own login: another desk reads for itself, and its answer serves everyone', async () => {
  const sent = delta((key) => (key === 'login-a' ? new Response('{}', { status: 502 }) : ticker(5.1, 7)));
  const a = new DeltaExchange({ key: 'login-a', secret: 's' });
  const b = new DeltaExchange({ key: 'login-b', secret: 's' });
  assert.equal(await a.getQuote(SYM), null, 'a is refused');
  const afterA = sent.length;                                   // one ask, and the client's own retry of a 502
  assert.equal(await a.getQuote(SYM), null, 'and would only be refused again inside the window: not asked');
  assert.equal(sent.length, afterA);
  assert.equal((await b.getQuote(SYM))?.ask, 7, 'b reads for itself');
  assert.equal(sent.length, afterA + 1);
  assert.equal((await a.getQuote(SYM))?.ask, 7, 'and a now has b\'s quote');
  assert.equal(sent.length, afterA + 1);
});
