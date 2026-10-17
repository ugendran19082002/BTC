/**
 * A counter that moves whenever the entry tables are written -- a signal
 * recorded, a setup logged or graded, an alert logged. A read cached under it
 * is exact: the same version, the same answer. It lives in this process because
 * the writers do too (the recorder and both graders run in the API), which is
 * what makes an in-memory cache safe here and a network cache (Redis)
 * unnecessary: one process, no hop, nothing to keep in step.
 */
let version = 0;

export const dataVersion = (): number => version;
export const bumpDataVersion = (): void => { version++; };

/**
 * One answer per key and data version, shared by every caller asking at once.
 * At most `size` kept; anything older than `maxAgeMs` is read again regardless
 * -- the backstop for a write that did not bump the version (a migration, a
 * hand edit).
 */
export function versionCache<T>(size = 100, maxAgeMs = 60_000) {
  const held = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, read: () => Promise<T>, now = Date.now()): Promise<T> => {
    const k = `${dataVersion()}|${key}`;
    const hit = held.get(k);
    if (hit && now - hit.at < maxAgeMs) return hit.value;
    const value = read();
    held.set(k, { at: now, value });
    // A failed read is not kept: the next caller tries again.
    value.catch(() => { if (held.get(k)?.value === value) held.delete(k); });
    while (held.size > size) held.delete(held.keys().next().value!);
    return value;
  };
}

/**
 * The last good answer without a long wait, and a fresh one worked out behind it (17 Oct 2026: the entry record kept the
 * screen waiting while it was reckoned). The first ask waits for its answer. After that, if the data has moved on
 * (`dataVersion`) or the answer is older than `maxAgeMs`, one refresh is started -- never two at a time -- and the ask
 * waits for it up to `waitMs`: fresh when it is quick, the last answer when it is not. A refresh that fails keeps the
 * last good answer.
 */
export function freshInBackground<T>(read: () => Promise<T>, maxAgeMs = 60_000, waitMs = 250) {
  let last: { at: number; version: number; value: T } | null = null;
  let working: Promise<T> | null = null;
  const refresh = (now: number): Promise<T> => {
    if (working) return working;
    const version = dataVersion();
    working = read().then((value) => { last = { at: now, version, value }; return value; }).finally(() => { working = null; });
    return working;
  };
  return async (now = Date.now()): Promise<T> => {
    if (!last) return refresh(now);
    if (last.version === dataVersion() && now - last.at < maxAgeMs) return last.value;
    const kept = last.value;
    const fresh = refresh(now).catch(() => kept);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<T>((done) => { timer = setTimeout(() => done(kept), waitMs); timer.unref?.(); });
    try { return await Promise.race([fresh, late]); } finally { clearTimeout(timer); }
  };
}
