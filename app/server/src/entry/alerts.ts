import { query, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';
import type { Alert } from '../notify/messages.js';
import type { MethodRead, Mode, Tf } from './types.js';
import { METHODS } from './methods.js';

/** Timeframes a without-the-chain alert may be asked for; 5m unless the owner picks others. */
export const ALERT_TFS: readonly Tf[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h'];
const isTf = (t: string): t is Tf => (ALERT_TFS as readonly string[]).includes(t);

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
}, {
  /*
   * Which timeframes a without-the-chain way alerts on (the chain's entry is
   * always 5m), and every alert the desk tried to send -- sent or failed, and
   * why -- so "did it go?" has an answer that is not a phone.
   */
  id: 'entry-006-alert-log',
  up: `
    ALTER TABLE entry_alerts ADD COLUMN IF NOT EXISTS tfs TEXT[] NOT NULL DEFAULT '{5m}';
    CREATE TABLE IF NOT EXISTS entry_alert_log (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at         BIGINT   NOT NULL,
      mode       TEXT     NOT NULL,
      tf         TEXT     NOT NULL,
      method     TEXT     NOT NULL,
      dir        SMALLINT NOT NULL,
      trigger_at BIGINT   NOT NULL,
      text       TEXT     NOT NULL,
      status     TEXT     NOT NULL CHECK (status IN ('sent', 'failed')),
      error      TEXT
    );
    CREATE INDEX IF NOT EXISTS entry_alert_log_by_time ON entry_alert_log (at DESC);
  `,
}];

let ready: Promise<void> | null = null;
export function alertsSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

export type AlertSetting = {
  mode: Mode; enabled: boolean; changedAt: number | null;
  /** Timeframes it alerts on: without the chain, the owner's pick (5m by default); with it, 5m (its entry). */
  tfs: Tf[];
};

/** Both ways' switches; a way never switched is off. */
export async function alertSettings(): Promise<AlertSetting[]> {
  await alertsSchema();
  const saved = new Map((await rows<{ mode: string; enabled: boolean; changed_at: string; tfs: string[] }>('SELECT mode, enabled, changed_at, tfs FROM entry_alerts'))
    .map((r) => [r.mode, r]));
  return MODES.map((mode) => {
    const s = saved.get(mode);
    const tfs = mode === 'mtf' ? ['5m' as Tf] : (s?.tfs ?? ['5m']).filter(isTf);
    return { mode, enabled: s?.enabled ?? false, changedAt: s ? Number(s.changed_at) : null, tfs: tfs.length ? tfs : ['5m'] };
  });
}

/**
 * Switch one way's alerts, and (without the chain) choose its timeframes;
 * every change is logged. Returns both as they now stand. `tfs` left out
 * keeps what was chosen.
 */
export async function setAlert(mode: Mode, enabled: boolean, now = Date.now(), tfs?: readonly string[]): Promise<AlertSetting[]> {
  await alertsSchema();
  const pick = tfs === undefined ? null : [...new Set(tfs.filter(isTf))];
  if (pick !== null && !pick.length) throw new Error('choose at least one timeframe');
  await query(
    `INSERT INTO entry_alerts (mode, enabled, changed_at, tfs) VALUES ($1, $2, $3, coalesce($4::text[], '{5m}'))
     ON CONFLICT (mode) DO UPDATE SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at,
       tfs = coalesce($4::text[], entry_alerts.tfs)`,
    [mode, enabled, now, pick],
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

/** Whether a new TRADE is one its way is set to alert on: the chain always (its entry is 5m), without it the chosen timeframes. */
export const wanted = (r: Pick<MethodRead, 'mode' | 'tf'>, settings: readonly AlertSetting[]): boolean => {
  const s = settings.find((a) => a.mode === r.mode);
  return !!s?.enabled && (r.mode === 'mtf' || s.tfs.includes(r.tf));
};

/** Write down one alert and what became of it. */
export async function logAlert(r: MethodRead, text: string, status: 'sent' | 'failed', error: string | null, at = Date.now()): Promise<void> {
  await alertsSchema();
  await query(
    `INSERT INTO entry_alert_log (at, mode, tf, method, dir, trigger_at, text, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [at, r.mode, r.tf, r.id, r.dir === 'long' ? 1 : -1, r.triggerTime ?? 0, text, status, error],
  );
}

export type AlertLogRow = { at: number; mode: Mode; tf: Tf; method: string; n: number | null; name: string; dir: 1 | -1; status: 'sent' | 'failed'; error: string | null };

/** The latest alerts, newest first. */
export async function recentAlerts(limit = 20): Promise<AlertLogRow[]> {
  await alertsSchema();
  const rs = await rows<{ at: string; mode: Mode; tf: Tf; method: string; dir: number; status: 'sent' | 'failed'; error: string | null }>(
    'SELECT at, mode, tf, method, dir, status, error FROM entry_alert_log ORDER BY at DESC, id DESC LIMIT $1', [Math.min(200, Math.max(1, limit))],
  );
  return rs.map((r) => {
    const m = METHODS.find((x) => x.id === r.method);
    return { at: Number(r.at), mode: r.mode, tf: r.tf, method: r.method, n: m?.n ?? null, name: m?.name ?? r.method, dir: Number(r.dir) as 1 | -1, status: r.status, error: r.error };
  });
}

/**
 * Send one TRADE's alert and write down how it went. Never throws and never
 * holds the caller: the recorder goes on while Telegram answers.
 */
export function sendEntryAlert(r: MethodRead, notifier: { send(text: string): Promise<boolean> } | null): Promise<void> {
  const alert = entryAlertFor(r);
  if (!alert) return Promise.resolve();
  if (!notifier) return logAlert(r, alert.text, 'failed', 'Telegram is not set up on the server (TG_TOKEN, TG_CHAT_ID)').catch(() => {});
  return notifier.send(alert.text)
    .then((ok) => logAlert(r, alert.text, ok ? 'sent' : 'failed', ok ? null : 'Telegram did not accept it; see the error log'))
    .catch((e) => logAlert(r, alert.text, 'failed', (e as Error).message).catch(() => {}));
}
