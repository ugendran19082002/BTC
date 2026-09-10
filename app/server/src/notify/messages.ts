import type { TradePlan, TradeRecord } from '../trading/engine.js';
import { premiumUsd } from '../trading/margin.js';
import { tradeCharges } from '../trading/charges.js';
import type { OrderRole, OrderSide, TradeEvent, TradeState } from '../trading/types.js';
import { USDINR } from '../domain/score.js';

/**
 * What a fill, and a finished day, look like on a phone.
 *
 * Pure: events and trades go in, a message or nothing comes out. No clock, no
 * network, no environment -- so every message this desk can send is pinned by a
 * test, the same way the order body sent to Delta is.
 *
 * Fills are announced, and so are the few problems somebody has to act on. A
 * submitted order, a stop placed, a gate saying no to a tapped order: none of
 * those need a phone to buzz, and a channel that buzzes for them is a channel
 * that gets muted -- which is exactly when the alert that matters goes unread.
 */

export type Alert = {
  /**
   * Alerts with the same key replace each other until one is sent. A 425-lot
   * order that fills in nine pieces is one entry on the phone, not nine.
   */
  key: string;
  /** Telegram HTML: only <b> and <i>, and every `&` written as `&amp;`. */
  text: string;
};

export type AlertContext = { mode: 'live' | 'paper' };

type FillEvent = Extract<TradeEvent, { t: 'fill' }>;

export function alertFor(
  event: TradeEvent,
  before: TradeState,
  after: TradeState,
  plan: TradePlan,
  ctx: AlertContext,
): Alert | null {
  if (event.t === 'fill') {
    return event.role === 'entry'
      ? { key: entryKey(after), text: entryText(event, after, plan, ctx) }
      : { key: exitKey(after), text: exitText(event.role, event.side, after, plan, ctx) };
  }
  // The earlier alert said "still working". Once the rest is cancelled that is
  // no longer true, and a stale alert is one that teaches you to ignore them.
  if (event.t === 'entry_cancelled' && after.entrySize > 0) {
    return { key: entryKey(after), text: entryText(null, after, plan, ctx) };
  }
  // Flat on the exchange with no exit fill of ours behind it: a stop that fired
  // while the desk was down, or a close made on Delta's own screen.
  if (event.t === 'reconciled' && before.position !== 0 && after.position === 0) {
    return { key: exitKey(after), text: reconciledText(after, plan, ctx) };
  }
  return problemAlertFor(event, before, after, plan, ctx);
}

/**
 * What went wrong with real consequences, and nothing else.
 *
 * Delta refused an order; the desk does not know whether an order exists; an
 * exit did not go through; a position is open with no stop behind it. A gate
 * refusing a hand-placed order is not here -- the screen already said so, to
 * the person who tapped. A scheduled one is reported by the run's own alert.
 */
function problemAlertFor(
  event: TradeEvent,
  before: TradeState,
  after: TradeState,
  plan: TradePlan,
  ctx: AlertContext,
): Alert | null {
  const key = `${after.tradeId}:problem`;
  const held = Math.abs(after.position);
  const side = after.position < 0 ? 'short' : 'long';

  // A scheduled entry that ran out of window. A hand-placed one was cancelled
  // by the person who placed it, and needs no message.
  if (event.t === 'entry_cancelled' && after.entrySize === 0 && plan.strategyId) {
    return { key, text: problemText(ctx, 'ℹ️', `NOT FILLED · ${contract(plan)}`, [
      'The entry window closed before the order filled, so it was cancelled. Nothing was sold.',
      'Usually the spread stayed too wide to sell at the bid.',
    ], event.at, plan) };
  }

  if (event.t === 'entry_rejected') {
    return { key, text: problemText(ctx, '🚨', `ORDER REJECTED · ${contract(plan)}`, [
      `Delta refused the order: <i>${escape(event.reason)}</i>`,
      held > 0 ? `${qty(held)} had already filled — that part is still open.` : 'Nothing was sold.',
    ], event.at, plan) };
  }
  if (event.t === 'entry_submit_unknown') {
    return { key, text: problemText(ctx, '⚠️', `ORDER STATUS UNKNOWN · ${contract(plan)}`, [
      'Delta did not answer when the order was sent.',
      'The desk reads the account back before doing anything else, so no second order is sent.',
    ], event.at, plan) };
  }
  // An exit was asked for and did not go: the position is still there.
  if (event.t === 'protection_failed' && before.phase === 'exit_pending' && held > 0) {
    return { key, text: problemText(ctx, '🚨', `EXIT FAILED · ${contract(plan)}`, [
      `Could not close: <i>${escape(event.reason)}</i>`,
      `Still ${side} <b>${qty(held)}</b>. Tap Close now again, or close it on Delta.`,
    ], event.at, plan) };
  }
  // Newly unprotected. Once per alarm, not once per retry: the protection loop
  // tries again every few seconds, and the phone only needs telling once.
  if (after.alarm && after.alarm !== before.alarm && held > 0) {
    return { key, text: problemText(ctx, '🚨', `NO STOP-LOSS · ${contract(plan)}`, [
      `<i>${escape(after.alarm)}</i>`,
      `${side === 'short' ? 'Short' : 'Long'} <b>${qty(held)}</b> with nothing protecting it. The desk keeps retrying — check Delta now.`,
    ], event.at, plan) };
  }
  return null;
}

const problemText = (ctx: AlertContext, icon: string, title: string, body: string[], at: number, plan: TradePlan) =>
  lines(headline(ctx, icon, title), '', ...body, footer(at, plan, ctx));

const entryKey = (s: TradeState) => `${s.tradeId}:entry`;
const exitKey = (s: TradeState) => `${s.tradeId}:exit`;

// -------------------------------------------------------------- the day

export type DayContext = {
  mode: 'live' | 'paper';
  /** Where the trading day began, epoch ms: 05:30 IST, when the daily contract opens. */
  dayStart: number;
  /** When the summary is written. */
  at: number;
  /**
   * BTC spot, for the fee on the notional. Null prices the fee from the premium
   * cap alone -- which is the branch that binds on options this cheap anyway.
   */
  spot: number | null;
  /** Orders still resting with no position behind them. */
  workingOrders: number;
};

/**
 * This event closed a position, and nothing is held any more.
 *
 * A strategy day closes two legs a moment apart. The first closing is not the
 * end of anything, and a summary sent then would be wrong by the second leg.
 */
export const bookWentFlat = (before: TradeState, after: TradeState, open: TradeState[]): boolean =>
  before.position !== 0 && after.position === 0 && open.every((s) => s.position === 0);

/**
 * The whole day in one message, once the last position has closed.
 *
 * Charges are Delta's fee plus 18% GST on every fill, by the formula that
 * reproduces the account statement to the last digit -- and still labelled an
 * estimate, because the exchange's statement is the only authority on what was
 * actually charged.
 */
export function daySummaryFor(trades: TradeRecord[], ctx: DayContext): Alert | null {
  const closed = trades
    .filter((r) => r.state.entrySize > 0 && r.state.position === 0 && r.state.updatedAt >= ctx.dayStart)
    .sort((a, b) => openedAt(a.state) - openedAt(b.state));
  if (closed.length === 0) return null;

  const rows = closed.map((r) => ({
    rec: r,
    collected: premiumUsd(r.state.entryAvgPrice ?? 0, r.state.entrySize, r.state.contractValue),
    // A position closed on Delta with no exit fill of ours has no price to
    // count from. Its P&L is unknown, which is not the same as zero.
    known: r.state.exitSize > 0,
    gross: r.state.realisedPnl,
    charges: feesUsd(r.state, r.plan, ctx.spot),
  }));
  const counted = rows.filter((x) => x.known);
  const total = (pick: (x: (typeof rows)[number]) => number, of = rows) => of.reduce((n, x) => n + pick(x), 0);

  const collected = total((x) => x.collected);
  const gross = total((x) => x.gross, counted);
  const charges = total((x) => x.charges);
  const net = gross - charges;
  const won = counted.filter((x) => rupees(x.gross) > 0).length;
  const lost = counted.filter((x) => rupees(x.gross) < 0).length;
  const even = counted.length - won - lost;
  const unknown = rows.length - counted.length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return {
    key: `day:${istDateKey(ctx.dayStart)}`,
    text: lines(
      headline(ctx, '📊', `DAY SUMMARY · ${istLongDate(ctx.dayStart)}`),
      `✔️ All positions closed · ${ctx.mode === 'live' ? 'LIVE' : 'PAPER — simulated'}`,
      '',
      `Trades: <b>${closed.length}</b> · ✅ ${won} won · 🔻 ${lost} lost${even ? ` · ${even} even` : ''}`,
      `Premium collected: <b>${inr(collected)}</b> (${usd(collected)})`,
      '',
      `Gross P&amp;L: ${signedMoney(gross, true)}`,
      `Charges (est.): ${charges > 0 ? '-' : ''}${inr(charges)} (${charges > 0 ? '-' : ''}${usd(charges)})`,
      `${pnlIcon(net)} <b>Net P&amp;L: ${signedMoney(net, false)}</b>`,
      gross > 0 && collected > 0 ? `Kept ${percent(gross / collected)} of the premium` : null,
      unknown > 0 ? `⚠️ ${plural(unknown, 'trade')} closed on Delta without a fill — not in the P&amp;L totals` : null,
      '',
      '<b>Trades</b>',
      ...rows.map(tradeLine),
      ctx.workingOrders > 0 ? `\n⏳ ${plural(ctx.workingOrders, 'order')} still working, no position yet` : null,
      '',
      `🕒 ${istTime(ctx.at)} IST · charges are estimates; Delta's statement is final`,
    ),
  };
}

function tradeLine(x: { rec: TradeRecord; known: boolean; gross: number }): string {
  const s = x.rec.state;
  const how = s.exitWinner === 'take_profit' ? '✅'
    : s.exitWinner === 'stop_loss' ? '🛑'
      : s.exitWinner === 'manual' ? '⏹'
        : '⌛';
  const out = s.exitAvgPrice === null ? 'closed on Delta' : price(s.exitAvgPrice);
  const result = x.known ? `${sign(rupees(x.gross))}${inr(x.gross)}` : 'P&amp;L unknown';
  return `${how} ${contract(x.rec.plan)} · ${qty(s.entrySize)} @ ${price(s.entryAvgPrice ?? 0)} → ${out} · ${result}`;
}

const openedAt = (s: TradeState) => s.fills.find((f) => f.role === 'entry')?.ts ?? s.updatedAt;

/** Delta's fee and GST on every fill -- the same formula as the statement. */
const feesUsd = (s: TradeState, _plan: TradePlan, spot: number | null): number => tradeCharges(s, { spot }).totalUsd;

// -------------------------------------------------------------- the fills

function entryText(e: FillEvent | null, s: TradeState, plan: TradePlan, ctx: AlertContext): string {
  const side = e?.side ?? s.fills.find((f) => f.role === 'entry')?.side ?? 'sell';
  const avg = s.entryAvgPrice ?? e?.price ?? 0;
  const pieces = s.fills.filter((f) => f.role === 'entry').length;
  const wanted = Math.max(s.requestedSize, s.entrySize);
  const credit = premiumUsd(avg, s.entrySize, s.contractValue);

  return lines(
    headline(ctx, side === 'sell' ? '🟢' : '🔵', `${side === 'sell' ? 'SOLD' : 'BOUGHT'} ${contract(plan)}`),
    expiry(plan),
    '',
    `Filled <b>${qty(s.entrySize)}</b> of ${qty(wanted)} @ <b>${price(avg)}</b>${pieces > 1 ? ' avg' : ''}`,
    s.entrySize >= wanted ? null
      : e === null ? `✖️ The other ${qty(wanted - s.entrySize)} were cancelled`
        : '⏳ The rest of the order is still working',
    `Premium ${side === 'sell' ? 'collected' : 'paid'}: <b>${inr(credit)}</b> (${usd(credit)})`,
    '',
    exits(plan),
    footer(s.updatedAt, plan, ctx),
  );
}

function exitText(
  role: Exclude<OrderRole, 'entry'>,
  side: OrderSide,
  s: TradeState,
  plan: TradePlan,
  ctx: AlertContext,
): string {
  const [icon, title] = role === 'take_profit' ? ['✅', 'TARGET HIT']
    : role === 'stop_loss' ? ['🛑', 'STOP-LOSS HIT']
      // Deliberately not "closed by strategy" or "closed by you": the desk's
      // own target watch closes at market too, and a title that guesses the
      // reason is a title that is sometimes wrong.
      : ['⏹', 'CLOSED AT MARKET'];

  return lines(
    headline(ctx, icon, `${title} · ${contract(plan)}`),
    expiry(plan),
    '',
    `${side === 'buy' ? 'Bought back' : 'Sold back'} <b>${qty(s.exitSize)}</b> @ <b>${price(s.exitAvgPrice ?? 0)}</b>`
      + `  (entry ${price(s.entryAvgPrice ?? 0)})`,
    pnlLine(s.realisedPnl),
    s.position === 0
      ? '✔️ Position is <b>flat</b>'
      : `⏳ Still ${s.position < 0 ? 'short' : 'long'} <b>${qty(Math.abs(s.position))}</b> — exit working`,
    footer(s.updatedAt, plan, ctx),
  );
}

function reconciledText(s: TradeState, plan: TradePlan, ctx: AlertContext): string {
  return lines(
    headline(ctx, '⏹', `POSITION CLOSED · ${contract(plan)}`),
    expiry(plan),
    '',
    'Delta shows no position. It was closed outside the desk — a stop that fired while the desk was offline, or a close on Delta itself.',
    s.exitSize > 0
      ? pnlLine(s.realisedPnl)
      : 'P&amp;L could not be counted from fills — check Delta for the closing price.',
    footer(s.updatedAt, plan, ctx),
  );
}

// ------------------------------------------------------------------- pieces

const lines = (...ls: (string | null)[]) => ls.filter((l) => l !== null).join('\n');

function headline(ctx: { mode: 'live' | 'paper' }, icon: string, title: string): string {
  // A paper fill must never be mistakable for a real one, even from the lock
  // screen, where only the first line shows.
  return ctx.mode === 'paper' ? `🧪 <b>PAPER</b> · ${icon} <b>${title}</b>` : `${icon} <b>${title}</b>`;
}

const contract = (plan: TradePlan) =>
  `${escape(plan.expect.underlying)} ${plan.expect.strike.toLocaleString('en-US')} ${plan.optionSide}`;

const expiry = (plan: TradePlan) => `<i>Expiry ${istDate(plan.expect.expiryTs * 1_000)}</i>`;

function exits(plan: TradePlan): string {
  const target = plan.takeProfitPrice === null ? 'No target' : `🎯 Target ${price(plan.takeProfitPrice)}`;
  // Same rule as the engine's alarm: running without a stop is allowed, but it
  // is said out loud every time rather than left for someone to notice.
  const stop = plan.stopPrice === null ? '⚠️ <b>No stop-loss</b>' : `🛑 Stop ${price(plan.stopPrice)}`;
  return `${target}   ${stop}`;
}

function footer(at: number, plan: TradePlan, ctx: AlertContext): string {
  const origin = plan.strategyId ? 'strategy' : 'manual';
  const mode = ctx.mode === 'live' ? 'LIVE' : 'PAPER — simulated, no real order';
  return `🕒 ${istTime(at)} IST · ${origin} · ${mode}`;
}

const pnlLine = (usdPnl: number) => `${pnlIcon(usdPnl)} P&amp;L: ${signedMoney(usdPnl, true)}`;

const pnlIcon = (usdPnl: number) => (rupees(usdPnl) > 0 ? '🟢' : rupees(usdPnl) < 0 ? '🔴' : '⚪');

function signedMoney(usdAmount: number, boldRupees: boolean): string {
  const s = sign(rupees(usdAmount));
  const r = `${s}${inr(usdAmount)}`;
  return `${boldRupees ? `<b>${r}</b>` : r} (${s}${usd(usdAmount)})`;
}

// ---------------------------------------------------------- auto-trading

export type RunOutcome = {
  strategy: string;
  status: 'placed' | 'failed' | 'refused' | 'skipped';
  /** The run's own words: which legs, or why none. */
  detail: string;
  /** Legs that could not be placed, each with its reason. */
  failedLegs: string[];
  at: number;
};

/**
 * What an automatic run did, when it needs saying.
 *
 * A run that placed everything is announced by its fills, so it sends nothing
 * here. One that failed, went on one-sided, or stood aside is told -- the last
 * because a silent phone cannot tell "stood aside" from "was not running".
 */
export function runAlertFor(r: RunOutcome, ctx: AlertContext): Alert | null {
  const key = `run:${r.strategy}:${istDateKey(r.at)}`;
  const foot = `🕒 ${istTime(r.at)} IST · auto-trading · ${ctx.mode === 'live' ? 'LIVE' : 'PAPER'}`;
  const legs = r.failedLegs.map((f) => `• ${escape(f)}`);
  if (r.status === 'failed') {
    return { key, text: lines(
      headline(ctx, '🚨', `AUTO-TRADE FAILED · ${escape(r.strategy)}`), '',
      'No order could be placed, so nothing was sold today.', ...legs, '', foot,
    ) };
  }
  if (r.status === 'placed' && legs.length > 0) {
    return { key, text: lines(
      headline(ctx, '⚠️', `AUTO-TRADE PARTLY PLACED · ${escape(r.strategy)}`), '',
      'Some legs went on and some did not:', ...legs, 'The legs that went on are kept.', '', foot,
    ) };
  }
  if (r.status === 'refused' || r.status === 'skipped') {
    return { key, text: lines(
      headline(ctx, 'ℹ️', `STOOD ASIDE TODAY · ${escape(r.strategy)}`), '',
      escape(r.detail), 'No order was placed.', '', foot,
    ) };
  }
  return null;
}

/** The entry window closed with nothing tried: the desk or the price feed was down the whole time. */
export function missedEntryAlert(
  strategy: string, entryTime: string, graceMin: number, at: number, ctx: AlertContext,
): Alert {
  return {
    key: `missed:${strategy}:${istDateKey(at)}`,
    text: lines(
      headline(ctx, '🚨', `ENTRY MISSED · ${escape(strategy)}`), '',
      `Nothing was entered between ${escape(entryTime)} and ${graceMin} minutes after it.`,
      'The desk could not read a live board in that time — it was not running, or Delta’s price feed was down. No order was placed today.',
      '',
      `🕒 ${istTime(at)} IST · auto-trading · ${ctx.mode === 'live' ? 'LIVE' : 'PAPER'}`,
    ),
  };
}

// -------------------------------------------------------------- formatting

/** Quoted option prices: at least one decimal, at most two, as Delta shows them. */
const price = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const qty = (n: number) => n.toLocaleString('en-US');

/** Rupees to the paisa, signed -- the one number every sign and icon is decided from. */
const rupees = (usdAmount: number) => Math.round(usdAmount * USDINR * 100) / 100;

/**
 * Rupees main, dollars small, at the desk's own rate -- the same as the screen.
 * Whole rupees once there are enough of them; paise only when the amount is
 * small enough that rounding would hide it.
 */
function inr(usdAmount: number): string {
  const r = Math.abs(rupees(usdAmount));
  const digits = r < 10 ? 2 : 0;
  return `₹${r.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const usd = (usdAmount: number) => `$${Math.abs(usdAmount).toFixed(2)}`;
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '');
const percent = (f: number) => `${(f * 100).toFixed(f * 100 < 10 ? 1 : 0)}%`;

/*
 * India time by arithmetic rather than Intl. IST has no daylight saving, so the
 * offset is a constant -- and Intl's short month for September is "Sep" or
 * "Sept" depending on the locale data the image ships, which is not something a
 * message format should quietly change with.
 */
const IST_OFFSET_MS = 5.5 * 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ist = (ms: number) => new Date(ms + IST_OFFSET_MS);
const pad = (n: number) => String(n).padStart(2, '0');

const istTime = (ms: number) => { const d = ist(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const istDate = (ms: number) => { const d = ist(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const istLongDate = (ms: number) => {
  const d = ist(ms);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const istDateKey = (ms: number) => {
  const d = ist(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
