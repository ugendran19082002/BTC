import type { Trade } from '@/types/trade';
import type { JournalEvent } from '@/api/phone';
import { price } from '@/lib/format';

/**
 * A trade's journal as a person reads it (the phone's trade detail, 6 Oct 2026): the signal that started it,
 * then every step the desk and the exchange took, in order, each in a sentence -- signal, entry, fill,
 * protection, exit, closed. Pure, from the journal the server replays (decision 0009), so the story on the
 * screen is the one the desk itself acted on.
 */

export type Stage = 'signal' | 'entry' | 'fill' | 'protection' | 'exit' | 'closed' | 'problem' | 'info';

export type Step = { at: number; stage: Stage; title: string; detail?: string };

const ROLE: Record<string, string> = { take_profit: 'Target', stop_loss: 'Stop', exit: 'Close', manual: 'Close by hand', entry: 'Entry' };
const roleOf = (r: unknown) => ROLE[String(r)] ?? String(r);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const qty = (v: unknown) => (n(v) === null ? '?' : Math.abs(n(v)!).toLocaleString('en-US'));
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function stepOf(e: JournalEvent): Step {
  const at = e.at;
  switch (e.t) {
    case 'precheck_failed':
      return { at, stage: 'problem', title: 'Refused by the desk\'s checks before sending', detail: str(e.reason) ?? undefined };
    case 'entry_submitted': {
      const q = e.quote as { bid?: number | null; ask?: number | null } | undefined;
      const limit = n(e.limitPrice);
      return {
        at, stage: 'entry',
        title: `Entry order sent: ${qty(e.size)} contracts${limit !== null ? ` at ${price(limit)}` : ' at market'}`,
        detail: q && (q.bid != null || q.ask != null) ? `Book then: bid ${price(q.bid)} · ask ${price(q.ask)}` : undefined,
      };
    }
    case 'entry_submit_unknown':
      return { at, stage: 'problem', title: 'Entry sent, but the exchange\'s answer was lost', detail: 'The desk asks the exchange what happened before doing anything else.' };
    case 'entry_rejected':
      return { at, stage: 'problem', title: 'The exchange rejected the entry', detail: str(e.reason) ?? undefined };
    case 'fill': {
      const entry = e.role === 'entry';
      const perp = n(e.perp);
      return {
        at, stage: entry ? 'fill' : 'exit',
        title: entry
          ? `${e.side === 'buy' ? 'Bought' : 'Sold'} ${qty(e.size)} @ ${price(n(e.price))}`
          : `${roleOf(e.role)} filled: ${e.side === 'buy' ? 'bought back' : 'sold'} ${qty(e.size)} @ ${price(n(e.price))}`,
        detail: perp !== null ? `BTC perp at ${Math.round(perp).toLocaleString('en-US')}` : undefined,
      };
    }
    case 'entry_timeout':
      return { at, stage: 'info', title: 'The entry\'s wait ran out' };
    case 'entry_cancelled':
      return { at, stage: 'info', title: `The rest of the entry was cancelled: ${qty(e.remaining)} not filled` };
    case 'protection_placed': {
      const both = [e.takeProfit ? 'target' : null, e.stopLoss ? 'stop' : null].filter(Boolean).join(' and ');
      return { at, stage: 'protection', title: both ? `${both[0]!.toUpperCase()}${both.slice(1)} placed at the exchange` : 'Exits checked at the exchange', detail: n(e.size) !== null ? `Covering ${qty(e.size)} contracts` : undefined };
    }
    case 'protection_failed':
      return { at, stage: 'problem', title: 'The exchange would not take the exits', detail: str(e.reason) ?? undefined };
    case 'exit_submitted':
      return { at, stage: 'exit', title: `${roleOf(e.role)} order sent`, detail: str(e.reason) ?? undefined };
    case 'sibling_cancelled':
      return { at, stage: 'info', title: `The other exit (${roleOf(e.role).toLowerCase()}) was cancelled`, detail: 'So it cannot reopen the position.' };
    case 'reconciled':
      return { at, stage: 'info', title: `Checked with the exchange: ${n(e.position) === 0 ? 'no position' : `position ${n(e.position)}`}`, detail: str(e.note) ?? undefined };
    case 'add_submitted':
      return { at, stage: 'entry', title: 'An add to the position was sent' };
    case 'add_done':
      return { at, stage: 'info', title: `The add finished: ${qty(e.filled)} filled`, detail: str(e.reason) ?? undefined };
    case 'aborted':
      return { at, stage: 'problem', title: 'The trade was stopped', detail: str(e.reason) ?? undefined };
    default:
      return { at, stage: 'info', title: e.t.replace(/_/g, ' ') };
  }
}

export function journalSteps(trade: Trade, events: readonly JournalEvent[]): Step[] {
  const steps: Step[] = [];
  const sig = trade.plan?.signal;
  if (sig) {
    steps.push({
      at: sig.triggerTime,
      stage: 'signal',
      title: `Signal: #${sig.n} ${sig.name}`,
      detail: `${sig.dir === 1 ? 'BUY' : 'SELL'} · ${sig.tf} · ${sig.mode === 'mtf' ? 'with the timeframe chain' : 'without it'}`,
    });
  } else if (trade.plan?.strategyName) {
    steps.push({ at: events[0]?.at ?? trade.updatedAt, stage: 'signal', title: `Placed by strategy “${trade.plan.strategyName}”` });
  }
  for (const e of [...events].sort((a, b) => a.at - b.at)) steps.push(stepOf(e));
  const closed = trade.position === 0 && trade.exitSize > 0;
  if (closed) {
    const last = steps.length ? steps[steps.length - 1]!.at : trade.updatedAt;
    steps.push({ at: Math.max(last, trade.updatedAt), stage: 'closed', title: 'Closed', detail: trade.exitReason ?? undefined });
  }
  return steps;
}
