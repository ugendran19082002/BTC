import { useCallback, useEffect, useRef, useState } from 'react';
import { readUiSettings, removeUiSetting, writeUiSetting, type UiSetting } from '@/api/ui-settings';

/**
 * A choice the desk keeps for every screen (22 Oct 2026, owner: "what I choose in the backtest and the portfolio --
 * keep it on the database side; I cannot set it all again every time"; "collapse and expand the same").
 *
 * `usePersisted`'s shape and its browser copy -- the screen opens on it at once, and carries on without the server --
 * with the desk's copy behind it: read once as the page opens (`loadSynced`, one request for every choice), the newer
 * of the two kept; set here, kept by the desk a moment later (`WRITE_AFTER_MS`, one write for a burst of changes). A
 * choice this browser had before the desk kept any is handed to the desk the first time, so nothing set is lost.
 */
const PREFIX = 'btc-desk:';
const AT = 'btc-desk:at:';
export const WRITE_AFTER_MS = 600;

let loading: Promise<Record<string, UiSetting>> | null = null;
/** Every choice the desk keeps, asked for once a page. */
export const loadSynced = (): Promise<Record<string, UiSetting>> => (loading ??= readUiSettings());
/** For tests: the next screen asks again. */
export const forgetSynced = () => { loading = null; for (const t of timers.values()) clearTimeout(t); timers.clear(); };

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const write = (key: string, value: unknown, at: number) => {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.set(key, setTimeout(() => { timers.delete(key); void writeUiSetting(key, value, at); }, WRITE_AFTER_MS));
};

const safe = <T,>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };
const localOf = <T,>(key: string, initial: T): { value: T; at: number; had: boolean } => safe(() => {
  const raw = localStorage.getItem(PREFIX + key);
  return raw === null ? { value: initial, at: 0, had: false } : { value: JSON.parse(raw) as T, at: Number(localStorage.getItem(AT + key) ?? 0) || 0, had: true };
}, { value: initial, at: 0, had: false });
const keepLocal = (key: string, value: unknown, at: number) => safe(() => {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
  localStorage.setItem(AT + key, String(at));
}, undefined);

export function useSynced<T>(key: string, initial: T) {
  const [value, setState] = useState<T>(() => localOf(key, initial).value);
  const current = useRef(value);
  current.current = value;
  const touched = useRef(false);

  useEffect(() => {
    let live = true;
    touched.current = false;
    void loadSynced().then((all) => {
      if (!live) return;
      const kept = all[key];
      const mine = localOf(key, initial);
      if (kept && kept.updatedAt > mine.at && !touched.current) {
        // Set since on another screen: this one follows it.
        keepLocal(key, kept.value, kept.updatedAt);
        setState(kept.value as T);
      } else if ((!kept && mine.had) || (kept && mine.at > kept.updatedAt)) {
        // This browser's is newer, or the desk has none yet: handed over.
        write(key, mine.value, mine.at || Date.now());
      }
    });
    return () => { live = false; };
    // `initial` is a default, not a dependency: a new object each render must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    const v = typeof next === 'function' ? (next as (prev: T) => T)(current.current) : next;
    current.current = v;
    touched.current = true;
    const at = Date.now();
    keepLocal(key, v, at);
    write(key, v, at);
    setState(v);
  }, [key]);

  const reset = useCallback(() => {
    safe(() => { localStorage.removeItem(PREFIX + key); localStorage.removeItem(AT + key); }, undefined);
    const t = timers.get(key);
    if (t) { clearTimeout(t); timers.delete(key); }
    void removeUiSetting(key);
    current.current = initial;
    setState(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, set, reset] as const;
}
