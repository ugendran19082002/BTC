import { query, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import type { Alert } from '../notify/messages.js';
import type { MethodRead, Mode } from './types.js';

/**
 * Telegram alerts for the entry section's TRADEs, switched on or off for each
 * way -- without the timeframe chain, with it -- from the screen.
 *
 * Off until switched on: a phone that starts buzzing because of a deploy is
 * not a feature. An alert goes out once per setup -- when the paper log first
 * writes it (the same key: method, way, timeframe, direction, trigger bar) --
 * never once a minute for as long as it stays on the board. The text says
 * plainly that nothing was ordered (decision 0013).
 */

export const MODES: readonly Mode[] = ['single', 'mtf'];
export const isMode = (m: string): m is Mode => (MODES as readonly string[]).includes(m);

const MIGRATIONS: Migration[] = [{
  id: 'entry-004-alerts',
  up: `
    CREATE TABLE IF NOT EXISTS entry_alerts (
      mode       TEXT    PRIMARY KEY CHECK (mode IN ('single', 'mtf')),
      enabled    BOOLEAN NOT NULL,
      changed_at BIGINT  NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entry_alert_changes (
      id      BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at      BIGINT  NOT NULL,
      mode    TEXT    NOT NULL,
      enabled BOOLEAN NOT NULL
    );
  `,
}];

let ready: Promise<void> | null = null;
export function alertsSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

export type AlertSetting = { mode: Mode; enabled: boolean; changedAt: number | null };

/** Both ways' switches; a way never switched is off. */
export async function alertSettings(): Promise<AlertSetting[]> {
  await alertsSchema();
  const saved = new Map((await rows<{ mode: string; enabled: boolean; changed_at: string }>('SELECT mode, enabled, changed_at FROM entry_alerts'))
    .map((r) => [r.mode, r]));
  return MODES.map((mode) => {
    const s = saved.get(mode);
    return { mode, enabled: s?.enabled ?? false, changedAt: s ? Number(s.changed_at) : null };
  });
}

/** Switch one way's alerts; every change is logged. Returns both as they now stand. */
export async function setAlert(mode: Mode, enabled: boolean, now = Date.now()): Promise<AlertSetting[]> {
  await alertsSchema();
  await query(
    `INSERT INTO entry_alerts (mode, enabled, changed_at) VALUES ($1, $2, $3)
     ON CONFLICT (mode) DO UPDATE SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at`,
    [mode, enabled, now],
  );
  await query('INSERT INTO entry_alert_changes (at, mode, enabled) VALUES ($1, $2, $3)', [now, mode, enabled]);
  return alertSettings();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v: number) => Math.round(v).toLocaleString('en-US');

/**
 * A new TRADE, as the phone reads it. Telegram HTML: <b> and <i> only, every
 * `&`, `<` and `>` escaped. Null for anything that is not a TRADE with levels.
 */
export function entryAlertFor(r: MethodRead): Alert | null {
  const p = r.plan;
  if (r.state !== 'TRADE' || !p || !r.dir || r.triggerTime === null) return null;
  const long = r.dir === 'long';
  const way = r.mode === 'mtf' ? 'with timeframe (5m entry)' : `without timeframe (${r.tf})`;
  const risk = Math.abs((p.entryLo + p.entryHi) / 2 - p.stop);
  const off = r.gates.filter((g) => !g.enabled).map((g) => g.label);
  const lines = [
    `${long ? '🟢 <b>BUY</b>' : '🔴 <b>SELL</b>'} · <b>#${r.n} ${esc(r.name)}</b>`,
    `<i>${esc(way)}</i>`,
    `Entry ${fmt(p.entryLo)}–${fmt(p.entryHi)}`,
    `SL ${fmt(p.stop)} (${fmt(risk)} pts)`,
    `TP1 ${fmt(p.tp1)}${p.tp2 !== null ? ` · TP2 ${fmt(p.tp2)}` : ''}${p.tp3 !== null ? ` · TP3 ${fmt(p.tp3)}` : ''}`,
    `R:R ${p.rr.toFixed(2)} after fees · quality ${r.score ?? '–'}/100`,
    ...(off.length ? [`⚠️ gates off: ${esc(off.join(', '))}`] : []),
    '<i>Paper-logged · no order placed</i>',
  ];
  return { key: `entry:${r.mode}:${r.id}:${r.dir}:${r.triggerTime}`, text: lines.join('\n') };
}
