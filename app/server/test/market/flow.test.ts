import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowSocket, printOf, perpTickerOf, type Print } from '../../src/market/flow-socket.js';
import {
  bookOf, captureIvTerm, capturePerpSnapshot, flowSchema, flowSummary, flushTradeFlow, minuteOf, minutesOf,
  skewRank, termHistory, useFlowSocket, FLOW_BUCKET_MS, LARGE_PRINT_CONTRACTS,
} from '../../src/market/flow.js';
import { closePool, one, query } from '../../src/db/pool.js';
import { marketSchema } from '../../src/market/oi-history.js';
import type { Ticker } from '../../src/market/delta.js';

const T0 = Date.UTC(2026, 8, 19, 6, 2, 30);
const minute = (n: number) => Math.floor(T0 / FLOW_BUCKET_MS) * FLOW_BUCKET_MS + n * FLOW_BUCKET_MS;
const p = (at: number, side: 'buy' | 'sell', size: number, price = 81_000): Print => ({ at, side, size, price });

beforeEach(async () => {
  await flowSchema();
  await query('TRUNCATE trade_flow_1m, perp_snapshots, iv_term_snapshots');
  useFlowSocket(null);
});
after(() => closePool());

// ---------------------------------------------------------------- parsing

test('[critical] a print is the aggressor side, in contracts, stamped in milliseconds', () => {
  const buy = printOf({ symbol: 'BTCUSD', price: '81255.0', size: 10, timestamp: 1789811133989288, buyer_role: 'taker', seller_role: 'maker' });
  assert.deepEqual(buy, { at: 1789811133989, price: 81255, size: 10, side: 'buy' });
  const sell = printOf({ symbol: 'BTCUSD', price: '81255.0', size: 6, timestamp: 1789811133740478, buyer_role: 'maker', seller_role: 'taker' });
  assert.equal(sell?.side, 'sell');
  assert.equal(printOf({ symbol: 'ETHUSD', price: '1', size: 1, timestamp: 1, buyer_role: 'taker' }), null, 'another product is not ours');
  assert.equal(printOf({ symbol: 'BTCUSD', price: '1', size: 0, timestamp: 1, buyer_role: 'taker' }), null, 'a zero print is nothing');
});

test('the perp ticker carries funding, open interest and turnover as numbers', () => {
  const t = perpTickerOf({ symbol: 'BTCUSD', mark_price: '81248.2', spot_price: '81263.4', funding_rate: '0.01', oi_contracts: '1001617', oi_value_usd: '81459364', turnover_usd: 1189384246, volume: 14810, mark_change_24h: '4.13', high: 81730.5, low: 77931 }, 5);
  assert.equal(t?.fundingRate, 0.01);
  assert.equal(t?.oiContracts, 1_001_617);
  assert.equal(t?.turnoverUsd24h, 1_189_384_246);
  assert.equal(t?.change24hPct, 4.13);
});

test('the socket takes the snapshot and the stream, and does not count a print twice', () => {
  const s = new FlowSocket({ now: () => T0 });
  s.receive(JSON.stringify({ type: 'all_trades_snapshot', symbol: 'BTCUSD', trades: [
    { price: '81000', size: 5, timestamp: (T0 - 2_000) * 1000, buyer_role: 'taker', seller_role: 'maker' },
    { price: '81001', size: 7, timestamp: (T0 - 1_000) * 1000, buyer_role: 'maker', seller_role: 'taker' },
  ] }));
  s.receive(JSON.stringify({ type: 'all_trades', symbol: 'BTCUSD', price: '81001', size: 7, timestamp: (T0 - 1_000) * 1000, buyer_role: 'maker', seller_role: 'taker' }));
  s.receive(JSON.stringify({ type: 'all_trades', symbol: 'BTCUSD', price: '81002', size: 1, timestamp: T0 * 1000, buyer_role: 'taker', seller_role: 'maker' }));
  s.receive(JSON.stringify({ type: 'v2/ticker', symbol: 'BTCUSD', mark_price: '81002', funding_rate: '0.005' }));
  const prints = s.printsSince(0);
  assert.deepEqual(prints.map((x) => [x.side, x.size]), [['buy', 5], ['sell', 7], ['buy', 1]]);
  assert.equal(s.perpTicker()?.fundingRate, 0.005);
  assert.equal(s.health().prints, 3);
});

// ------------------------------------------------------------- the minutes

test('[critical] a minute sums each side, counts prints, and flags the large ones', () => {
  const m = minuteOf(minute(0), [
    p(minute(0) + 1_000, 'buy', 10, 81_000), p(minute(0) + 2_000, 'sell', 4, 81_010),
    p(minute(0) + 3_000, 'buy', LARGE_PRINT_CONTRACTS, 81_020),
  ]);
  assert.equal(m.buyVolume, 10 + LARGE_PRINT_CONTRACTS);
  assert.equal(m.sellVolume, 4);
  assert.equal(m.buyCount, 2);
  assert.equal(m.sellCount, 1);
  assert.equal(m.largeBuyVolume, LARGE_PRINT_CONTRACTS);
  assert.equal(m.largeSellVolume, 0);
  assert.equal(m.high, 81_020);
  assert.equal(m.low, 81_000);
  const vwap = (10 * 81_000 + 4 * 81_010 + LARGE_PRINT_CONTRACTS * 81_020) / (14 + LARGE_PRINT_CONTRACTS);
  assert.ok(Math.abs(m.vwap! - vwap) < 1e-6);
});

test('prints fall into the minutes they printed in, oldest first', () => {
  const ms = minutesOf([p(minute(2) + 5, 'buy', 1), p(minute(0) + 5, 'sell', 2), p(minute(0) + 30_000, 'buy', 3)]);
  assert.deepEqual(ms.map((m) => [m.at, m.buyVolume, m.sellVolume]), [[minute(0), 3, 2], [minute(2), 1, 0]]);
});

test('[critical] completed minutes are written once; the one in progress waits; the summary reads both', async () => {
  const s = new FlowSocket({ now: () => minute(3) + 10_000 });
  for (const x of [
    p(minute(0) + 1_000, 'buy', 10), p(minute(1) + 1_000, 'sell', 6), p(minute(1) + 2_000, 'buy', 2),
    p(minute(2) + 1_000, 'sell', 1), p(minute(3) + 1_000, 'buy', 100),
  ]) s.receive(JSON.stringify({ type: 'all_trades', symbol: 'BTCUSD', price: String(x.price), size: x.size, timestamp: x.at * 1000, buyer_role: x.side === 'buy' ? 'taker' : 'maker', seller_role: x.side === 'buy' ? 'maker' : 'taker' }));
  useFlowSocket(s);

  assert.equal(await flushTradeFlow(minute(3) + 10_000), 3);
  assert.equal(await flushTradeFlow(minute(3) + 20_000), 0, 'nothing new to write');
  const stored = await one<{ n: number }>('SELECT COUNT(*)::int AS n FROM trade_flow_1m');
  assert.equal(stored?.n, 3);

  const sum = await flowSummary(60, minute(3) + 10_000);
  assert.equal(sum.minutesCovered, 4, 'three written minutes and the one in progress');
  assert.equal(sum.buyVolume, 112);
  assert.equal(sum.sellVolume, 7);
  assert.equal(sum.deltaVolume, 105);
  assert.equal(sum.trades, 5);
  assert.equal(sum.aggressorBuyPct, 112 / 119);
  assert.deepEqual(sum.cvd.map((c) => c.cvd), [10, 6, 5, 105]);
  assert.equal(sum.source, 'socket');
});

test('an empty window says so rather than showing zeros as flow', async () => {
  const sum = await flowSummary(60, T0);
  assert.equal(sum.minutesCovered, 0);
  assert.equal(sum.source, 'none');
  assert.equal(sum.aggressorBuyPct, null);
  assert.equal(sum.avgTradeSize, null);
});

// ------------------------------------------------------------------ the book

test('[critical] the book snapshot: depth a side, imbalance, spread', () => {
  const b = bookOf({
    buy: [{ size: 100, price: '81247.5' }, { size: 300, price: '81247.0' }, { size: 50, price: '81246.5' }],
    sell: [{ size: 200, price: '81248.0' }, { size: 100, price: '81248.5' }],
  }, T0);
  assert.equal(b.bidDepth, 450);
  assert.equal(b.askDepth, 300);
  assert.ok(Math.abs(b.imbalance! - 150 / 750) < 1e-9);
  assert.equal(b.spreadUsd, 0.5);
  assert.equal(b.top5Bid, 450);
  assert.equal(b.bestBid, 81_247.5);
});

// -------------------------------------------------------- term and perp rows

const tk = (symbol: string, cp: 'C' | 'P', strike: number, iv: string): Ticker => ({
  symbol, contract_type: cp === 'C' ? 'call_options' : 'put_options', underlying_asset_symbol: 'BTC',
  strike_price: String(strike), close: 1, mark_price: '100', spot_price: '77850', oi: '1', volume: 1, greeks: null,
  quotes: { best_bid: '1', best_ask: '2', bid_size: '1', ask_size: '1', mark_iv: iv, bid_iv: iv, ask_iv: iv },
});

test('[critical] the term structure is recorded per bucket and read back as it was a week ago', async () => {
  const board = [tk('C-BTC-78000-190926', 'C', 78_000, '0.40'), tk('C-BTC-78000-260926', 'C', 78_000, '0.45')];
  const weekAgo = T0 - 7 * 86_400_000;
  assert.ok(await captureIvTerm(board, weekAgo));
  assert.equal(await captureIvTerm(board, weekAgo + 1_000), null, 'the same bucket is not written twice');
  const h = await termHistory(7 * 86_400_000, T0);
  assert.deepEqual(h?.points.map((x) => [x.expiry, x.atmIv]), [['190926', 0.4], ['260926', 0.45]]);
  assert.equal(await termHistory(30 * 86_400_000, T0), null, 'no record a month back');
});

test('a perp snapshot is one row per five-minute bucket', async () => {
  const s = new FlowSocket({ now: () => T0 });
  s.receive(JSON.stringify({ type: 'v2/ticker', symbol: 'BTCUSD', mark_price: '81002', funding_rate: '0.005', oi_contracts: '1000' }));
  // Make the socket look fresh and skip the REST book: the row still writes with what it has.
  (s as unknown as { socket: object }).socket = {};
  useFlowSocket(s);
  const r = await capturePerpSnapshot(T0);
  assert.ok(r);
  const row = await one<{ funding_rate: number; oi_contracts: number }>('SELECT funding_rate, oi_contracts FROM perp_snapshots WHERE at = $1', [r!.at]);
  assert.equal(row?.funding_rate, 0.005);
  assert.equal(row?.oi_contracts, 1000);
  assert.equal(await capturePerpSnapshot(T0 + 1_000), null);
});

test('the skew rank needs a record to rank against', async () => {
  assert.equal(await skewRank(null), null);
  await marketSchema();
  await query('TRUNCATE chain_features');
  assert.equal(await skewRank(2), null, 'a dozen readings at least');
});

test('the IV rank and the OI pulse read the board record', async () => {
  const { ivRank, oiPulse } = await import('../../src/market/flow.js');
  await marketSchema();
  await query('TRUNCATE chain_features');
  assert.equal(await ivRank(0.4), null, 'a dozen readings at least');
  const cols = '(at, expiry, spot, hours_left, atm_iv, call_atm, put_atm, put_marks, call_marks, put_volume, call_volume, pcr_oi, pcr_volume, ce_oi, pe_oi, iv_skew_pts, ce_wall, pe_wall, max_pain, ce_oi_change, pe_oi_change)';
  for (let i = 0; i < 14; i++) {
    await query(`INSERT INTO chain_features ${cols} VALUES ($1, '190926', 80000, 5, $2, 1, 1, '{}', '{}', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, $3, $4)`,
      [T0 - (13 - i) * 5 * 60_000, 0.30 + i * 0.01, 100 + i * 10, -50]);
  }
  const r = await ivRank(0.365);
  assert.equal(r?.samples, 14);
  assert.ok(Math.abs(r!.percentile - 7 / 14) < 1e-9, 'seven readings below 0.365');
  const o = await oiPulse('190926', T0);
  assert.equal(o.ceChange1h, 230);
  assert.equal(o.ceAcceleration, 230 - 110, 'against the reading an hour earlier');
  assert.equal(o.peAcceleration, 0);
});
