import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODE, THEME_KEY, readMode, reloadThemeForTest, resolveTheme, setThemeMode } from '@/lib/theme';
import { ThemeSwitch, ThemeToggle } from '@/components/ui/theme-switch';

/**
 * Light, dark, or as the device is (owner, 20 Oct 2026): kept in this browser, on the root as `data-theme` -- where
 * every token takes its light value -- and in the browser's own bar; the device followed where asked; and set before
 * the first paint by the boot script, which reads the same key.
 */
let light = false;
const listeners = new Set<() => void>();
beforeEach(() => {
  window.localStorage.clear();
  light = false;
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '<meta name="theme-color" content="#0a0d10">';
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return q.includes('light') && light; }, media: q,
    addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f),
  }));
  reloadThemeForTest();
});
afterEach(() => { vi.unstubAllGlobals(); listeners.clear(); });
const bar = () => document.querySelector('meta[name="theme-color"]')!.getAttribute('content');

describe('the theme', () => {
  it('[critical] dark until chosen; a choice is kept, on the root and in the browser bar', () => {
    expect(DEFAULT_MODE).toBe('dark');
    expect(readMode()).toBe('dark');
    setThemeMode('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(bar()).toBe('#f4f5f7');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('"light"');
    expect(readMode()).toBe('light');
    setThemeMode('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(bar()).toBe('#0a0d10');
    window.localStorage.setItem(THEME_KEY, '"purple"');
    expect(readMode()).toBe('dark');
  });

  it('[critical] as the device is: its setting now, and again when it changes', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole('radio', { name: /Device/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByText(/As this device is set: dark now/)).toBeInTheDocument();
    act(() => { light = true; for (const f of listeners) f(); });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByText(/As this device is set: light now/)).toBeInTheDocument();
  });

  it('the switch: three choices, the chosen one said; the top bar\'s button flips light and dark', () => {
    render(<><ThemeSwitch /><ThemeToggle /></>);
    expect(screen.getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to the light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('radio', { name: /Light/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to the dark theme' }));
    expect(screen.getByRole('radio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('another tab\'s choice is this one\'s too', () => {
    render(<ThemeSwitch />);
    act(() => {
      window.localStorage.setItem(THEME_KEY, '"light"');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }));
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('radio', { name: /Light/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('[critical] the boot script reads the same key, and is the one script the page loads before the app', () => {
    const boot = readFileSync(join(__dirname, '../../public/theme-boot.js'), 'utf8');
    expect(boot).toContain(`'${THEME_KEY}'`);
    const html = readFileSync(join(__dirname, '../../index.html'), 'utf8');
    expect(html.indexOf('/theme-boot.js')).toBeGreaterThan(0);
    expect(html.indexOf('/theme-boot.js')).toBeLessThan(html.indexOf('/src/main.tsx'));
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    // Run it: a light choice is on the root before anything else.
    window.localStorage.setItem(THEME_KEY, '"light"');
    document.documentElement.removeAttribute('data-theme');
    new Function(boot)();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(bar()).toBe('#f4f5f7');
  });
});
