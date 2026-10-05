import { canMakeForAccount } from '@/lib/account-scope';
import { useEffect, useRef, useState } from 'react';
import { FoldButton, useFold } from '@/components/ui/fold';
import { AlertTriangle, Bot, CheckCircle2, Copy, Loader2, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { cloneStrategy, deleteStrategy, getStrategies, saveStrategy, setScheduler, setSignalMaxOpen, setStrategyEnabled } from '@/api/strategy';
import { MAX_GLOBAL_OPEN, MAX_SIGNAL_OPEN, ruleTfWords, type Strategy, type StrategyStatus } from '@/types/strategy';
import { usePoll } from '@/hooks/usePoll';
import { Button } from '@/components/ui/button';
import { SignalStrategyForm } from '@/components/strategy/SignalStrategyForm';
import { SignalTradeHistory } from '@/components/strategy/SignalTradeHistory';
import { describeStrike, signalTargetLabel } from '@/lib/strategy-preview';
import { time12 } from '@/lib/time';
import { blockNow, hoursLabel, istMinuteOf, pickWords } from '@/lib/strategy-blocks';
import { buyCostPerLotUsd, buyTotals, globalMaxOpenProblem, marginPerLotUsd, roomLeft, signalTotals, usageNow, usageOf, type Usage } from '@/lib/strategy-totals';
import { inr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The signal strategies, on the Live screen beside the methods that make the
 * signals: each one's switch, its live-orders switch, what it is set to, and
 * what the last signals did. New and Edit open the same form as the Strategy
 * tab, already on signals -- one strategy, two places to reach it.
 */


/**
 * The strike rule in force this minute (4 Oct 2026). A strategy split by time
 * of day sells under a different rule in each block, and the line above names
 * only the first; this says which block the clock is in, until when, the rule a
 * signal arriving now is sold under, and what follows it. The card is read
 * again every few seconds, so it moves with the clock.
 */
function RuleNow({ s }: { s: Strategy }) {
  const b = blockNow(s.config, istMinuteOf(Date.now()));
  if (!b) {
    return (
      <p aria-label={`strike rule now of ${s.name}`} className="m-0 mt-1 text-[11.5px] text-[var(--dim)]">
        Outside its window now — the next signal is taken from {time12(s.config.entryTime)}.
      </p>
    );
  }
  return (
    <p aria-label={`strike rule now of ${s.name}`} className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted-foreground">
      <span className="rounded bg-[var(--accent)]/15 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-foreground">Now</span>
      {b.of > 1
        ? <span><b className="text-foreground">Block {b.n} of {b.of}</b> · {time12(b.from)} → {time12(b.until)} · {hoursLabel(b.minutesLeft)} left</span>
        : <span><b className="text-foreground">Same rule all the time</b></span>}
      <span>{s.config.signal?.action === 'buy' ? 'buys' : 'sells'} <b className="text-foreground">{pickWords(b.pick)}</b></span>
      {b.next && <span className="text-[var(--dim)]">· then block {b.next.n} at {time12(b.next.at)}: {pickWords(b.next.pick)}</span>}
    </p>
  );
}

type Tone = 'accent' | 'good' | 'warning' | 'danger';
type Status = { tone: Exclude<Tone, 'accent'>; word: string };
/** Each tone's fill, and its track: a faint step of the same colour, so the state reads across the whole bar. */
const TONE: Record<Tone, { fill: string; track: string }> = {
  accent: { fill: 'var(--accent)', track: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
  good: { fill: 'var(--up)', track: 'color-mix(in srgb, var(--up) 18%, transparent)' },
  warning: { fill: 'var(--warn)', track: 'color-mix(in srgb, var(--warn) 20%, transparent)' },
  danger: { fill: 'var(--down)', track: 'color-mix(in srgb, var(--down) 20%, transparent)' },
};
const STATUS_ICON = { good: CheckCircle2, warning: AlertTriangle, danger: XCircle } as const;

/**
 * One figure of the summary: what it is, the number, and what stands behind it
 * -- with a bar where the number is a share of something, and a word and an
 * icon where it has a state. The number is in the text's own colour; the bar
 * and the icon carry the state, so nothing is said by colour alone.
 */
function Tile({ label, name, value, status, meter, children }: {
  label: string;
  /** The tile's accessible name. */
  name: string;
  value: React.ReactNode;
  status?: Status | null;
  meter?: { label: string; now: number; max: number; tone: Tone };
  children?: React.ReactNode;
}) {
  const Icon = status ? STATUS_ICON[status.tone] : null;
  const share = meter && meter.max > 0 ? Math.min(1, Math.max(0, meter.now / meter.max)) : 0;
  return (
    <div aria-label={name} className="min-w-0 rounded-lg border border-solid border-border bg-muted px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">{label}</span>
        {status && Icon && (
          <span className="inline-flex flex-none items-center gap-1 text-[11px] font-medium text-foreground">
            <Icon className="h-3.5 w-3.5" style={{ color: TONE[status.tone].fill }} aria-hidden />
            {status.word}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[15px] font-semibold leading-snug tabular-nums text-foreground">{value}</div>
      {meter && (
        <div role="progressbar" aria-label={meter.label} aria-valuemin={0} aria-valuemax={meter.max} aria-valuenow={meter.now}
             className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: TONE[meter.tone].track }}>
          <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: TONE[meter.tone].fill }} />
        </div>
      )}
      {children && <div className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] leading-snug text-muted-foreground">{children}</div>}
    </div>
  );
}

/**
 * One strategy's own limit and how much of it is in use now (4 Oct 2026): its
 * entries, its lots and the margin behind them, each "in use of limit", with a
 * bar for the entries. The limit is what the strategy may take; in use is what
 * the desk holds for it this moment -- positions and working orders.
 */
function UsageLine({ name, u, buyCostPerLotUsd: costPerLot }: { name: string; u: Usage; buyCostPerLotUsd?: number | null }) {
  // A bought strategy uses no margin: its figure is what the premium costs, at its own premium number.
  const bought = costPerLot !== undefined;
  const share = u.maxEntries > 0 ? Math.min(1, u.entries / u.maxEntries) : 0;
  const full = u.maxEntries > 0 && u.entries >= u.maxEntries;
  return (
    <div aria-label={`usage of ${name}`} className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[var(--dim)]">Open now</span>
        <b className={cn('tabular-nums', full ? 'text-[var(--warn)]' : 'text-foreground')}>{u.entries} of {u.maxEntries}</b>
        <span role="progressbar" aria-label={`${name} entries in use`} aria-valuemin={0} aria-valuemax={u.maxEntries} aria-valuenow={u.entries}
              className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <span className={cn('block h-full rounded-full', full ? 'bg-[var(--warn)]' : 'bg-[var(--up)]')} style={{ width: `${share * 100}%` }} />
        </span>
      </span>
      <span><span className="text-[var(--dim)]">Lots in use</span> <b className="tabular-nums text-foreground">{u.lots} of {u.maxLots}</b></span>
      {bought
        ? <span><span className="text-[var(--dim)]">Premium, at most</span> <b className="tabular-nums text-foreground">{costPerLot === null ? 'set by the strike' : `${inr(usdToInr(u.lots * costPerLot))} of ${inr(usdToInr(u.maxLots * costPerLot))}`}</b></span>
        : <span><span className="text-[var(--dim)]">Margin in use</span> <b className="tabular-nums text-foreground">{inr(usdToInr(u.marginUsd))} of {inr(usdToInr(u.maxMarginUsd))}</b></span>}
      {full && <span className="text-[var(--warn)]">at its limit: the next signal is skipped</span>}
    </div>
  );
}

/**
 * The desk-wide "at most open at once" (4 Oct 2026).
 *
 * Each strategy has its own limit, and five strategies each allowed ten is
 * fifty positions on an account whose margin carries a handful: the order that
 * does not fit is refused by Delta, and that is a penalty. So one number over
 * all of them, counted against every open position and working order the desk
 * holds; a signal past it is skipped and the history says so. 0 is no limit.
 *
 * Typed, and saved when the field is left or Enter is pressed -- it sits in a
 * header, where a Save button of its own would be one more thing to miss.
 */
function GlobalMaxOpen({ value, allowed, openNow, busy, onSave, onInvalid }: {
  value: number;
  /** What the strategies switched on allow between them: the sum of their own limits. */
  allowed: number;
  openNow: number; busy: boolean; onSave: (n: number) => Promise<boolean>; onInvalid: (message: string) => void;
}) {
  /*
   * With no limit set, the field shows what the strategies allow between them:
   * that is the limit in force, and the number a lower one is typed against.
   * Typing that sum back is "no extra limit" again (saved as 0), so it goes on
   * following the strategies as they change.
   */
  const shown = value > 0 ? value : allowed;
  const full = value > 0 && openNow >= value;
  return (
    <label
      className="desk-badge-pill inline-flex items-center gap-1.5"
      title="One limit over every strategy: a signal is not taken while the desk already holds this many open trades -- positions and working orders, whichever strategy opened them. Each strategy's own limit still applies. It starts at what the strategies allow between them, and cannot be set above that."
      style={full
        ? { background: 'rgba(250, 204, 21, 0.1)', color: '#facc15', border: '1px solid rgba(250, 204, 21, 0.3)' }
        : { background: 'rgba(255, 255, 255, 0.05)', color: '#cbd5e1', border: '1px solid #1e293b' }}
    >
      <span>At most open</span>
      <NumberCommit
        label="At most open at once, all strategies"
        value={shown}
        busy={busy}
        problem={(n) => globalMaxOpenProblem(n, allowed, MAX_GLOBAL_OPEN)}
        onInvalid={onInvalid}
        onSave={(n) => { const next = allowed > 0 && n === allowed ? 0 : n; return next !== value ? onSave(next) : Promise.resolve(true); }}
        className="h-6 w-11"
      />
      <span aria-label="open now, of the limit">
        {value > 0 ? `${openNow} of ${value} open` : allowed > 0 ? `all the strategies allow · ${openNow} open` : `no limit · ${openNow} open`}
      </span>
    </label>
  );
}

/**
 * A whole number typed in place and saved when the field is left or Enter is
 * pressed -- for the numbers that sit on a card, where opening a form to change
 * one is a detour and a Save button of its own would be one more thing to miss.
 *
 * Digits only. A number the rule refuses is said (`onInvalid`, in the rule's own
 * words) and put back, never sent; an unchanged one is not sent either; one the
 * server refuses goes back to what is saved, so the field never shows a number
 * the desk is not using. It follows the server's number, but not while it is
 * being typed into.
 */
function NumberCommit({ label, value, busy, problem, onSave, onInvalid, className }: {
  /** Read by screen readers, and what a test finds it by. */
  label: string;
  value: number;
  busy?: boolean;
  /** Why this number cannot be saved, or null. */
  problem: (n: number) => string | null;
  /** Saves it; answers whether it was taken. */
  onSave: (n: number) => Promise<boolean>;
  onInvalid: (message: string) => void;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const typing = useRef(false);
  useEffect(() => { if (!typing.current) setText(String(value)); }, [value]);
  const commit = () => {
    typing.current = false;
    const n = text.trim() === '' ? NaN : Number(text);
    const bad = problem(n);
    if (bad) { onInvalid(bad); setText(String(value)); return; }
    if (n !== value) void onSave(n).then((taken) => { if (!taken) setText(String(value)); });
  };
  return (
    <input
      aria-label={label}
      inputMode="numeric"
      value={text}
      disabled={busy}
      onFocus={() => { typing.current = true; }}
      onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={cn('m-0 rounded border border-solid border-border bg-[var(--bg,#0a0e17)] px-1 text-center font-[inherit] text-[12px] tabular-nums text-foreground disabled:opacity-50', className)}
    />
  );
}

/** One line: the methods and way, the leg rule, the strike, lots, exits. */
export function signalLine(s: Strategy): string {
  const c = s.config;
  const r = c.signal;
  if (!r) return '';
  return [
    `${r.methods.length} method${r.methods.length === 1 ? '' : 's'} ${ruleTfWords(r)}`,
    // Sold: a BUY signal sells the put. Bought: it buys the call.
    c.signal?.action === 'buy' ? 'bought: BUY → CE · SELL → PE' : 'BUY → PE · SELL → CE',
    describeStrike(c).split(' — ')[0]!,
    `${c.lots} lot${c.lots === 1 ? '' : 's'}`,
    `perp SL / ${signalTargetLabel(r.target)}`,
    `max ${r.maxOpen} open`,
    `${time12(c.entryTime)} → ${time12(c.exitTime)}`,
  ].join(' · ');
}

export function SignalStrategiesCard() {
  const { data, refresh } = usePoll<StrategyStatus>(getStrategies, 5_000);
  const [open, setOpen] = useFold('signal-strategies');
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Real orders need a second tap: a switch that sends money to the exchange should not flip on a brush.
  const [confirmLive, setConfirmLive] = useState<string | null>(null);
  // Deleting needs a second tap too: it cannot be undone.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /** Do it, read the list again, and say whether it was taken: a field that was refused goes back to what is saved. */
  const act = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setFailed(null);
    try {
      await fn();
      refresh();
      return true;
    } catch (e) {
      setFailed((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const setLive = (s: Strategy, on: boolean) => {
    if (on && confirmLive !== s.id) {
      setConfirmLive(s.id);
      setTimeout(() => setConfirmLive((cur) => (cur === s.id ? null : cur)), 4_000);
      return;
    }
    setConfirmLive(null);
    void act(`live-${s.id}`, () => saveStrategy({ id: s.id, name: s.name, config: { ...s.config, liveOrders: on } }));
  };

  const mine = data?.strategies.filter((s) => s.config.trigger === 'signal') ?? [];
  // The switched-on strategies added up, and the worst case under the desk-wide limit.
  /*
   * The margin figures are a seller's: a short option needs margin, and the desk's limit is on lots short. A
   * bought option uses no margin -- it is paid for in full -- so BUY strategies are left out of them and said
   * beside them, rather than shown as short lots they will never hold.
   */
  const sellers = mine.filter((s) => s.config.signal?.action !== 'buy');
  const totals = signalTotals(sellers, data?.balanceUsd ?? null, data?.spot ?? null);
  // "At most open" is over every strategy of the account, bought and sold: what they allow between them is the sum of all.
  const allowedAll = signalTotals(mine, null, null).entries;
  const cap = data?.signalMaxOpen ?? 0;
  const capRoom = cap > 0 ? Math.max(0, cap - (data?.openNow ?? 0)) : null;
  const buys = buyTotals(mine, capRoom);
  const inUse = usageNow(sellers, data?.spot ?? null);
  // What can still open from here, at worst, and whether the free margin carries it.
  /*
   * Held to everything that can stop an entry: each strategy's own limit, the
   * desk-wide limit on open trades, and the desk's limit on lots short -- the
   * order gate's, which refused an entry on 4 Oct 2026 that this line had
   * called room. And priced at the dearer of the 200x model and what Delta is
   * charging per lot now.
   */
  const shortCap = data?.shortCap ?? null;
  const shortNow = data?.shortNow ?? 0;
  const lotsLeft = shortCap === null ? null : Math.max(0, shortCap - shortNow);
  const perLotUsd = marginPerLotUsd(data?.spot ?? null, data?.marginUsedUsd, shortNow);
  const room = roomLeft(sellers, cap, data?.openNow ?? 0, data?.spot ?? null, { lotsLeft, perLotUsd });
  const deltaMarginUsd = data?.marginUsedUsd ?? null;
  /*
   * "In use" is measured against what can actually be open: the desk-wide limit
   * where it is the tighter one, the strategies' own sum where it is not. Under a
   * limit of 28, "6 of 55" reads as nearly empty on a desk that is 6 of 28 full
   * -- so the entries are the desk's open trades of the limit, as the pill above
   * says them, and the lots and margin are what is held of what is held plus
   * what can still open.
   */
  const limited = cap > 0 && cap < allowedAll;
  const usedEntries = limited ? (data?.openNow ?? 0) : inUse.entries;
  const mostEntries = limited ? cap : totals.entries;
  const freeUsd = data?.balanceUsd ?? null;
  const short = freeUsd !== null && room.marginUsd > freeUsd;
  // How what is still to open sits against what is free: said in a word and an icon, never by colour alone.
  const fit: Status = short ? { tone: 'danger', word: 'More than is free' }
    : freeUsd !== null && freeUsd > 0 && room.marginUsd > freeUsd * 0.8 ? { tone: 'warning', word: 'Tight' }
      : { tone: 'good', word: 'Fits in the free margin' };

  return (
    <section className="live-signal-strategies fold-host mt-3 rounded-xl border border-solid border-border bg-[var(--panel)] p-3" data-folded={!open} aria-label="Signal strategies">
      <div className="desk-section-header fold-head !mt-0">
        <div className="desk-section-title-wrap">
          <FoldButton open={open} onToggle={() => setOpen(!open)} label="signal strategies" />
          <div className="desk-section-icon" style={{ background: 'rgba(250, 204, 21, 0.12)', color: '#facc15' }}>
            <Bot size={18} />
          </div>
          <div>
            <h2 className="desk-section-title">Signal Strategies</h2>
            <span className="desk-section-subtitle">The methods&apos; signals as options · sold: BUY sells PE, SELL sells CE · bought: BUY buys CE, SELL buys PE · SL / TGT on the BTC perp</span>
          </div>
        </div>
        <div className="desk-section-badges">
          {/* The desk's one number over all of them, left of the switch it works beside. */}
          {data && data.signalMaxOpen !== undefined && (
            <GlobalMaxOpen
              value={data.signalMaxOpen}
              allowed={allowedAll}
              openNow={data.openNow ?? 0}
              busy={busy === 'max-open'}
              onSave={(n) => act('max-open', () => setSignalMaxOpen(n))}
              onInvalid={setFailed}
            />
          )}
          {data && (
            <span className="desk-badge-pill"
                  style={data.schedulerOn
                    ? { background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e', border: '1px solid rgba(34, 197, 94, 0.3)' }
                    : { background: 'rgba(255, 255, 255, 0.05)', color: '#94a3b8', border: '1px solid #1e293b' }}>
              Auto-trading {data.schedulerOn ? 'on' : 'off'}
            </span>
          )}
          {/* The master switch itself, beside what it says: it sat on the time-of-day strategies' panel until that went. */}
          {data && (
            <Button
              size="sm" variant={data.schedulerOn ? 'outline' : 'default'} className="h-8"
              aria-label={data.schedulerOn ? 'Turn auto-trading off' : 'Turn auto-trading on'}
              title={data.schedulerOn ? 'No signal is taken while this is off. Open trades keep their exits.' : 'Signals are taken again, by every strategy switched on.'}
              disabled={busy === 'sched'}
              onClick={() => void act('sched', () => setScheduler(!data.schedulerOn))}
            >
              {busy === 'sched' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {data.schedulerOn ? 'Turn off' : 'Turn on'}
            </Button>
          )}
          {data && (
            <span className="desk-badge-pill"
                  style={data.mode === 'live'
                    ? { background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' }
                    : { background: 'rgba(250, 204, 21, 0.1)', color: '#facc15', border: '1px solid rgba(250, 204, 21, 0.3)' }}>
              {data.mode === 'live' ? 'LIVE' : 'PAPER'}
            </span>
          )}
          {/* A strategy belongs to one broker account, so it is made on that account's tab, never on "All accounts". */}
          <Button size="sm" disabled={!canMakeForAccount()}
                  title={canMakeForAccount() ? undefined : 'Choose an account tab first: a strategy belongs to one account'}
                  onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="h-3.5 w-3.5" /> New signal strategy
          </Button>
        </div>
      </div>

      {!canMakeForAccount() && (
        <p role="note" className="m-0 mb-2 text-[12px] text-muted-foreground">
          Showing every account's strategies. To make a new one, choose an account's tab above: a strategy belongs to one account and trades only on it.
        </p>
      )}
      {/*
        The bought strategies added up, beside the sold ones' margin tiles: a bought option uses no margin -- it is
        paid for in full, from the free balance -- so its figures are entries, lots and the premium.
      */}
      {data && (buys.strategies > 0 || buys.openEntries > 0) && (
        <div aria-label="bought strategies added up" className="mb-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Tile label="BUY strategies allow" name="the bought strategies' limits, added up"
                  value={<>{buys.entries} entr{buys.entries === 1 ? 'y' : 'ies'}</>}>
              <span>{buys.strategies} strateg{buys.strategies === 1 ? 'y' : 'ies'} on</span>
              <span>{buys.lots} lots</span>
              <span className="tabular-nums">{buys.allCostUsd === null ? 'premium set by the strike picked' : `${inr(usdToInr(buys.allCostUsd))} premium at most, all of it open`}</span>
            </Tile>
            <Tile label="In use now" name="in use now, bought strategies"
                  value={<>{buys.openEntries} of {limited ? cap : buys.entries} entr{(limited ? cap : buys.entries) === 1 ? 'y' : 'ies'}</>}
                  meter={{ label: 'entries in use, bought strategies', now: buys.openEntries, max: Math.max(1, limited ? cap : buys.entries), tone: 'accent' }}>
              <span>{buys.openLots} lots held</span>
              <span>no margin: each is paid for in full</span>
            </Tile>
            <Tile label={cap > 0 ? `Still to open · under the limit of ${cap}` : 'Still to open'} name="still to open, bought strategies"
                  value={buys.roomEntries === 0
                    ? <>Nothing — {cap > 0 && (data.openNow ?? 0) >= cap ? 'the limit is reached' : 'every strategy is at its own limit'}</>
                    : <>{buys.roomEntries} entr{buys.roomEntries === 1 ? 'y' : 'ies'} · {buys.roomLots} lots</>}
                  status={buys.roomEntries === 0 || buys.roomCostUsd === null || freeUsd === null ? null
                    : buys.roomCostUsd > freeUsd ? { tone: 'danger', word: 'More than is free' } : { tone: 'good', word: 'Fits in the free balance' }}>
              {buys.roomEntries > 0 && (
                <span className="tabular-nums">
                  {buys.roomCostUsd === null ? 'premium set by the strike picked' : `costs at most ${inr(usdToInr(buys.roomCostUsd))}`}
                  {freeUsd !== null && <> — {inr(usdToInr(freeUsd))} is free</>}
                </span>
              )}
            </Tile>
          </div>
        </div>
      )}
      {data && !data.schedulerOn && mine.some((s) => s.enabled) && (
        <p role="note" className="m-0 mb-2 text-[12px] text-[var(--warn)]">
          Auto-trading is off, so no signal is taken. Turn it on above.
        </p>
      )}
      {failed && <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">{failed}</p>}

      {/*
        The strategies added up: what they allow between them, and what that takes.
        Each card's own limit reads as modest; this is what the account has to carry.
      */}
      {data && totals.strategies > 0 && (
        <div aria-label="strategies added up" className="mb-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Tile label="Strategies allow" name="the strategies' limits, added up"
                  value={<>{totals.entries} entr{totals.entries === 1 ? 'y' : 'ies'}</>}>
              <span>{totals.strategies} strateg{totals.strategies === 1 ? 'y' : 'ies'} on</span>
              <span>{totals.lots} lots</span>
              <span className="tabular-nums">{inr(usdToInr(totals.marginUsd))} margin with all of it open</span>
            </Tile>

            {mine.some((s) => s.open) && (
              <Tile label={limited ? `In use now · of the limit of ${cap}` : 'In use now'} name="in use now, all strategies"
                    value={<>{usedEntries} of {mostEntries} entr{mostEntries === 1 ? 'y' : 'ies'}</>}
                    meter={{ label: 'entries in use, all strategies', now: usedEntries, max: mostEntries, tone: 'accent' }}>
                <span>{inUse.lots} of {inUse.lots + room.lots} lots</span>
                {/* Delta's own margin in use where it gives it; the desk's estimate only where it does not (paper). */}
                {deltaMarginUsd !== null
                  ? <span className="tabular-nums" aria-label="margin in use, Delta's figure">{inr(usdToInr(deltaMarginUsd))} margin in use — Delta&apos;s own figure</span>
                  : <span className="tabular-nums">{inr(usdToInr(inUse.marginUsd))} of {inr(usdToInr(inUse.marginUsd + room.marginUsd))} margin — the desk&apos;s estimate</span>}
                {shortCap !== null && <span aria-label="lots short, of the desk's limit">{shortNow} of {shortCap} lots short — the desk&apos;s limit</span>}
              </Tile>
            )}

            {/*
              What is still to open, against what is free. Not the whole requirement: the free balance is already net
              of the margin the open positions use, and holding all of it against that counted them twice.
            */}
            <Tile label={cap > 0 ? `Still to open · under the limit of ${cap}` : 'Still to open'} name="still to open, against the free margin"
                  value={room.entries === 0
                    ? <>Nothing — {cap > 0 && (data.openNow ?? 0) >= cap ? 'the limit is reached'
                      : room.heldByShortLimit ? `the desk's limit of ${shortCap} lots short leaves no room (${shortNow} now)`
                        : 'every strategy is at its own limit'}</>
                    : <>{room.entries} entr{room.entries === 1 ? 'y' : 'ies'} · {room.lots} lots</>}
                  status={room.entries === 0 || freeUsd === null ? null : fit}
                  meter={room.entries === 0 || freeUsd === null || !(freeUsd > 0) ? undefined
                    : { label: 'margin still needed, of what is free', now: Math.round(usdToInr(room.marginUsd) ?? 0), max: Math.round(usdToInr(freeUsd) ?? 0), tone: fit.tone }}>
              {room.entries > 0 && (
                <span className="tabular-nums">
                  needs {inr(usdToInr(room.marginUsd))} more margin
                  {freeUsd !== null && <> — {inr(usdToInr(freeUsd))} is free{freeUsd > 0 ? ` (${Math.round((room.marginUsd / freeUsd) * 100)}%)` : ''}</>}
                </span>
              )}
              {room.entries > 0 && room.heldByShortLimit && (
                <span aria-label="held by the limit on lots short">
                  held to {lotsLeft} more lots by the desk&apos;s limit of {shortCap} short ({shortNow} now): an entry past it is refused
                </span>
              )}
              {room.entries > 0 && <span>the worst case: the largest lots first</span>}
            </Tile>
          </div>
          {short && (
            <p role="note" className="m-0 mt-1.5 flex items-start gap-1.5 rounded-md border border-solid border-[var(--down)]/40 bg-[var(--down)]/10 px-2.5 py-1.5 text-[12px] leading-snug text-foreground">
              <XCircle className="mt-px h-3.5 w-3.5 flex-none text-[var(--down)]" aria-hidden />
              <span>That is more than is free: an order that does not fit is refused at Delta. Lower the limit, the lots, or a strategy&apos;s own &ldquo;at most open&rdquo;.</span>
            </p>
          )}
          <p className="m-0 mt-1 text-[11px] text-[var(--dim)]">
            Margin still needed is estimated at {inr(usdToInr(perLotUsd))} a lot
            {deltaMarginUsd !== null && shortNow > 0
              ? ' — the dearer of the desk’s 200x model and what Delta is charging per lot now.'
              : ' — the desk’s 200x model on BTC now; Delta’s own figure moves with the premium.'}
          </p>
        </div>
      )}

      {data && mine.length === 0 && (
        <p className="m-0 rounded-lg border border-dashed border-[var(--line)] px-3 py-3 text-[12.5px] text-muted-foreground">
          No signal strategy yet. <b className="text-foreground">New signal strategy</b> picks the methods, the strike and the lots;
          each signal is then sold as one option, with its SL and TGT on the BTC perp. Live orders start off.
        </p>
      )}

      <div className="grid gap-2">
        {mine.map((s) => {
          const live = Boolean(s.config.liveOrders);
          return (
            <div key={s.id} className={cn('rounded-lg border border-solid px-2.5 py-2', s.enabled ? 'border-[var(--up)]' : 'border-[var(--line)]')}>
              {/*
                On a phone: the name with Edit, Copy and Delete as icons on one row, and the two switches that matter
                -- on/off and live orders -- side by side under it, each half the width. One row on a wider screen.
              */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 sm:flex sm:flex-wrap sm:justify-between">
                <div className="order-1 flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-foreground">{s.name}</span>
                  <span className={cn('text-[11px]', s.enabled ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>{s.enabled ? 'on' : 'off'}</span>
                </div>
                <div className="order-3 col-span-2 grid grid-cols-2 gap-1.5 sm:order-2 sm:ml-auto sm:flex">
                  <Button size="sm" className="h-9 sm:h-8" variant={s.enabled ? 'outline' : 'default'} disabled={busy === s.id}
                          onClick={() => void act(s.id, () => setStrategyEnabled(s.id, !s.enabled))}>
                    {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    {s.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn('h-9 sm:h-8', (live || confirmLive === s.id) && 'border-[var(--down)] text-[var(--down)]')}
                    role="switch"
                    aria-checked={live}
                    aria-label={`Live orders for ${s.name}`}
                    disabled={busy === `live-${s.id}`}
                    onClick={() => setLive(s, !live)}
                  >
                    {busy === `live-${s.id}` && <Loader2 className="h-3 w-3 animate-spin" />}
                    {confirmLive === s.id ? `Tap again: real ${s.config.signal?.action === 'buy' ? 'buys' : 'orders'}` : live ? 'Live orders ON' : 'Live orders off'}
                  </Button>
                </div>
                <div className="order-2 flex flex-none items-center gap-0.5 sm:order-3 sm:gap-1.5">
                  <Button size="sm" variant="ghost" className="h-8 px-2 sm:px-2.5" onClick={() => { setEditing(s); setFormOpen(true); }}>
                    <Pencil className="h-3.5 w-3.5 sm:h-3 sm:w-3" /> <span className="sr-only sm:not-sr-only">Edit</span>
                  </Button>
                  {/*
                    Copy, then the copy opens to be renamed and changed: how a second strategy is actually made.
                    The server saves it switched off with live orders off -- a draft, not a second set of orders.
                  */}
                  <Button
                    size="sm" variant="ghost" className="h-8 px-2 sm:px-2.5"
                    aria-label={`Copy ${s.name}`}
                    title="A copy, switched off with live orders off, opened to rename and change"
                    disabled={busy === `copy-${s.id}`}
                    onClick={() => void act(`copy-${s.id}`, async () => {
                      const { strategy } = await cloneStrategy(s.id);
                      setEditing(strategy);
                      setFormOpen(true);
                    })}
                  >
                    {busy === `copy-${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3.5 w-3.5 sm:h-3 sm:w-3" />}
                    <span className="sr-only sm:not-sr-only">Copy</span>
                  </Button>
                  {/* Delete, on a second tap within four seconds. Its trades and their history stay. */}
                  <Button
                    size="sm" variant="ghost" className="h-8 px-2 text-[var(--down)] sm:px-2.5"
                    aria-label={`Delete ${s.name}`}
                    title="Delete this strategy. Trades it has open keep their exits, and its history stays."
                    disabled={busy === `del-${s.id}`}
                    onClick={() => {
                      if (confirmDelete !== s.id) {
                        setConfirmDelete(s.id);
                        setTimeout(() => setConfirmDelete((cur) => (cur === s.id ? null : cur)), 4_000);
                        return;
                      }
                      setConfirmDelete(null);
                      void act(`del-${s.id}`, () => deleteStrategy(s.id));
                    }}
                  >
                    {busy === `del-${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 sm:h-3 sm:w-3" />}
                    {confirmDelete === s.id && 'Tap again to delete'}
                  </Button>
                </div>
              </div>
              <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">{signalLine(s)}</p>
              <RuleNow s={s} />
              {/*
                The two numbers changed most often, on the card itself: the same settings as in the form (Edit),
                saved the same way, so neither needs the form opened. They apply to the next signal; what is
                already open keeps its size.
              */}
              <div role="group" aria-label={`quick settings of ${s.name}`} className="mt-1.5 grid grid-cols-2 items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground sm:flex sm:flex-wrap sm:gap-x-4 sm:gap-y-1.5">
                <label className="inline-flex items-center justify-between gap-1.5 sm:justify-start">
                  <span className="whitespace-nowrap">Lots per signal</span>
                  <NumberCommit
                    label={`Lots per signal for ${s.name}`}
                    value={s.config.lots}
                    busy={busy === `quick-${s.id}`}
                    problem={(n) => (Number.isInteger(n) && n >= 1 ? null : 'Lots must be a whole number, at least 1.')}
                    onInvalid={setFailed}
                    onSave={(n) => act(`quick-${s.id}`, () => saveStrategy({ id: s.id, name: s.name, config: { ...s.config, lots: n } }))}
                    className="h-7 w-12 sm:w-14"
                  />
                </label>
                <label className="inline-flex items-center justify-between gap-1.5 sm:justify-start">
                  <span className="whitespace-nowrap">At most open</span>
                  <NumberCommit
                    label={`At most open for ${s.name}`}
                    value={s.config.signal?.maxOpen ?? 1}
                    busy={busy === `quick-${s.id}`}
                    problem={(n) => (Number.isInteger(n) && n >= 1 && n <= MAX_SIGNAL_OPEN ? null : `At most 1 to ${MAX_SIGNAL_OPEN} of its trades open at once.`)}
                    onInvalid={setFailed}
                    onSave={(n) => act(`quick-${s.id}`, () => saveStrategy({ id: s.id, name: s.name, config: { ...s.config, signal: { ...s.config.signal!, maxOpen: n } } }))}
                    className="h-7 w-12 sm:w-14"
                  />
                </label>
                <span className="col-span-2 text-[11px] text-[var(--dim)]">saved as you leave the field · from the next signal</span>
              </div>
              {s.open && (s.config.signal?.action === 'buy'
                ? <UsageLine name={s.name} u={usageOf(s, data?.spot ?? null)} buyCostPerLotUsd={buyCostPerLotUsd(s)} />
                : <UsageLine name={s.name} u={usageOf(s, data?.spot ?? null)} />)}
              <p className="m-0 mt-0.5 text-[11.5px] text-[var(--dim)]">
                {s.status}
                {!live && (s.config.signal?.action === 'buy' ? ' · writes down what it would buy, sends nothing' : ' · writes down what it would sell, sends nothing')}
              </p>
            </div>
          );
        })}
      </div>

      {/* Every trade they took, or would have: SL, TGT, exit, result and money. */}
      {data && mine.length > 0 && <SignalTradeHistory strategies={data.strategies} />}


      {/* Which build the server is: so "is the change live" is read here, not guessed. */}
      {data?.build && (
        <p aria-label="server build" className="m-0 mt-2 text-[11px] text-[var(--dim)]">
          Server build <span className="font-mono text-muted-foreground">{data.build.tag ?? 'not tagged (run by hand)'}</span>
          {' · '}running since {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(data.build.startedAt)} IST
        </p>
      )}
      {data && (
        <SignalStrategyForm
          key={editing?.id ?? 'new-signal'}
          editing={editing}
          open={formOpen}
          onOpenChange={setFormOpen}
          onSaved={refresh}
          balanceUsd={data.balanceUsd}
          spot={data.spot}
        />
      )}
    </section>
  );
}
