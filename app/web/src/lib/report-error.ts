/**
 * Send a browser failure to the server so it lands in the same log as everything
 * else.
 *
 * Three rules, all of them because this runs inside error handling:
 *   - it never throws, and it never awaits anything the caller depends on;
 *   - it never reports its own failure, or a network outage becomes a loop;
 *   - it folds repeats locally too, so a component that throws on every render
 *     does not send a thousand requests before anyone notices.
 */

export type BrowserReport = {
  message: string;
  stack?: string | null;
  where?: string | null;
  code?: string | null;
  level?: 'error' | 'warn';
  context?: Record<string, unknown>;
};

/** Fingerprints already sent, with the time, so a repeat is quiet for a while. */
const sent = new Map<string, number>();
const QUIET_MS = 30_000;
let reporting = false;

export function reportError(r: BrowserReport): void {
  try {
    const key = `${r.where ?? ''}|${r.message}`;
    const last = sent.get(key);
    const now = Date.now();
    if (last !== undefined && now - last < QUIET_MS) return;
    sent.set(key, now);
    if (sent.size > 200) sent.clear();

    // A failure inside the reporter must not be reported.
    if (reporting) return;
    reporting = true;

    void fetch('/api/errors', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'browser',
        level: r.level ?? 'error',
        message: r.message,
        stack: r.stack ?? null,
        where: r.where ?? null,
        code: r.code ?? null,
        context: { ...r.context, url: location.pathname + location.search, at: new Date().toISOString() },
      }),
      // survives the tab being closed straight after the error
      keepalive: true,
    })
      .catch(() => {})
      .finally(() => { reporting = false; });
  } catch {
    reporting = false;
  }
}

/**
 * Catch what React does not: an event handler that throws, a promise nobody
 * awaited, a script that fails to load.
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => {
    reportError({
      message: e.message || 'script error',
      stack: e.error instanceof Error ? e.error.stack : null,
      where: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : 'window.onerror',
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as unknown;
    reportError({
      message: r instanceof Error ? r.message : String(r),
      stack: r instanceof Error ? r.stack : null,
      where: 'unhandled promise rejection',
    });
  });
}
