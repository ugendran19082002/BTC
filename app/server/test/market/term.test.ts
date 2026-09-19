import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termStructure } from '../../src/market/term.js';
import type { Ticker } from '../../src/market/delta.js';

const NOW = Date.UTC(2026, 8, 19, 6, 0) / 1000;
const t = (symbol: string, cp: 'C' | 'P', strike: number, iv: string | null, spot = '77900'): Ticker => ({
  symbol, contract_type: cp === 'C' ? 'call_options' : 'put_options', underlying_asset_symbol: 'BTC',
  strike_price: String(strike), close: null, mark_price: '1', spot_price: spot, oi: '0', volume: 0, greeks: null,
  quotes: { best_bid: null, best_ask: null, bid_size: null, ask_size: null, mark_iv: iv, bid_iv: null, ask_iv: null },
});

test('[critical] ATM IV per expiry: the strike nearest spot, call and put averaged, soonest first', () => {
  const pts = termStructure([
    t('C-BTC-78000-200926', 'C', 78_000, '0.50'), t('P-BTC-78000-200926', 'P', 78_000, '0.54'),
    t('C-BTC-80000-200926', 'C', 80_000, '0.40'),
    t('C-BTC-78000-190926', 'C', 78_000, '0.48', '77850'), t('P-BTC-77800-190926', 'P', 77_800, '0.46', '77850'),
  ], NOW);
  assert.deepEqual(pts.map((p) => p.expiry), ['190926', '200926']);
  assert.equal(pts[0]!.strike, 77_800, 'nearest to 77,850 on the 19th');
  assert.equal(pts[0]!.sides, 1);
  assert.equal(pts[1]!.strike, 78_000);
  assert.ok(Math.abs(pts[1]!.atmIv - 0.52) < 1e-12, 'mean of 0.50 and 0.54');
  assert.equal(pts[1]!.sides, 2);
});

test('expired contracts, missing IVs and junk symbols are left out, never zeroed', () => {
  const pts = termStructure([
    t('C-BTC-78000-180926', 'C', 78_000, '0.5'),   // settled yesterday
    t('C-BTC-78000-190926', 'C', 78_000, null),
    t('C-BTC-78000-190926', 'C', 78_000, '0'),
    t('BTCUSD', 'C', 78_000, '0.5'),
  ], NOW);
  assert.deepEqual(pts, []);
});
