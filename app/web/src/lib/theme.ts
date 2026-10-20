import { useEffect, useSyncExternalStore } from 'react';

/**
 * Light and dark (owner, 20 Oct 2026: "light and dark theme, every screen, desk and phone, one design"). The choice is
 * this browser's own -- light, dark, or as the device is -- kept beside the screens' other choices, and the theme is
 * `data-theme` on the root, where `styles.css` gives every token its light value. Set before the first paint by
 * `public/theme-boot.js` (the CSP allows no inline script), so a light page never flashes dark first; here it is kept
 * in step with the choice and, for "as the device is", with the device.
 */
export type ThemeMode = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

/** Where the choice is kept: usePersisted's own prefix, so the boot script and the hook read one value. */
export const THEME_KEY = 'btc-desk:theme';
/** Dark until chosen otherwise: the desk has always been dark, and a trader's screen should not change under them. */
export const DEFAULT_MODE: ThemeMode = 'dark';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function readMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    const v = raw === null ? null : JSON.parse(raw);
    return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

const deviceLight = () => { try { return window.matchMedia?.(LIGHT_QUERY).matches ?? false; } catch { return false; } };
export const resolveTheme = (mode: ThemeMode, light = deviceLight()): Theme => (mode === 'system' ? (light ? 'light' : 'dark') : mode);

/** The theme on the root, and the browser's own bar in its ground colour. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute('content', theme === 'light' ? '#f4f5f7' : '#0a0d10');
}

const listeners = new Set<() => void>();
let mode: ThemeMode = typeof window === 'undefined' ? DEFAULT_MODE : readMode();
const notify = () => { for (const l of listeners) l(); };

export function setThemeMode(next: ThemeMode): void {
  mode = next;
  try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch { /* storage unavailable: this visit only */ }
  applyTheme(resolveTheme(next));
  notify();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  // "As the device is": the device turning light or dark at sunset follows it.
  let media: MediaQueryList | null = null;
  try { media = window.matchMedia?.(LIGHT_QUERY) ?? null; } catch { media = null; }
  const onDevice = () => { if (mode === 'system') { applyTheme(resolveTheme('system')); notify(); } };
  media?.addEventListener?.('change', onDevice);
  // Another tab chose: this one follows.
  const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY) { mode = readMode(); applyTheme(resolveTheme(mode)); notify(); } };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(l); media?.removeEventListener?.('change', onDevice); window.removeEventListener('storage', onStorage); };
}

/** The choice, the theme it comes to now, and the way to change it. */
export function useTheme(): { mode: ThemeMode; theme: Theme; setMode: (m: ThemeMode) => void } {
  const m = useSyncExternalStore(subscribe, () => mode, () => DEFAULT_MODE);
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(mode), () => 'dark' as Theme);
  // The root is set by the boot script; a page that started without it (a test, an old cached shell) is set here.
  useEffect(() => { if (document.documentElement.dataset.theme !== theme) applyTheme(theme); }, [theme]);
  return { mode: m, theme, setMode: setThemeMode };
}

/** For tests: the module's own copy of the choice, read again from storage. */
export function reloadThemeForTest(): void { mode = readMode(); }
