import type { TradeStatus } from '@/types/trade';
import type { Glance } from '@/api/glance';
import { contractLabel, pct } from '@/lib/format';
import { lossBudget, positionRisk } from '@/lib/position-risk';

/**
 * What deserves a look right now (the phone's Alerts, 6 Oct 2026), worked out from what the phone already reads:
 * each open position's risk, the day's loss limit, the margin in use, and the desk's own health. Pure and
 * read-only -- these are things to look at, not orders; Telegram stays the channel that buzzes.
 *
 * Red is something to act on now, amber something to watch, green good news. Sorted that way.
 */

export type PhoneAlert = { level: 'red' | 'amber' | 'green'; title: string; detail?: string; tradeId?: string };

/** A stop this close (share of the price) is "near". */
export const NEAR_STOP = 0.15;
/** A target this close is "nearly there". */
export const NEAR_TARGET = 0.1;
/** A liquidation level under this multiple of the price is near. */
export const NEAR_LIQUIDATION = 3;
/** A spread this wide, of the middle, makes leaving expensive. */
export const WIDE_SPREAD = 0.2;
export const MARGIN_WARN = 0.7;

const RANK = { red: 0, amber: 1, green: 2 } as const;

export function phoneAlerts(status: TradeStatus | null, glance: Glance | null, perpMark: number | null = null): PhoneAlert[] {
  const out: PhoneAlert[] = [];
  if (glance) {
    for (const i of glance.issues) out.push({ level: i.level === 'down' ? 'red' : 'amber', title: i.text });
  }
  if (status) {
    for (const t of status.open) {
      const r = positionRisk(t, { alarms: status.alarms, perpMark });
      const name = `${contractLabel(t.symbol)} ${r.long ? 'BUY' : 'SELL'}${t.account ? ` · ${t.account.name}` : ''}`;
      for (const p of r.problems) out.push({ level: 'red', title: p, detail: name, tradeId: t.tradeId });
      if (r.stop && r.stop.pct !== null && Number.isFinite(r.stop.points)) {
        if (r.stop.points <= 0) out.push({ level: 'red', title: 'Price is through the stop', detail: name, tradeId: t.tradeId });
        else if (r.stop.pct <= NEAR_STOP) out.push({ level: 'red', title: `Near the stop: ${pct(r.stop.pct, 1)} away`, detail: name, tradeId: t.tradeId });
      }
      if (r.target && r.target.pct !== null && Number.isFinite(r.target.points) && r.target.pct <= NEAR_TARGET) {
        out.push({ level: 'green', title: r.target.points <= 0 ? 'Target price reached' : `Close to the target: ${pct(r.target.pct, 1)} to go`, detail: name, tradeId: t.tradeId });
      }
      if (r.liquidation?.multiple != null && r.liquidation.multiple < NEAR_LIQUIDATION) {
        out.push({ level: 'red', title: `Liquidation at ${r.liquidation.multiple.toFixed(1)}× the price now`, detail: name, tradeId: t.tradeId });
      }
      const bid = t.live?.bid ?? null;
      const ask = t.live?.ask ?? null;
      if (bid !== null && ask !== null && ask > 0 && bid > 0) {
        const spread = (ask - bid) / ((ask + bid) / 2);
        if (spread >= WIDE_SPREAD) out.push({ level: 'amber', title: `Wide spread: ${pct(spread, 0)}`, detail: `${name} — closing costs more than the mark says`, tradeId: t.tradeId });
      }
    }
    const budget = lossBudget(status);
    if (budget && budget.usedPct >= 0.5) {
      out.push({ level: budget.usedPct >= 0.8 ? 'red' : 'amber', title: `${pct(budget.usedPct, 0)} of the daily loss limit used` });
    }
    if (status.marginUsedUsd != null && status.walletUsd != null && status.walletUsd > 0) {
      const used = status.marginUsedUsd / status.walletUsd;
      if (used >= MARGIN_WARN) out.push({ level: used >= 0.9 ? 'red' : 'amber', title: `${pct(used, 0)} of the wallet in margin` });
    }
  }
  return out.sort((a, b) => RANK[a.level] - RANK[b.level]);
}
