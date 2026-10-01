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
