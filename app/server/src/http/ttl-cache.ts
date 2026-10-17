/**
 * One answer per key for `ms`: the chart's pollers, from however many tabs,
 * share a read instead of each making it. The promise itself is held, so
 * requests that arrive while a read is in flight wait for that read rather
 * than starting another. A failed read is not kept -- the next request tries
 * again. Keys past their time are swept once the map grows.
 */
export function ttlCache<T>(ms: number, now: () => number = Date.now) {
  const held = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const t = now();
    const hit = held.get(key);
    if (hit && t - hit.at < ms) return hit.value;
    const value = load();
    held.set(key, { at: t, value });
    value.catch(() => { if (held.get(key)?.value === value) held.delete(key); });
    if (held.size > 64) for (const [k, v] of held) if (t - v.at >= ms) held.delete(k);
    return value;
  };
}

/**
 * As `ttlCache`, but a key past its `ms` keeps answering while it is read again (17 Oct 2026): the read is started,
 * waited on at most `waitMs`, and the held answer given if it is slower -- so a poller never waits on the feed's round
 * trip once the key has been read. Held no longer than `staleMs`, after which the read is waited on as on a cold key;
 * a failed read again keeps the held answer. For what a screen draws, not for what an order is decided on.
 */
export function ttlCacheStale<T>(ms: number, staleMs: number, waitMs = 250, now: () => number = Date.now) {
  const held = new Map<string, { at: number; value: T }>();
  const working = new Map<string, Promise<T>>();
  const read = (key: string, load: () => Promise<T>): Promise<T> => {
    const busy = working.get(key);
    if (busy) return busy;
    const t = now();
    const value = load().then((v) => { held.set(key, { at: t, value: v }); return v; }).finally(() => working.delete(key));
    working.set(key, value);
    if (held.size > 64) for (const [k, v] of held) if (t - v.at >= staleMs) held.delete(k);
    return value;
  };
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = held.get(key);
    const age = hit ? now() - hit.at : Infinity;
    if (hit && age < ms) return hit.value;
    if (!hit || age >= staleMs) return read(key, load);
    const kept = hit.value;
    const fresh = read(key, load).catch(() => kept);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<T>((done) => { timer = setTimeout(() => done(kept), waitMs); timer.unref?.(); });
    try { return await Promise.race([fresh, late]); } finally { clearTimeout(timer); }
  };
}
