import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TickerSocket, looksLikeBtcOption, tickerOf, type SocketLike } from '../../src/market/delta-socket.js';
import type { Ticker } from '../../src/market/delta.js';

/**
 * The socket feed.
 *
 * Read-only by construction -- a public channel, no key -- so the tests are
 * about the two ways a feed can quietly go wrong: delivering a board that
 * looks fresh and is not, and delivering messages the rest of the server
 * cannot read. Nothing here opens a real socket.
 */

// One real message from the wire, 16 September, trimmed to the fields that matter.
const wire = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'v2/ticker', symbol: 'C-BTC-99000-271126', contract_type: 'call_options',
  underlying_asset_symbol: 'BTC', strike_price: '99000', spot_price: '75853', mark_price: '502.84966832',
  oi: '0.5130', oi_contracts: '513', volume: 0.311, close: 510,
  greeks: { delta: '0.08517353', gamma: '0.00001128', rho: '11.79824424', spot: '75851.4', theta: '-14.89597613', vega: '52.60397971' },
  quotes: { ask_iv: '0.41357427', ask_size: '4384', best_ask: '525', best_bid: '480', bid_iv: '0.40501728', bid_size: '6508', impact_mid_price: null, mark_iv: '0.4093913' },
  timestamp: 1789535968975333, product_id: 151077, turnover: 23763.8,
  ...over,
});

test('[critical] a wire ticker becomes the REST ticker the chain reads, field for field', () => {
  const t = tickerOf(JSON.parse(wire()));
  assert.ok(t);
  assert.equal(t.symbol, 'C-BTC-99000-271126');
  assert.equal(t.contract_type, 'call_options');
  assert.equal(t.strike_price, '99000');
  assert.equal(t.spot_price, '75853');
  assert.equal(t.mark_price, '502.84966832');
  assert.equal(t.oi_contracts, '513');
  assert.equal(t.volume, 0.311);
  assert.equal(t.close, 510);
  assert.equal(t.quotes?.best_bid, '480');
  assert.equal(t.quotes?.mark_iv, '0.4093913');
  assert.equal(t.greeks?.delta, '0.08517353');
});

test('anything that is not a BTC option is dropped, before and after parsing', () => {
  assert.equal(looksLikeBtcOption(JSON.stringify({ type: 'v2/ticker', symbol: 'BTCUSD', underlying_asset_symbol: 'BTC', contract_type: 'perpetual_futures' })), false);
  assert.equal(looksLikeBtcOption(wire({ underlying_asset_symbol: 'ETH' })), false);
  assert.equal(looksLikeBtcOption(wire()), true);
  assert.equal(tickerOf(JSON.parse(wire({ underlying_asset_symbol: 'ETH' }))), null);
  assert.equal(tickerOf(JSON.parse(wire({ contract_type: 'perpetual_futures' }))), null);
  assert.equal(tickerOf({ type: 'subscriptions', channels: [] }), null);
  assert.equal(tickerOf(JSON.parse(wire({ mark_price: undefined }))), null, 'no mark is no ticker');
});

/** A socket the test controls. */
function fakeSocket() {
  const sent: string[] = [];
  const ws: SocketLike & { sent: string[]; closed: boolean } = {
    sent, closed: false,
    send: (d) => { sent.push(d); },
    close: () => { ws.closed = true; },
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };
  return ws;
}

function rig(now = { t: 1_000_000 }) {
  const batches: { data: Ticker[]; at: number; spot: number | null }[] = [];
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const feed = new TickerSocket({
    onBatch: (data, at, spot) => batches.push({ data, at, spot }),
    connect: () => { const s = fakeSocket(); sockets.push(s); return s; },
    now: () => now.t,
    snapshotMs: 60_000,   // the test calls snapshot() itself
  });
  return { feed, batches, sockets, now };
}

test('[critical] on open it subscribes to the ticker channel and asks for heartbeats', () => {
  const { feed, sockets } = rig();
  feed.start();
  sockets[0].onopen?.({});
  assert.deepEqual(sockets[0].sent.map((s) => JSON.parse(s).type), ['enable_heartbeat', 'subscribe']);
  assert.deepEqual(JSON.parse(sockets[0].sent[1]).payload.channels, [{ name: 'v2/ticker', symbols: ['all'] }]);
  feed.stop();
});

test('[critical] a batch is handed on only when something changed, and carries the freshest spot', () => {
  const { feed, batches, sockets, now } = rig();
  feed.start();
  sockets[0].onopen?.({});
  feed.snapshot();
  assert.equal(batches.length, 0, 'nothing heard, nothing handed on');
  sockets[0].onmessage?.({ data: wire() });
  sockets[0].onmessage?.({ data: wire({ symbol: 'P-BTC-70000-271126', contract_type: 'put_options', strike_price: '70000', spot_price: '75860' }) });
  now.t += 1_000;
  feed.snapshot();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].data.length, 2);
  assert.equal(batches[0].spot, 75_860);
  feed.snapshot();
  assert.equal(batches.length, 1, 'the same board is not handed on again');
  // an update to one contract replaces it, not adds it
  sockets[0].onmessage?.({ data: wire({ mark_price: '510' }) });
  feed.snapshot();
  assert.equal(batches[1].data.length, 2);
  assert.equal(batches[1].data.find((t) => t.symbol === 'C-BTC-99000-271126')?.mark_price, '510');
  feed.stop();
});

test('[critical] a silent socket is dropped and remade, and stops counting as fresh', () => {
  const { feed, sockets, now } = rig();
  feed.start();
  sockets[0].onopen?.({});
  sockets[0].onmessage?.({ data: wire() });
  assert.equal(feed.fresh(), true);
  assert.equal(feed.health().source, 'socket');
  now.t += 25_000;
  assert.equal(feed.fresh(), false, 'twenty-five seconds of silence is not a feed');
  assert.equal(feed.health().source, 'rest', 'the REST poll is the feed now');
  feed.snapshot();
  assert.equal(sockets[0].closed, true, 'dropped');
  feed.stop();
});

test('a REST batch replaces what the socket held, so a settled contract cannot linger', () => {
  const { feed, batches, sockets, now } = rig();
  feed.start();
  sockets[0].onopen?.({});
  sockets[0].onmessage?.({ data: wire({ symbol: 'C-BTC-99000-150926' }) });
  feed.seed([tickerOf(JSON.parse(wire({ symbol: 'C-BTC-99000-160926' })))!]);
  sockets[0].onmessage?.({ data: wire({ symbol: 'P-BTC-70000-160926', contract_type: 'put_options' }) });
  now.t += 1_000;
  feed.snapshot();
  assert.deepEqual(batches[0].data.map((t) => t.symbol).sort(), ['C-BTC-99000-160926', 'P-BTC-70000-160926']);
  feed.stop();
});

test('a closed socket is reopened; stop() means stopped', () => {
  const { feed, sockets } = rig();
  feed.start();
  sockets[0].onopen?.({});
  sockets[0].onclose?.({ code: 1006 });
  assert.equal(feed.health().connected, false);
  assert.equal(feed.health().reconnects, 1);
  feed.stop();
  assert.equal(feed.health().connected, false);
});

test('[critical] a remade socket gets its handshake time: a stale old message cannot kill it on the next tick', () => {
  // 21 September: the socket went silent, and every reopen was dropped by the
  // very next snapshot -- still in its handshake, judged by the dead socket's
  // last message. 3,833 reconnects in 32 hours, none of them heard.
  const { feed, sockets, now } = rig();
  feed.start();
  sockets[0].onopen?.({});
  sockets[0].onmessage?.({ data: wire() });
  now.t += 25_000;
  feed.snapshot();
  assert.equal(sockets[0].closed, true, 'the silent one is dropped');
  now.t += 1_000;
  (feed as unknown as { open(): void }).open();   // what the reconnect timer does
  assert.equal(sockets.length, 2);
  now.t += 5;
  feed.snapshot();
  assert.equal(sockets[1].closed, false, 'a socket still connecting is not silent');
  assert.equal(feed.health().connected, true);
  sockets[1].onopen?.({});
  sockets[1].onmessage?.({ data: wire() });
  assert.equal(feed.health().source, 'socket', 'and it becomes the feed again');
  feed.stop();
});

test('a socket that never finishes connecting is still given up on', () => {
  const { feed, sockets, now } = rig();
  feed.start();
  now.t += 25_000;
  feed.snapshot();
  assert.equal(sockets[0].closed, true, 'twenty seconds with no open and no message is dead');
  feed.stop();
});
