/**
 * The screen's own choices, kept by the desk (server: ui/settings.ts). Quiet on purpose: a choice that could not be
 * read or kept is the browser's copy carrying on, never an error on the screen or in the log.
 */
export type UiSetting = { value: unknown; updatedAt: number };

export async function readUiSettings(): Promise<Record<string, UiSetting>> {
  try {
    const r = await fetch('/api/ui-settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) return {};
    const body = (await r.json()) as { settings?: Record<string, UiSetting> };
    return body.settings ?? {};
  } catch {
    return {};
  }
}

export async function writeUiSetting(key: string, value: unknown, at: number): Promise<UiSetting | null> {
  try {
    const r = await fetch('/api/ui-settings', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key, value, at }),
    });
    if (!r.ok) return null;
    const b = (await r.json()) as { value: unknown; updatedAt: number };
    return { value: b.value, updatedAt: b.updatedAt };
  } catch {
    return null;
  }
}

export async function removeUiSetting(key: string): Promise<void> {
  try { await fetch(`/api/ui-settings/${encodeURIComponent(key)}`, { method: 'DELETE', credentials: 'same-origin' }); } catch { /* the browser's copy is gone already */ }
}
