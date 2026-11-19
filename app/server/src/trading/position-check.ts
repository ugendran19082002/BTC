/**
 * Whether each account's desk holds, contract by contract, what Delta holds (19 Nov 2026).
 *
 * The stops and targets are already audited against Delta's book every few seconds and put back when missing
 * (leg-audit.ts), off a book the desk reads anyway. What nothing compared was the position itself: the journal's open
 * trades, added up per contract, against Delta's own positions. On 19 Nov at 07:09 they agreed on all four accounts --
 * checked by hand. This does that check every quarter hour (and so at 17:45, after the 17:30 settlement, when both
 * must be flat), and tells Telegram only of a difference that is still there a minute later.
 *
 * Read only, and light on Delta: one `GET /v2/positions` an account a round, through the account's own signed
 * transport, so it is counted against that login's quota and held by any wait Delta has named. A round is skipped for
 * an account whose login is past `POSITION_CHECK_QUOTA_PCT` of its quota, or on paper (nothing there is on Delta).
 *
 * What is moving is not judged: the journal is read before and after Delta, and a contract whose open position
 * changed between the two is left for the next round. Only the desk holding the desk lock checks.
 */
import type { Alert } from '../notify/messages.js';
import { positionCheckAlert } from '../notify/messages.js';
import type { TradeRecord } from './engine.js';
import type { ExchangePosition } from './types.js';

export const POSITION_CHECK_MS = 15 * 60_000;
/** Into each quarter hour: 17:45:30, after the settlement's positions have gone from Delta and from the journal. */
export const POSITION_CHECK_OFFSET_MS = 30_000;
export const POSITION_CONFIRM_MS = 60_000;
export const POSITION_CHECK_QUOTA_PCT = 50;
/** The same difference is said again after this long, while it lasts. */
export const POSITION_RETELL_MS = 2 * 3_600_000;

export type CheckedDesk = {
  accountId: number | null;
  name: string;
  live: boolean;
  /** The journal's open trades for this account. */
  open: () => Promise<readonly TradeRecord[]>;
  /** Delta's positions for this account (one GET). */
  positions: () => Promise<readonly ExchangePosition[]>;
  quotaUsedPct: () => number;
};

export type PositionOff = { symbol: string; desk: number; delta: number };

/** Each contract's open position in the journal, in contracts: negative short. */
export function netByContract(recs: readonly TradeRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of recs) {
    const p = Number(r.state.position) || 0;
    if (p !== 0) m.set(r.state.symbol, (m.get(r.state.symbol) ?? 0) + p);
  }
  return m;
}

/**
 * One account read once: the contracts where the journal and Delta disagree, the journal steady across the read.
 * Null when not read (paper, quota, or Delta did not answer): nothing is concluded from a read not made.
 */
export async function readOffs(d: CheckedDesk): Promise<PositionOff[] | null> {
  if (!d.live || d.quotaUsedPct() >= POSITION_CHECK_QUOTA_PCT) return null;
  try {
    const before = netByContract(await d.open());
    const held = await d.positions();
    const after = netByContract(await d.open());
    const delta = new Map<string, number>();
    for (const p of held) if (Number(p.size)) delta.set(p.symbol, (delta.get(p.symbol) ?? 0) + Number(p.size));
    const out: PositionOff[] = [];
    for (const symbol of new Set([...before.keys(), ...after.keys(), ...delta.keys()])) {
      const desk = after.get(symbol) ?? 0;
      if ((before.get(symbol) ?? 0) !== desk) continue;
      const theirs = delta.get(symbol) ?? 0;
      if (desk !== theirs) out.push({ symbol, desk, delta: theirs });
    }
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  } catch {
    return null;
  }
}

const signature = (offs: readonly PositionOff[]) => offs.map((o) => `${o.symbol}:${o.desk}:${o.delta}`).join('|');

export class PositionCheck {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** What was last said per account, and when: a difference, or none (`''`). */
  private readonly told = new Map<string, { sig: string; at: number }>();
  private running = false;
  readonly counts = { rounds: 0, read: 0, skipped: 0, confirmed: 0, told: 0 };

  constructor(private readonly o: {
    desks: () => readonly CheckedDesk[];
    inCharge: () => boolean;
    notify: (a: Alert) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
  }

  /** One round over every account. One at a time; never throws. */
  async round(): Promise<void> {
    if (this.running || !this.o.inCharge()) return;
    this.running = true;
    this.counts.rounds++;
    try {
      const first = new Map<CheckedDesk, PositionOff[]>();
      for (const d of this.o.desks()) {
        const offs = await readOffs(d);
        if (offs === null) { this.counts.skipped++; continue; }
        this.counts.read++;
        first.set(d, offs);
      }
      const suspect = [...first].filter(([, offs]) => offs.length > 0);
      // Agreed: an account that had been told of a difference is told it agrees again.
      for (const [d, offs] of first) if (offs.length === 0) this.tell(d, []);
      if (suspect.length === 0) return;
      await this.sleep(POSITION_CONFIRM_MS);
      if (!this.o.inCharge()) return;
      for (const [d, was] of suspect) {
        const now = await readOffs(d);
        if (now === null) continue;
        // Only what both reads show, as the second has it: a difference that came and went was a trade moving.
        const seen = new Set(was.map((o) => o.symbol));
        const kept = now.filter((o) => seen.has(o.symbol));
        if (kept.length) this.counts.confirmed++;
        this.tell(d, kept);
      }
    } catch { /* a check is never worth a failure */ } finally {
      this.running = false;
    }
  }

  private tell(d: CheckedDesk, offs: readonly PositionOff[]): void {
    const key = String(d.accountId ?? d.name);
    const sig = signature(offs);
    const last = this.told.get(key);
    const at = this.now();
    if (offs.length === 0) {
      // Agreeing is news only after a difference was said.
      if (last && last.sig !== '') { this.told.set(key, { sig: '', at }); this.o.notify(positionCheckAlert({ account: d.name, rows: [], at })); }
      return;
    }
    if (last && last.sig === sig && at - last.at < POSITION_RETELL_MS) return;
    this.told.set(key, { sig, at });
    this.counts.told++;
    this.o.notify(positionCheckAlert({ account: d.name, rows: offs, at }));
  }
}

/** The check, at every quarter hour plus `POSITION_CHECK_OFFSET_MS`. The timer does not keep the process alive. */
export function startPositionCheck(o: ConstructorParameters<typeof PositionCheck>[0]): { check: PositionCheck; stop: () => void } {
  const check = new PositionCheck(o);
  let timer: NodeJS.Timeout | null = null;
  const next = () => {
    const now = Date.now();
    const wait = POSITION_CHECK_MS - ((now - POSITION_CHECK_OFFSET_MS) % POSITION_CHECK_MS);
    timer = setTimeout(() => { void check.round().finally(next); }, wait);
    timer.unref();
  };
  next();
  return { check, stop: () => { if (timer) clearTimeout(timer); } };
}
