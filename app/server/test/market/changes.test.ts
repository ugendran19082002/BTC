import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { changes, CHANGE_WINDOWS_MIN } from '../../src/market/changes.js';
import { optionSnapshotsSchema } from '../../src/market/option-snapshots.js';
import { marketSchema } from '../../src/market/oi-history.js';
import { closePool, query } from '../../src/db/pool.js';

const T0 = Date.UTC(2026, 8, 19, 6, 0, 0);
const SYM = 'C-BTC-82000-190926';

beforeEach(async () => {
  await optionSnapshotsSchema(); await marketSchema();
  await query('TRUNCATE option_snapshots, chain_features');
});
after(() => closePool());

test('[critical] each window diffs now against the record nearest that long ago; one minute has no record to diff', async () => {
  // The strike, every five minutes for an hour: mark climbing 10 a bucket, OI 100 a bucket.
  for (let i = 0; i <= 12; i++) {
    const at = T0 - (12 - i) * 5 * 60_000;
    await query(
      `INSERT INTO option_snapshots (at, symbol, expiry, cp, strike, spot, mark, mark_iv, oi, volume) VALUES ($1, $2, '190926', 'C', 82000, $3, $4, $5, $6, $7)`,
      [at, SYM, 80_000 + i * 50, 100 + i * 10, 0.30 + i * 0.01, 1000 + i * 100, 50 * i],
    );
    await query(
      `INSERT INTO chain_features (at, expiry, spot, hours_left, atm_iv, call_atm, put_atm, put_marks, call_marks, put_volume, call_volume, pcr_oi, pcr_volume, ce_oi, pe_oi, iv_skew_pts, ce_wall, pe_wall, max_pain, ce_oi_change, pe_oi_change)
       VALUES ($1, '190926', 80000, 5, $2, 1, 1, '{}', '{}', $3, $4, $5, 1, $6, $7, 1, 1, 1, 1, 0, 0)`,
      [at, 0.30 + i * 0.01, 10 * i, 20 * i, 1 + i * 0.01, 5000 + i * 100, 6000 + i * 50],
    );
  }
  const r = await changes(SYM, '190926', T0, { spot: 80_600 });
  assert.deepEqual(r.rows.map((x) => x.minutes), [...CHANGE_WINDOWS_MIN]);
  const w5 = r.rows.find((x) => x.minutes === 5)!;
  assert.equal(w5.markChange, 10);
  assert.equal(w5.oiChange, 100);
  assert.ok(Math.abs(w5.ivChangePts! - 1) < 1e-9);
  assert.equal(w5.ceOiChange, 100);
  assert.equal(w5.peOiChange, 50);
  const w60 = r.rows.find((x) => x.minutes === 60)!;
  assert.equal(w60.markChange, 120);
  assert.equal(w60.callVolumeChange, 240);
  const w1 = r.rows.find((x) => x.minutes === 1)!;
  assert.equal(w1.markChange, null, 'five-minute records cannot answer a one-minute window');
  const w720 = r.rows.find((x) => x.minutes === 720)!;
  assert.equal(w720.markChange, null, 'nothing recorded that far back');
  assert.equal(r.now.mark, 220);
  assert.equal(r.now.spot, 80_600, 'the live figure the caller passed');
  assert.deepEqual(r.momentum, { velocity: 10, acceleration: 0 }, 'a premium climbing 10 a bucket, steadily');
  // The model's read then: from that bucket's spot and IV, with the time that was left. A 5m-old row has all three.
  assert.ok(w5.pOtmThen !== null && w5.pOtmThen > 0.5 && w5.pOtmThen < 1, 'an 82,000 call with spot near 80,600 is out of the money');
  assert.ok(w5.pTouchThen !== null && w5.pTouchThen > 0 && w5.emDistanceThen !== null && w5.emDistanceThen > 0);
  assert.equal(w1.pOtmThen, null, 'no record a minute ago');
  assert.ok(r.model.pOtm !== null, 'the same model now');
  assert.ok(w5.pOtmNow !== null && w5.pOtmNow !== w5.pOtmThen, 'now, on the row\'s own basis');
});

test('a since-entry row runs from the entry moment, once at least a window is behind it', async () => {
  const at = T0 - 30 * 60_000;
  await query(`INSERT INTO option_snapshots (at, symbol, expiry, cp, strike, spot, mark, mark_iv, oi, volume) VALUES ($1, $2, '190926', 'C', 82000, 80000, 100, 0.3, 1000, 0)`, [at, SYM]);
  const r = await changes(SYM, '190926', T0, { spot: 80_600, mark: 120 }, T0 - 30 * 60_000);
  const e = r.rows.find((x) => x.sinceEntry)!;
  assert.equal(e.minutes, 30);
  assert.equal(e.markChange, 20, 'against the record at the entry moment');
  assert.equal((await changes(SYM, '190926', T0, {}, T0 - 60_000)).rows.some((x) => x.sinceEntry), false, 'a minute since entry is not a window yet');
});
