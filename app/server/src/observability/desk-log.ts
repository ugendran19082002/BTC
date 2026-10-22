/**
 * The server log, for the parts of the desk built before the HTTP app is (22 Oct 2026). The trading services are made
 * at boot ahead of Fastify, whose logger is the one that reaches stdout and the day's file (`log-files.ts`); index.ts
 * hands it over here once it exists. Until then, and in tests, a line goes nowhere. Never throws.
 */
type Level = 'info' | 'warn';
type Sink = (level: Level, fields: Record<string, unknown>, msg: string) => void;

let sink: Sink | null = null;

export function setDeskLog(s: Sink | null): void { sink = s; }

/** Whether the server's log has been handed over yet: before it, a line written here goes nowhere. */
export const hasDeskLog = (): boolean => sink !== null;

export function deskLog(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  try { sink?.(level, fields, msg); } catch { /* a log line is never worth a failure */ }
}
