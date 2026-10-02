import { query, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';

/**
 * Every Telegram message the desk tried to send, and what became of it (2 Oct 2026, owner: "check the last
 * Telegram alerts"): sent, failed with Telegram's reason, or held back as a repeat of the same words.
 *
 * Only failures were written anywhere (the error log), so "what did the phone get today?" had no answer. Kept
 * thirty days; the text is kept in full, as sent -- it is the desk's own words about its own trades.
 */

export type TelegramLogStatus = 'sent' | 'failed' | 'repeat';
export type TelegramLogEntry = { id: number; at: number; key: string; status: TelegramLogStatus; text: string; error: string | null };

const KEEP_MS = 30 * 24 * 3_600_000;

const MIGRATIONS: Migration[] = [{
  id: 'telegram-001-log',
  up: `
    CREATE TABLE IF NOT EXISTS telegram_log (
      id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at     BIGINT NOT NULL,
      key    TEXT   NOT NULL,
      status TEXT   NOT NULL CHECK (status IN ('sent', 'failed', 'repeat')),
      text   TEXT   NOT NULL,
      error  TEXT
    );
    CREATE INDEX IF NOT EXISTS telegram_log_by_time ON telegram_log (at DESC);
  `,
}];

let ready: Promise<void> | null = null;
export function telegramLogSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** Write one attempt down. Never throws: a log that fails is not the alert's problem. */
export async function logTelegram(e: { at: number; key: string; status: TelegramLogStatus; text: string; error?: string | null }): Promise<void> {
  try {
    await telegramLogSchema();
    await query('INSERT INTO telegram_log (at, key, status, text, error) VALUES ($1, $2, $3, $4, $5)',
      [e.at, e.key, e.status, e.text, e.error ?? null]);
    // Thirty days, trimmed now and then rather than on every write.
    if (Math.random() < 0.02) await query('DELETE FROM telegram_log WHERE at < $1', [e.at - KEEP_MS]);
  } catch { /* nothing to do */ }
}

/** The newest first; `status` narrows to one kind. */
export async function telegramLog(limit = 100, status?: TelegramLogStatus): Promise<TelegramLogEntry[]> {
  await telegramLogSchema();
  const xs = await rows<{ id: string; at: string; key: string; status: TelegramLogStatus; text: string; error: string | null }>(
    `SELECT * FROM telegram_log WHERE ($2::text IS NULL OR status = $2) ORDER BY at DESC, id DESC LIMIT $1`,
    [Math.max(1, Math.min(500, limit)), status ?? null],
  );
  return xs.map((x) => ({ id: Number(x.id), at: Number(x.at), key: x.key, status: x.status, text: x.text, error: x.error }));
}
