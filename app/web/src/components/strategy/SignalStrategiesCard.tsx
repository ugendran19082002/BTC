import { useEffect, useRef, useState } from 'react';
import { FoldButton, useFold } from '@/components/ui/fold';
import { Bot, Copy, Loader2, Pencil, Plus } from 'lucide-react';
import { cloneStrategy, getStrategies, saveStrategy, setSignalMaxOpen, setStrategyEnabled } from '@/api/strategy';
import { MAX_GLOBAL_OPEN, ruleTfWords, type Strategy, type StrategyStatus } from '@/types/strategy';
import { usePoll } from '@/hooks/usePoll';
import { Button } from '@/components/ui/button';
import { SignalStrategyForm } from '@/components/strategy/SignalStrategyForm';
import { SignalTradeHistory } from '@/components/strategy/SignalTradeHistory';
import { describeStrike, signalTargetLabel } from '@/lib/strategy-preview';
import { time12 } from '@/lib/time';
import { globalMaxOpenProblem, signalTotals, totalsUnderCap, usageNow, usageOf, type Usage } from '@/lib/strategy-totals';
import { inr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The signal strategies, on the Live screen beside the methods that make the
 * signals: each one's switch, its live-orders switch, what it is set to, and
 * what the last signals did. New and Edit open the same form as the Strategy
 * tab, already on signals -- one strategy, two places to reach it.
 */


/**
 * One strategy's own limit and how much of it is in use now (4 Oct 2026): its
 * entries, its lots and the margin behind them, each "in use of limit", with a
 * bar for the entries. The limit is what the strategy may take; in use is what
 * the desk holds for it this moment -- positions and working orders.
 */
function UsageLine({ name, u }: { name: string; u: Usage }) {
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
      <span><span className="text-[var(--dim)]">Margin in use</span> <b className="tabular-nums text-foreground">{inr(usdToInr(u.marginUsd))} of {inr(usdToInr(u.maxMarginUsd))}</b></span>
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
  openNow: number; busy: boolean; onSave: (n: number) => void; onInvalid: (message: string) => void;
}) {
  /*
   * With no limit set, the field shows what the strategies allow between them:
   * that is the limit in force, and the number a lower one is typed against.
   * Typing that sum back is "no extra limit" again (saved as 0), so it goes on
   * following the strategies as they change.
   */
  const shown = value > 0 ? value : allowed;
  const [text, setText] = useState(String(shown));
  const typing = useRef(false);
  // Follow the server's number, but never while it is being typed into.
  useEffect(() => { if (!typing.current) setText(String(shown)); }, [shown]);
  const commit = () => {
    typing.current = false;
    const n = text.trim() === '' ? NaN : Number(text);
    const problem = globalMaxOpenProblem(n, allowed, MAX_GLOBAL_OPEN);
    if (problem) { onInvalid(problem); setText(String(shown)); return; }
    const next = allowed > 0 && n === allowed ? 0 : n;
    if (next !== value) onSave(next);
  };
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
      <input
        aria-label="At most open at once, all strategies"
        inputMode="numeric"
        value={text}
        disabled={busy}
        onFocus={() => { typing.current = true; }}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className="m-0 h-6 w-11 rounded border border-solid border-border bg-[var(--bg,#0a0e17)] px-1 text-center font-[inherit] text-[12px] tabular-nums text-foreground"
      />
      <span aria-label="open now, of the limit">
        {value > 0 ? `${openNow} of ${value} open` : allowed > 0 ? `all the strategies allow · ${openNow} open` : `no limit · ${openNow} open`}
      </span>
    </label>
  );
}

/** One line: the methods and way, the leg rule, the strike, lots, exits. */
export function signalLine(s: Strategy): string {
  const c = s.config;
  const r = c.signal;
  if (!r) return '';
  return [
    `${r.methods.length} method${r.methods.length === 1 ? '' : 's'} ${ruleTfWords(r)}`,
    'BUY → PE · SELL → CE',
    describeStrike(c).split(' — ')[0]!,
    `${c.lots} lot${c.lots === 1 ? '' : 's'}`,
    `perp SL / ${signalTargetLabel(r.target)}`,
    `max ${r.maxOpen} open`,
    `${time12(c.entryTime)} → ${time12(c.exitTime)}`,
  ].join(' · ');
}

export function SignalStrategiesCard({ onOpenStrategyTab }: { onOpenStrategyTab?: () => void }) {
  const { data, refresh } = usePoll<StrategyStatus>(getStrategies, 5_000);
  const [open, setOpen] = useFold('signal-strategies');
  const [editing, setEditing] = useState<Strategy | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Real orders need a second tap: a switch that sends money to the exchange should not flip on a brush.
  const [confirmLive, setConfirmLive] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setFailed(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setFailed((e as Error).message);
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
  const totals = signalTotals(mine, data?.balanceUsd ?? null, data?.spot ?? null);
  const cap = data?.signalMaxOpen ?? 0;
  const capped = totalsUnderCap(mine, cap, data?.balanceUsd ?? null, data?.spot ?? null);
  const inUse = usageNow(mine, data?.spot ?? null);

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
            <span className="desk-section-subtitle">The methods&apos; signals as options · BUY sells PE · SELL sells CE · SL / TGT on the BTC perp</span>
          </div>
        </div>
        <div className="desk-section-badges">
          {/* The desk's one number over all of them, left of the switch it works beside. */}
          {data && data.signalMaxOpen !== undefined && (
            <GlobalMaxOpen
              value={data.signalMaxOpen}
              allowed={totals.entries}
              openNow={data.openNow ?? 0}
              busy={busy === 'max-open'}
              onSave={(n) => void act('max-open', () => setSignalMaxOpen(n))}
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
          {data && (
            <span className="desk-badge-pill"
                  style={data.mode === 'live'
                    ? { background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' }
                    : { background: 'rgba(250, 204, 21, 0.1)', color: '#facc15', border: '1px solid rgba(250, 204, 21, 0.3)' }}>
              {data.mode === 'live' ? 'LIVE' : 'PAPER'}
            </span>
          )}
          <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
            <Plus className="h-3.5 w-3.5" /> New signal strategy
          </Button>
        </div>
      </div>

      {data && !data.schedulerOn && mine.some((s) => s.enabled) && (
        <p role="note" className="m-0 mb-2 text-[12px] text-[var(--warn)]">
          Auto-trading is off, so no signal is taken.{' '}
          {onOpenStrategyTab && (
            <button type="button" onClick={onOpenStrategyTab}
                    className="m-0 appearance-none border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2">
              Turn it on on the Strategy tab
            </button>
          )}
        </p>
      )}
      {failed && <p role="alert" className="m-0 mb-2 text-[12px] text-[var(--down)]">{failed}</p>}

      {/*
        The strategies added up: what they allow between them, and what that takes.
        Each card's own limit reads as modest; this is what the account has to carry.
      */}
      {data && totals.strategies > 0 && (
        <p aria-label="strategies added up" className="m-0 mb-2 rounded-lg bg-muted px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground">
          <b className="text-foreground">{totals.strategies}</b> strateg{totals.strategies === 1 ? 'y' : 'ies'} on
          {' · '}up to <b className="text-foreground">{totals.entries}</b> entr{totals.entries === 1 ? 'y' : 'ies'} at once
          {' · '}<b className="text-foreground">{totals.lots}</b> lots
          {' · '}needs <b className={cn('tabular-nums', totals.share !== null && totals.share > 1 ? 'text-[var(--down)]' : 'text-foreground')}>{inr(usdToInr(totals.marginUsd))}</b> margin
          {totals.share !== null && <> ({Math.round(totals.share * 100)}% of the {inr(usdToInr(data.balanceUsd))} free)</>}
          {mine.some((s) => s.open) && (
            <span className="block" aria-label="in use now, all strategies">
              <b className="text-foreground">In use now</b>: {inUse.entries} of {totals.entries} entr{totals.entries === 1 ? 'y' : 'ies'}
              {' · '}{inUse.lots} of {totals.lots} lots
              {' · '}<span className="tabular-nums">{inr(usdToInr(inUse.marginUsd))} of {inr(usdToInr(totals.marginUsd))}</span> margin
            </span>
          )}
          {cap > 0 && cap < totals.entries && (
            <span className="block">
              With the limit of <b className="text-foreground">{cap}</b>: at most <b className="text-foreground">{capped.lots}</b> lots
              {' · '}<b className={cn('tabular-nums', capped.share !== null && capped.share > 1 ? 'text-[var(--down)]' : 'text-foreground')}>{inr(usdToInr(capped.marginUsd))}</b> margin
              {capped.share !== null && <> ({Math.round(capped.share * 100)}% of free)</>} — the worst case, the largest lots first.
            </span>
          )}
          {capped.share !== null && capped.share > 1 && (
            <span role="note" className="block text-[var(--down)]">
              That is more than the free margin: an order that does not fit is refused at Delta. Lower the limit, the lots, or a strategy&apos;s own &ldquo;at most open&rdquo;.
            </span>
          )}
        </p>
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] font-semibold text-foreground">{s.name}</span>
                  <span className={cn('text-[11px]', s.enabled ? 'text-[var(--up)]' : 'text-[var(--dim)]')}>{s.enabled ? 'on' : 'off'}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" className="h-8" variant={s.enabled ? 'outline' : 'default'} disabled={busy === s.id}
                          onClick={() => void act(s.id, () => setStrategyEnabled(s.id, !s.enabled))}>
                    {busy === s.id && <Loader2 className="h-3 w-3 animate-spin" />}
                    {s.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn('h-8', (live || confirmLive === s.id) && 'border-[var(--down)] text-[var(--down)]')}
                    role="switch"
                    aria-checked={live}
                    aria-label={`Live orders for ${s.name}`}
                    disabled={busy === `live-${s.id}`}
                    onClick={() => setLive(s, !live)}
                  >
                    {busy === `live-${s.id}` && <Loader2 className="h-3 w-3 animate-spin" />}
                    {confirmLive === s.id ? 'Tap again: real orders' : live ? 'Live orders ON' : 'Live orders off'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => { setEditing(s); setFormOpen(true); }}>
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                  {/*
                    Copy, then the copy opens to be renamed and changed: how a second strategy is actually made.
                    The server saves it switched off with live orders off -- a draft, not a second set of orders.
                  */}
                  <Button
                    size="sm" variant="ghost" className="h-8"
                    aria-label={`Copy ${s.name}`}
                    title="A copy, switched off with live orders off, opened to rename and change"
                    disabled={busy === `copy-${s.id}`}
                    onClick={() => void act(`copy-${s.id}`, async () => {
                      const { strategy } = await cloneStrategy(s.id);
                      setEditing(strategy);
                      setFormOpen(true);
                    })}
                  >
                    {busy === `copy-${s.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
                    Copy
                  </Button>
                </div>
              </div>
              <p className="m-0 mt-1 text-[11.5px] leading-snug text-muted-foreground">{signalLine(s)}</p>
              {s.open && <UsageLine name={s.name} u={usageOf(s, data?.spot ?? null)} />}
              <p className="m-0 mt-0.5 text-[11.5px] text-[var(--dim)]">
                {s.status}
                {!live && ' · writes down what it would sell, sends nothing'}
              </p>
            </div>
          );
        })}
      </div>

      {/* Every trade they took, or would have: SL, TGT, exit, result and money. */}
      {data && mine.length > 0 && <SignalTradeHistory strategies={data.strategies} />}


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
