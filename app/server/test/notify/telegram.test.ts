import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MESSAGE_CHARS, partsOf, TelegramNotifier, type TelegramOptions } from '../../src/notify/telegram.js';

const TOKEN = '123456:TEST-token-never-to-be-seen';

type Reply = { status: number; body?: unknown } | Error;

function make(replies: Reply[] = [], over: Partial<TelegramOptions> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const errors: { message: string; context: Record<string, unknown> }[] = [];
  const slept: number[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = replies.shift() ?? { status: 200, body: { ok: true } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? { ok: r.status < 300 }), { status: r.status });
  }) as typeof fetch;
  const n = new TelegramNotifier({
    token: TOKEN,
    chatId: '42',
    fetch: fakeFetch,
    sleep: async (ms) => { slept.push(ms); },
    coalesceMs: 5,
    maxWaitMs: 50,
    onError: (message, context) => errors.push({ message, context }),
    ...over,
  });
  return { n, calls, errors, slept };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a message goes to the bot\'s sendMessage for the configured chat, as HTML', async () => {
  const { n, calls } = make();
  assert.equal(await n.send('<b>SOLD</b>'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0]!.body.chat_id, '42');
  assert.equal(calls[0]!.body.parse_mode, 'HTML');
  assert.equal(calls[0]!.body.text, '<b>SOLD</b>');
});

test('a burst of alerts for one trade and leg is one message: the newest', async () => {
  const { n, calls } = make();
  n.notify({ key: 't1:entry', text: 'filled 26 of 425' });
  n.notify({ key: 't1:entry', text: 'filled 200 of 425' });
  n.notify({ key: 't1:entry', text: 'filled 425 of 425' });
  assert.equal(calls.length, 0, 'notify must return before anything is sent');
  await wait(30);
  await n.drain();
  assert.deepEqual(calls.map((c) => c.body.text), ['filled 425 of 425']);
});

test('different keys are separate messages, sent in the order they were raised', async () => {
  const { n, calls } = make();
  n.notify({ key: 't1:entry', text: 'entry' });
  n.notify({ key: 't1:exit', text: 'exit' });
  await n.drain();
  assert.deepEqual(calls.map((c) => c.body.text), ['entry', 'exit']);
});

test('a rate limit waits as long as Telegram asks, then sends', async () => {
  const { n, calls, slept, errors } = make([
    { status: 429, body: { ok: false, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } } },
  ]);
  assert.equal(await n.send('x'), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [3_000]);
  assert.equal(errors.length, 0);
});

test('a network failure is retried with backoff, then written down once -- and the next alert still goes', async () => {
  const { n, calls, slept, errors } = make([
    new Error(`connect ETIMEDOUT https://api.telegram.org/bot${TOKEN}/sendMessage`),
    { status: 502 },
    { status: 503 },
  ]);
  assert.equal(await n.send('x'), false);
  assert.equal(calls.length, 3);
  assert.deepEqual(slept, [1_000, 2_000]);
  assert.equal(errors.length, 1);
  assert.equal(await n.send('y'), true);
});

test('a wrong token is not retried, and the token never appears in what is reported', async () => {
  const { n, calls, errors } = make([
    { status: 401, body: { ok: false, description: `Unauthorized: bot${TOKEN}` } },
  ]);
  assert.equal(await n.send('x'), false);
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 1);
  assert.ok(!JSON.stringify(errors).includes(TOKEN), JSON.stringify(errors));
});

test('markup Telegram cannot parse is sent again as plain words rather than lost', async () => {
  const { n, calls, errors } = make([
    { status: 400, body: { ok: false, description: "Bad Request: can't parse entities: unsupported start tag" } },
  ]);
  assert.equal(await n.send('<b>P&amp;L</b> <i>+₹89</i>'), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.parse_mode, undefined);
  assert.equal(calls[1]!.body.text, 'P&L +₹89');
  assert.equal(errors.length, 0);
});

test('a reporter that throws cannot turn a failed alert into an exception', async () => {
  const { n } = make([{ status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }], {
    onError: () => { throw new Error('reporter broke'); },
  });
  assert.equal(await n.send('x'), false);
});

/*
 * The repeat guard.
 *
 * On 23 September the phone was buzzing with the same alert over and over. The
 * desk retries a protective order Delta refused every few seconds, each attempt
 * that fails raises the alarm again, and the alarm carries Delta's own words --
 * so "the same alert" was never quite the same string, and nothing stopped it.
 * These pin both halves: identical words are not said again for a while, and an
 * alert that knows it comes from a retry loop asks for a quiet period whatever
 * the words.
 */

/** A notifier with a clock the test moves. */
function timed(over: Partial<TelegramOptions> = {}) {
  let clock = 1_790_000_000_000;
  const made = make([], { now: () => clock, coalesceMs: 0, ...over });
  return { ...made, tick: (ms: number) => { clock += ms; } };
}

test('the same words under the same key are not said again for the quiet period', async () => {
  const { n, calls, tick } = timed({ repeatMs: 900_000 });
  n.notify({ key: 't1:problem:no-stop', text: 'NO STOP-LOSS' });
  await n.drain();
  tick(60_000);
  n.notify({ key: 't1:problem:no-stop', text: 'NO STOP-LOSS' });
  await n.drain();
  assert.equal(calls.length, 1, 'a minute later is still the same news');
  assert.equal(n.repeatsHeld, 1);

  tick(900_000);
  n.notify({ key: 't1:problem:no-stop', text: 'NO STOP-LOSS' });
  await n.drain();
  assert.equal(calls.length, 2, 'a position still unprotected a quarter of an hour on is worth saying again');
});

test('[critical] a retry loop whose words keep changing is still one alert, not one a retry', async () => {
  const { n, calls, tick } = timed();
  // What the engine actually produces: Delta's reason, and it moves.
  const reasons = [
    'POSITION UNPROTECTED: could not cancel the stop loss already on the book',
    'POSITION UNPROTECTED: order rejected: risk check failed at 09:41:02',
    'POSITION UNPROTECTED: order rejected: risk check failed at 09:41:04',
  ];
  for (const reason of reasons) {
    n.notify({ key: 't1:problem:no-stop', text: reason, repeatAfterMs: 900_000 });
    await n.drain();
    tick(2_000);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.text, reasons[0]);
  assert.equal(n.repeatsHeld, 2);
});

test('a quiet period covers only its own key: other news gets through', async () => {
  const { n, calls } = timed();
  n.notify({ key: 't1:problem:no-stop', text: 'no stop', repeatAfterMs: 900_000 });
  await n.drain();
  n.notify({ key: 't1:problem:rejected', text: 'rejected', repeatAfterMs: 900_000 });
  n.notify({ key: 't1:exit', text: 'target hit' });
  await n.drain();
  assert.deepEqual(calls.map((c) => c.body.text), ['no stop', 'rejected', 'target hit']);
});

test('a message Telegram refused starts no quiet period -- the next one must still go', async () => {
  const { n, calls } = make([{ status: 403, body: { ok: false, description: 'Forbidden' } }], {
    now: () => 1_790_000_000_000, coalesceMs: 0,
  });
  n.notify({ key: 't1:entry', text: 'SOLD 425' });
  await n.drain();
  n.notify({ key: 't1:entry', text: 'SOLD 425' });
  await n.drain();
  assert.equal(calls.length, 2, 'nothing arrived the first time, so it is not a repeat');
  assert.equal(n.repeatsHeld, 0);
});

test('[critical] every message is told: sent, failed with Telegram\'s reason, or held back as a repeat -- the Telegram log', async () => {
  const results: { key: string; status: string; error: string | null; text: string }[] = [];
  const { n } = make([
    { status: 200, body: { ok: true } },
    { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } },
  ], { onResult: (r) => results.push(r) });
  n.notify({ key: 't1:entry', text: 'SOLD 3 PE' });
  await n.drain();
  n.notify({ key: 't2:entry', text: 'SOLD 3 CE' });
  await n.drain();
  await new Promise((r) => setTimeout(r, 10));
  n.notify({ key: 't1:entry', text: 'SOLD 3 PE' });                  // the same words again, inside the quiet period
  await n.drain();
  assert.deepEqual(results.map((r) => [r.key, r.status]), [['t1:entry', 'sent'], ['t2:entry', 'failed'], ['t1:entry', 'repeat']]);
  assert.match(results[1]!.error!, /bot was blocked by the user \(HTTP 403\)/);
  assert.equal(results[0]!.text, 'SOLD 3 PE');
});

// ------------------------------------------------------------ long messages

/** A day's summary as the desk writes it: a head, then one line a trade, each with its own markup. */
const summary = (trades: number) => [
  '📊 <b>DAY SUMMARY · Sun 4 Oct 2026</b>', '✔️ All positions closed · LIVE', '', `Trades: <b>${trades}</b>`, '', '<b>Trades</b>',
  ...Array.from({ length: trades }, (_, i) => `⏹ BTC 83,800 PE · ${i + 1} @ 49.00 → 56.00 · <b>-₹1.78</b>`),
].join('\n');

test('[critical] a message over Telegram\'s limit goes in parts, cut between lines, in order, nothing lost', async () => {
  const text = summary(109);
  assert.ok(text.length > 4_096, 'the day that failed: 109 trades');
  const parts = partsOf(text);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((x) => x.length <= 4_096), 'each part is one Telegram will take');
  assert.equal(parts[1]!.split('\n')[0], '… 2/2', 'a later part says which it is');
  assert.equal([parts[0], parts[1]!.split('\n').slice(1).join('\n')].join('\n'), text, 'the parts are the message, whole');
  for (const x of parts) {
    assert.equal((x.match(/<b>/g) ?? []).length, (x.match(/<\/b>/g) ?? []).length, 'no tag is left open across a cut');
  }

  const { n, calls, errors } = make();
  assert.equal(await n.send(text), true);
  assert.deepEqual(calls.map((c) => c.body.text), parts, 'sent in order');
  assert.ok(calls.every((c) => c.body.parse_mode === 'HTML'));
  assert.equal(errors.length, 0);
});

test('a message that fits is one message, untouched; one long line is cut where it stands', () => {
  assert.ok(summary(60).length <= MAX_MESSAGE_CHARS);
  assert.deepEqual(partsOf(summary(60)), [summary(60)], 'a day that fits still goes as one');
  const line = 'x'.repeat(MAX_MESSAGE_CHARS * 2 + 10);
  const cut = partsOf(line);
  assert.equal(cut.length, 3);
  assert.equal(cut.map((x, i) => (i ? x.split('\n').slice(1).join('\n') : x)).join(''), line);
});

test('[critical] a part Telegram refuses fails the message and is written down once; the log still has one row for it', async () => {
  const told: { status: string; text: string }[] = [];
  const text = summary(109);
  const { n, calls, errors } = make([{ status: 200 }, { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }],
    { onResult: (r) => told.push({ status: r.status, text: r.text }) });
  n.notify({ key: 'day:summary', text });
  await n.drain();
  assert.equal(calls.length, 2, 'the first part went, the second was refused');
  assert.equal(errors.length, 1);
  assert.deepEqual(told.map((t) => [t.status, t.text === text]), [['failed', true]], 'one row, with the whole message');
});
