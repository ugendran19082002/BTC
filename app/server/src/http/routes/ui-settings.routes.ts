import type { FastifyInstance } from 'fastify';
import { KEY, MAX_KEYS, MAX_VALUE_BYTES, uiSettings } from '../../ui/settings.js';
import { refuse } from '../refuse.js';

/** The screen's own choices, one row each (`ui/settings.ts`): read all at once as a page opens, set one at a time. */
export function registerUiSettingsRoutes(app: FastifyInstance) {
  const store = uiSettings();

  app.get('/api/ui-settings', async () => ({ settings: await store.all() }));

  app.put('/api/ui-settings', async (req, reply) => {
    const b = (req.body ?? {}) as { key?: unknown; value?: unknown; at?: unknown };
    if (typeof b.key !== 'string' || !KEY.test(b.key)) return refuse(reply, 400, { error: 'A setting\'s key is a name of letters, digits and . _ : - (at most 100).' });
    if (b.value === undefined) return refuse(reply, 400, { error: 'A setting needs a value; delete it to go back to the default.' });
    const json = JSON.stringify(b.value);
    if (Buffer.byteLength(json) > MAX_VALUE_BYTES) return refuse(reply, 413, { error: `A setting is at most ${MAX_VALUE_BYTES / 1024} KB.` });
    const now = Date.now();
    // When the screen made the choice, never later than now: a browser's clock ahead must not freeze it.
    const at = typeof b.at === 'number' && Number.isFinite(b.at) && b.at > 0 ? Math.min(Math.round(b.at), now) : now;
    if ((await store.count()) >= MAX_KEYS && !(b.key in (await store.all()))) return refuse(reply, 422, { error: `At most ${MAX_KEYS} settings are kept.` });
    return { ok: true, key: b.key, ...(await store.set(b.key, b.value, at)) };
  });

  app.delete('/api/ui-settings/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!KEY.test(key)) return refuse(reply, 400, { error: 'No such setting.' });
    await store.remove(key);
    return { ok: true };
  });
}
