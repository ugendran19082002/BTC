import type * as React from 'react';
import { useEffect, useState } from 'react';
import type { TradeStatus } from '@/types/trade';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { KV } from '@/components/ui/kv';
import { Money } from '@/components/ui/money';
import { getSettings, setShortCap, type ShortCap } from '@/api/desk';
import { LossBudget } from '@/components/trade/LossBudget';
import { inr, signedInr, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The money, in plain words: what there is altogether, what is free, what is
 * in use, how today is going after charges, and how much of today's loss limit
 * is left.
 */
export function AccountCard({ status }: { status: TradeStatus | null }) {
  if (!status) return null;

  const unrealised = status.unrealisedPnlUsd ?? 0;
  const booked = status.realisedTodayUsd ?? 0;
  const today = status.today ?? { realisedUsd: booked, unrealisedUsd: unrealised, chargesUsd: 0, netUsd: booked + unrealised };
  const lossToday = today.lossUsd ?? status.lossTodayUsd ?? (booked < 0 ? Math.abs(booked) : 0);
  const held = status.positions.reduce((n, p) => n + Math.abs(p.size), 0);
  /*
   * Delta's own figures where it gives them: the wallet balance its app shows, and the margin in use (the balance
   * less what is free). Until 2 Oct 2026 the used part was always an estimate from the positions -- $13.36 where
   * Delta said $8.48 -- and the total, built on it, was $4.88 over Delta's. The estimate stays for paper only.
   */
  const fromDelta = status.walletUsd != null && status.marginUsedUsd != null;
  const heldMargin = fromDelta ? status.marginUsedUsd! : heldMarginOf(status);
  const total = fromDelta
    ? status.walletUsd!
    : heldMargin === null || status.balanceUsd === null ? null : status.balanceUsd + heldMargin;

  // Several accounts together ("All accounts"): the sums, with each account's own part in a table below.
  const combined = status.combined ?? null;

  return (
    <CollapsibleCard
      id="account"
      title={combined ? `Account · all ${combined.accounts.length} accounts` : 'Account'}
      right={
        <span className={cn('text-[11px] font-semibold', status.mode === 'live' ? 'text-[var(--down)]' : 'text-[var(--warn)]')}>
          {status.mode === 'live' ? 'LIVE' : 'PAPER'}
        </span>
      }
    >
      {/*
        A plain column, each figure its own <dl>: one list around tiles, rules, tabs and buttons was not a list
        a screen reader could read (axe, 9 Oct 2026: dt / dd two wrappers deep, buttons among them).
      */}
      <div className="grid gap-2">
        {/* Total and Available side by side: the two figures read together. */}
        <div className="grid grid-cols-2 gap-2">
          <Tile
            label={<span className="font-semibold text-foreground">Total</span>}
            hint={fromDelta
              ? 'Delta\'s wallet balance -- the same number as its app\'s FNO wallet.'
              : 'Available plus what open positions hold. The held part is estimated (paper), so Delta\'s screen is the authority.'}
          >
            <Money value={total} strong />
          </Tile>
          <Tile label="Available" hint='Money not tied up in a position. Delta calls this "Available Margin".'>
            <Money value={status.balanceUsd} />
          </Tile>
        </div>
        <dl className="m-0">
          <KV
            label={<>Used for positions <span className="ml-1 text-[11px] text-[var(--dim)]">{held > 0 ? `${held} contract${held === 1 ? '' : 's'}` : 'none'}</span></>}
            hint={fromDelta ? 'Margin locked by open positions and orders, as Delta reports it: wallet balance less available.' : 'Margin locked while positions are open. It comes back when they close. Estimated.'}
          >
            <Money value={heldMargin} />
          </KV>
        </dl>

        <div className="my-0.5 h-px bg-border" />

        {/* The day in four, two by two -- always all four, so the layout does not jump as figures appear. */}
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Open P&L" hint="Profit or loss on open positions at Delta's price. Not yours until you close.">
            <Money value={status.unrealisedPnlUsd ?? null} signed />
          </Tile>
          <Tile label="Booked today" hint="Trades closed since 05:30 IST.">
            <Money value={today.realisedUsd} signed />
          </Tile>
          <Tile label="Loss today" hint="Total losses from trades closed since 05:30 IST.">
            <Money value={lossToday > 0 ? -lossToday : 0} signed />
          </Tile>
          <Tile label="Charges today" hint="Delta's fee plus 18% GST on every fill today.">
            <Money value={today.chargesUsd > 0 ? -today.chargesUsd : 0} signed />
          </Tile>
        </div>
        <dl className="m-0">
          <KV label={<span className="font-semibold text-foreground">Net today</span>}>
            <Money value={today.netUsd} signed strong />
          </KV>
        </dl>

        <div className="my-0.5 h-px bg-border" />

        {/* The daily loss limit beside the short limit: two columns, each label over its figure, so they fit a phone.
            What is left to sell, and the ₹ note, sit under the loss limit. */}
        <PositionLimits status={status} heldShort={held} lossCell={<LossBudget status={status} dense />        } note={unrealised !== 0 && (
          <p className="m-0 mt-2 text-[11px] text-[var(--dim)]">₹ shown at ₹85 per $1.</p>
        )} />
      </div>

      {/* Each account's own part of the totals above: the sums are these rows added. */}
      {combined && (
        <table aria-label="by account" className="mt-3 w-full border-collapse text-[12px]">
          <thead>
            <tr className="text-[10.5px] uppercase tracking-[0.5px] text-[var(--dim)]">
              <th scope="col" className="py-1 text-left font-medium">Account</th>
              <th scope="col" className="py-1 text-right font-medium">Total</th>
              <th scope="col" className="py-1 text-right font-medium">Open P&amp;L</th>
              <th scope="col" className="py-1 text-right font-medium">Net today</th>
            </tr>
          </thead>
          <tbody>
            {combined.accounts.map((a) => (
              <tr key={a.id} className="border-0 border-t border-solid border-[var(--line)]">
                <td className="py-1 text-left font-[inherit]">
                  <span className="font-semibold text-foreground">{a.name}</span>
                  <span className="ml-1.5 text-[11px] text-[var(--dim)]">{a.positions} open</span>
                </td>
                <td className="py-1 text-right tabular-nums">{(a.totalUsd ?? a.availableUsd) === null ? '—' : inr(usdToInr((a.totalUsd ?? a.availableUsd)!))}</td>
                <td className={cn('py-1 text-right tabular-nums', a.openPnlUsd > 0 ? 'text-[var(--up)]' : a.openPnlUsd < 0 ? 'text-[var(--down)]' : '')}>{signedInr(usdToInr(a.openPnlUsd))}</td>
                <td className={cn('py-1 text-right font-semibold tabular-nums', a.netTodayUsd > 0 ? 'text-[var(--up)]' : a.netTodayUsd < 0 ? 'text-[var(--down)]' : '')}>{signedInr(usdToInr(a.netTodayUsd))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CollapsibleCard>
  );
}

/**
 * The account's position limit -- the short limit -- with how much more it can sell right now (5 Oct 2026). Selling
 * only (21 Oct 2026: "SELL only, no BUY choice"): the BUY tab, the long limit and the room to buy are gone.
 *
 * The figures are the order gates' own: the limit less what is held, and the margin the free balance carries for a
 * sale. The limit is per account and editable; the server decides, and one above what margin carries is refused.
 */
function PositionLimits({ status, heldShort, lossCell, note }: { status: TradeStatus; heldShort: number; lossCell: React.ReactNode; note?: React.ReactNode }) {
  const room = status.room;
  // Several accounts together: the limit is a sum, read here and changed on each account's own tab.
  const several = Boolean(status.combined);
  const shortHeld = status.positions.reduce((n, p) => n + (p.size < 0 ? -p.size : 0), 0);
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
      {/* Left: the day's loss limit, and under it what is left to sell. */}
      <div className="min-w-0">
        {lossCell}
        {room && (
          <p aria-label="room to sell" className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
            <span className="block">Can still sell <b className="text-foreground tabular-nums">{room.sell.lots.toLocaleString('en-US')} lots</b></span>
            <span className="block">Limit leaves {room.sell.byLimit.toLocaleString('en-US')}</span>
            {room.sell.byMargin !== null && <span className="block">Margin carries {room.sell.byMargin.toLocaleString('en-US')} at 200x</span>}
            {room.sell.perLotUsd !== null && <span className="block text-[var(--dim)]">About {inr(usdToInr(room.sell.perLotUsd))} margin a lot</span>}
          </p>
        )}
        {note}
      </div>
      <div className="min-w-0">
        <LimitLine held={several ? shortHeld : room?.sell.held ?? heldShort} inForce={status.limits.maxShortContracts} readOnly={several} />
        {several && <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">Every account&apos;s limit added. Change one on its own tab.</p>}
      </div>
    </div>
  );
}

/**
 * The short limit -- the most contracts held short at once, across all strikes. Editable, but the server decides: it
 * refuses one above what margin can carry, and this shows the answer it gave rather than the number typed.
 */
function LimitLine({ held, inForce, readOnly = false }: { held: number; inForce: number; readOnly?: boolean }) {
  const [shortCap, setShortCapState] = useState<ShortCap | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    // Read-only (several accounts): the limit is the sum handed in, not one account's setting.
    if (readOnly) return;
    let live = true;
    getSettings()
      .then((r) => { if (live) setShortCapState(r.shortCap); })
      // Still worth showing without it; the limit in force comes from the status poll.
      .catch(() => {});
    return () => { live = false; };
  }, [readOnly]);

  const limit = readOnly ? inForce : shortCap?.inForce ?? inForce;
  const ceiling = shortCap?.ceiling ?? null;
  const used = limit > 0 ? held / limit : 0;
  const name = 'Short limit';

  const save = async () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1) {
      setRefusal('Enter a whole number of contracts, 1 or more.');
      return;
    }
    setSaving(true);
    setRefusal(null);
    try {
      setShortCapState((await setShortCap(n)).shortCap);
      setEditing(false);
    } catch (e) {
      setRefusal((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    // The Edit button sits over the list's corner, not inside it: a <dl> holds names and values only.
    <div className="relative">
      <dl className="m-0">
        <dt
          className="m-0 w-fit cursor-help text-[12px] text-muted-foreground underline decoration-dotted underline-offset-2"
          title="The most contracts this account will be short across all strikes. New sells stop here."
        >
          {name}
        </dt>
        <dd className="m-0 mt-0.5 tabular-nums" aria-label="short cap">
          <span className="text-[13px] text-foreground">
            {held} <span className="text-[11.5px] text-[var(--dim)]">of {limit} contracts</span>
          </span>
        </dd>
      </dl>
      {!editing && !readOnly && (
        <button
          type="button" aria-label={`Edit the ${name.toLowerCase()}`}
          className="absolute right-0 top-0 m-0 inline-flex min-h-7 -translate-y-1.5 appearance-none items-center border-0 bg-transparent p-0 font-[inherit] text-[11.5px] text-muted-foreground underline underline-offset-2"
          onClick={() => { setDraft(String(limit)); setRefusal(null); setEditing(true); }}
        >
          Edit
        </button>
      )}

      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
        <div
          className={cn('h-full rounded-full', used > 0.75 ? 'bg-[var(--down)]' : 'bg-[var(--warn)]')}
          style={{ width: `${Math.min(100, used * 100)}%` }}
        />
      </div>

      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={draft}
            aria-label="most contracts short"
            className="h-9 w-24 rounded border border-[var(--line)] bg-transparent px-2 text-[14px] tabular-nums text-foreground"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            disabled={saving}
            className="h-9 rounded border border-[var(--line)] px-3 text-[13px] text-foreground disabled:opacity-50"
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="h-9 px-2 text-[12px] text-muted-foreground underline underline-offset-2"
            onClick={() => { setEditing(false); setRefusal(null); }}
          >
            Cancel
          </button>
          {ceiling !== null && (
            <span className="text-[11px] text-[var(--dim)]">Margin allows {ceiling} at 200x</span>
          )}
        </div>
      )}

      {refusal && <p className="m-0 mt-1 text-[11px] font-medium text-[var(--down)]">{refusal}</p>}
    </div>
  );
}

/**
 * Margin the open positions are holding, estimated from each trade's leverage.
 * Delta reports free margin, not used, so this is worked out -- Delta's screen
 * is the authority.
 */
function heldMarginOf(status: TradeStatus): number | null {
  // Shorts only: a bought option is paid for in full and holds no margin.
  const rows = status.open.filter((t) => t.position < 0);
  if (rows.length === 0) return 0;
  let total = 0;
  for (const t of rows) {
    const leverage = t.plan?.leverage ?? 200;
    const spot = t.live?.liquidationPrice != null && t.entryAvgPrice != null
      // room = spot x 0.5 / leverage, so spot = room x leverage / 0.5
      ? (t.live.liquidationPrice - t.entryAvgPrice) * leverage * 2
      : null;
    if (spot === null) return null;
    total += (spot / leverage) * 0.001 * Math.abs(t.position);
  }
  return total;
}

/** A label over its value, for the figures laid out in a grid on the card. */
function Tile({ label, hint, children }: { label: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <dl className="m-0 min-w-0 rounded-md bg-muted/60 px-2.5 py-1.5">
      <dt className={cn('m-0 text-[11.5px] text-muted-foreground', hint && 'cursor-help underline decoration-dotted underline-offset-2')} title={hint}>
        {label}
      </dt>
      <dd className="m-0 mt-0.5 tabular-nums">{children}</dd>
    </dl>
  );
}
