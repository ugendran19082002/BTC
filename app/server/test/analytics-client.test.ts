import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ERROR_DB = join(mkdtempSync(join(tmpdir(), 'analytics-client-')), 'errors.db');
const { measuredOutlook, resetAnalyticsClient, ANALYTICS_COOL_OFF_MS } = await import('../src/analytics/client.js');
const { errorLog } = await import('../src/observability/errors.js');
const { withMeasured } = await import('../src/domain/outlook.js');

/**
 * The analytics service, from Node's side.
 *
 * It is display only, so the properties that matter are all about absence:
 * a slow, broken or missing service costs the screen its extra detail and
 * nothing else -- no exception, no long wait, and one line in the error log per
 * outage rather than one per poll.
 */

const row = (over: Record<string, unknown> = {}) => ({
  label: '1h', minutes: 60, measured_minutes: 60, spot: 75_000, projected: 75_015, low: 74_800, high: 75_220,
  p_down: 0.337, p_side: 0.271, p_up: 0.392, side_band_pct: 0.119, side_band_usd: 89.25,
  arrow: 'up', calm: 'livelier', windows: 91_985,
  basis: { feature: 'momentum', bucket: 'down', words: 'BTC fell over the last hour', windows: 91_985, independent: 7_665, lean_holds: true, side_holds: true },
  ...over,
});

const input = { now: 1_789_600_000_000, spot: 75_000, series: { '1h': { t: [1, 2], c: [1, 2] } }, extra: [] };
let clock = 1_000_000;
const deps = (fetchImpl: typeof fetch, url: string | undefined = 'http://analytics:8800') =>
  ({ fetch: fetchImpl, now: () => clock, url });
const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

beforeEach(() => { resetAnalyticsClient(); clock = 1_000_000; });

test('[critical] a good answer comes back mapped, with only the fields the screen reads', async () => {
  let sent: { url: string; body: Record<string, unknown> } | null = null;
  const f = (async (url: string, init?: RequestInit) => {
    sent = { url, body: JSON.parse(String(init!.body)) };
    return new Response(JSON.stringify({ model: 'measured-states-v1', measured_at: '2026-09-17T00:31:22', rows: [row()] }), { status: 200 });
  }) as unknown as typeof fetch;
  const m = await measuredOutlook(input, deps(f));
  assert.equal(sent!.url, 'http://analytics:8800/v1/outlook');
  assert.equal(sent!.body.now, 1_789_600_000, 'seconds, not milliseconds');
  assert.equal(m!.model, 'measured-states-v1');
  assert.deepEqual({ pUp: m!.rows[0]!.pUp, arrow: m!.rows[0]!.arrow, words: m!.rows[0]!.basis!.words, lean: m!.rows[0]!.basis!.leanHolds },
    { pUp: 0.392, arrow: 'up', words: 'BTC fell over the last hour', lean: true });
});

test('[critical] no URL configured means the client is off, and nothing is fetched', async () => {
  let called = false;
  const f = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  // spelled out: passing undefined to a defaulted parameter would pick up the default URL
  assert.equal(await measuredOutlook(input, { ...deps(f), url: undefined }), null);
  assert.equal(called, false);
});

test('no series yet is nothing to ask about', async () => {
  assert.equal(await measuredOutlook({ ...input, series: null }, deps(answer(200, { rows: [] }))), null);
});

test('[critical] a service that has not measured anything yet (503) is not an outage', async () => {
  assert.equal(await measuredOutlook(input, deps(answer(503, { detail: 'not measured' }))), null);
  // and it is asked again straight away, not after a cool-off
  const m = await measuredOutlook(input, deps(answer(200, { model: 'm', rows: [row()] })));
  assert.equal(m!.rows.length, 1);
});

test('[critical] a failure backs off for the cool-off, then tries again, and is logged once', async () => {
  const before = errorLog().summary().total;
  let calls = 0;
  const broken = (async () => { calls += 1; throw new Error('connect ECONNREFUSED'); }) as typeof fetch;
  assert.equal(await measuredOutlook(input, deps(broken)), null);
  assert.equal(await measuredOutlook(input, deps(broken)), null);
  assert.equal(calls, 1, 'inside the cool-off nothing is sent');
  clock += ANALYTICS_COOL_OFF_MS + 1;
  assert.equal(await measuredOutlook(input, deps(broken)), null);
  assert.equal(calls, 2, 'after it, one more try');
  assert.equal(errorLog().summary().total - before, 1, 'one line for the outage, not one per request');
});

test('a malformed answer is dropped rather than half-shown', async () => {
  assert.equal(await measuredOutlook(input, deps(answer(200, { rows: 'nope' }))), null);
  resetAnalyticsClient();
  const m = await measuredOutlook(input, deps(answer(200, { model: 'm', rows: [row({ p_up: 'high' }), row({ label: '4h' })] })));
  assert.deepEqual(m!.rows.map((r) => r.label), ['4h'], 'the bad row goes, the good one stays');
});

test('[critical] a timeout is a failure, not a hang', async () => {
  const slow = ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await measuredOutlook(input, deps(slow)), null);
  assert.ok(Date.now() - started < 3_000, 'the client gave up on its own');
});

test('[critical] merging keeps every figure Node worked out, and adds the measured row by label', () => {
  const own = {
    rows: [
      { label: '1h', score: 0.4, low: 1, high: 2 },
      { label: '2h', score: null, low: 3, high: 4 },
    ],
    consensus: 0.4, bullish: 1, bearish: 0, flat: 0, scored: 1, agreement: '1 of 1 bullish',
    directionEdgePts: 0.6, sampleWindows: 105_119,
  } as unknown as Parameters<typeof withMeasured>[0];
  const merged = withMeasured(own, { model: 'measured-states-v1', measuredAt: 'x', rows: [{ label: '1h', pUp: 0.39 } as never] });
  assert.equal(merged.rows[0]!.score, 0.4);
  assert.equal((merged.rows[0]!.measured as { pUp: number }).pUp, 0.39);
  assert.equal(merged.rows[1]!.measured, null, 'a horizon the service did not answer has no measured row');
  assert.deepEqual(merged.model, { name: 'measured-states-v1', measuredAt: 'x' });
  assert.equal(withMeasured(own, null).model, null);
  assert.equal(withMeasured(own, null).rows[0]!.measured, undefined, 'untouched when nothing answered');
});
