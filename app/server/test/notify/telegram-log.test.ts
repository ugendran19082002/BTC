import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../../src/db/pool.js';
import { logTelegram, telegramLog } from '../../src/notify/telegram-log.js';

after(closePool);

test('[critical] the Telegram log keeps every attempt, newest first, and narrows to one kind', async () => {
  const t = Date.now();
  await logTelegram({ at: t, key: 'a:entry', status: 'sent', text: 'SOLD 3 PE' });
  await logTelegram({ at: t + 1, key: 'b:entry', status: 'failed', text: 'SOLD 3 CE', error: 'Forbidden: bot was blocked (HTTP 403)' });
  await logTelegram({ at: t + 2, key: 'a:entry', status: 'repeat', text: 'SOLD 3 PE' });
  const all = await telegramLog(10);
  assert.deepEqual(all.slice(0, 3).map((e) => e.status), ['repeat', 'failed', 'sent']);
  const failed = await telegramLog(10, 'failed');
  assert.ok(failed.every((e) => e.status === 'failed'));
  assert.equal(failed[0]!.error, 'Forbidden: bot was blocked (HTTP 403)');
});
