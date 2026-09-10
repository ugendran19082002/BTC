import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramNotifier, type TelegramOptions } from '../../src/notify/telegram.js';

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
