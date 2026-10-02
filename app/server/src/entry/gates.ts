import { query, rows } from '../db/pool.js';
import { migrate, type Migration } from '../db/migrate.js';

/**
 * Which of the entry engine's hard gates are switched on.
 *
 * Every gate is on unless the owner turns it off from the entry section. A
 * gate that is off is still computed and still shown -- "✗ would refuse" --
 * it just no longer makes the read NO TRADE. Two rules keep that honest:
 *
 *   - **Data fresh is locked on.** On stale candles every other reading, the
 *     setup included, describes a market that has moved on.
 *   - **The paper log remembers.** Each setup is written with the gates that
 *     were off (`entry_setups.gates_off`), and the record counts only setups
 *     taken with every gate on, so switching a gate off can never quietly
 *     change what the record says the rules did.
 *
 * Each change is also appended to `entry_gate_changes`, so "when was R:R
 * turned off" has an answer.
 */

export type GateKey = 'data' | 'plan' | 'spread' | 'mark' | 'stop' | 'rr' | 'htf' | 'big-move' | 'em' | 'settle' | 'method';

/** The gates in the checklist's order, what each is called, and which cannot be switched off. */
export const GATES: readonly { key: GateKey; label: string; locked?: string }[] = [
  { key: 'data', label: 'Data fresh', locked: 'On stale candles every other reading describes a market that has moved on.' },
  { key: 'plan', label: 'Plan valid', locked: 'A stop on the wrong side, a TGT1 the price has already reached, or an entry the price has left far behind is not a trade.' },
  { key: 'spread', label: 'Spread' },
  { key: 'mark', label: 'Perp at mark' },
  { key: 'stop', label: 'Stop band' },
  { key: 'rr', label: 'R:R' },
  { key: 'htf', label: 'HTF alignment' },
  { key: 'big-move', label: 'Big-move risk' },
  { key: 'em', label: 'Expected move' },
  { key: 'settle', label: 'Settlement' },
  { key: 'method', label: 'Method gate' },
];
const KEYS = new Set<string>(GATES.map((g) => g.key));
export const isGateKey = (k: string): k is GateKey => KEYS.has(k);

const MIGRATIONS: Migration[] = [
  {
    id: 'entry-002-gates',
    up: `
      CREATE TABLE IF NOT EXISTS entry_gates (
        key        TEXT    PRIMARY KEY,
        enabled    BOOLEAN NOT NULL,
        changed_at BIGINT  NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entry_gate_changes (
        id      BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        at      BIGINT  NOT NULL,
        key     TEXT    NOT NULL,
        enabled BOOLEAN NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entry_gate_changes_by_time ON entry_gate_changes (at DESC);
    `,
  },
];

let ready: Promise<void> | null = null;
/** The tables, created once. (`entry_setups.gates_off` is the paper log's own migration.) */
export function gatesSchema(): Promise<void> {
  if (ready) return ready;
  ready = migrate(MIGRATIONS).then(() => {}, (e) => { ready = null; throw e; });
  return ready;
}

/** The switched-off gates, read once and kept until the next change. */
let cached: Promise<GateKey[]> | null = null;

export function gatesOff(): Promise<GateKey[]> {
  cached ??= gatesSchema()
    .then(() => rows<{ key: string }>('SELECT key FROM entry_gates WHERE enabled = false ORDER BY key'))
    .then((rs) => rs.map((r) => r.key).filter(isGateKey).filter((k) => !GATES.find((g) => g.key === k)?.locked))
    .catch((e) => { cached = null; throw e; });
  return cached;
}

export type GateSetting = { key: GateKey; label: string; enabled: boolean; locked: string | null; changedAt: number | null };

/** Every gate with its switch, for the settings list. */
export async function gateSettings(): Promise<GateSetting[]> {
  await gatesSchema();
  const saved = new Map((await rows<{ key: string; enabled: boolean; changed_at: string }>('SELECT key, enabled, changed_at FROM entry_gates'))
    .map((r) => [r.key, r]));
  return GATES.map((g) => {
    const s = saved.get(g.key);
    return {
      key: g.key, label: g.label, locked: g.locked ?? null,
      enabled: g.locked ? true : s ? s.enabled : true,
      changedAt: s ? Number(s.changed_at) : null,
    };
  });
}

/** Switch one gate. Refuses a locked one; returns the whole list as it now stands. */
export async function setGate(key: GateKey, enabled: boolean, now = Date.now()): Promise<GateSetting[]> {
  const g = GATES.find((x) => x.key === key);
  if (!g) throw new Error(`no such gate: ${key}`);
  if (g.locked && !enabled) throw new GateLocked(`${g.label} cannot be switched off: ${g.locked}`);
  await gatesSchema();
  await query(
    `INSERT INTO entry_gates (key, enabled, changed_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, changed_at = EXCLUDED.changed_at`,
    [key, enabled, now],
  );
  await query('INSERT INTO entry_gate_changes (at, key, enabled) VALUES ($1, $2, $3)', [now, key, enabled]);
  cached = null;
  return gateSettings();
}

export class GateLocked extends Error {}
