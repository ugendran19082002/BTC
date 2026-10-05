import { useEffect, useState } from 'react';
import type { TradeStatus } from '@/types/trade';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { KV } from '@/components/ui/kv';
import { Money } from '@/components/ui/money';
import { getSettings, setLongCap, setShortCap, type LongCap, type ShortCap } from '@/api/desk';
import { usePersisted } from '@/hooks/usePersisted';
import { inr, pct, usdToInr } from '@/lib/format';
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

  const limit = status.limits.maxDailyLossUsd;
  const lost = Math.max(0, -booked);
  const left = Math.max(0, limit - lost);
  const used = limit > 0 ? lost / limit : 0;

  return (
    <CollapsibleCard
      id="account"
      title="Account"
      right={
        <span className={cn('text-[11px] font-semibold', status.mode === 'live' ? 'text-[var(--down)]' : 'text-[var(--warn)]')}>
          {status.mode === 'live' ? 'LIVE' : 'PAPER'}
        </span>
      }
    >
      <dl className="m-0 grid gap-2">
        <KV
          label={<span className="font-semibold text-foreground">Total</span>}
          hint={fromDelta
            ? 'Delta\'s wallet balance -- the same number as its app\'s FNO wallet.'
            : 'Available plus what open positions hold. The held part is estimated (paper), so Delta\'s screen is the authority.'}
        >
          <Money value={total} strong />
        </KV>
        <KV label="Available" hint='Money not tied up in a position. Delta calls this "Available Margin".'>
          <Money value={status.balanceUsd} />
        </KV>
        <KV
          label={<>Used for positions <span className="ml-1 text-[11px] text-[var(--dim)]">{held > 0 ? `${held} contract${held === 1 ? '' : 's'}` : 'none'}</span></>}
          hint={fromDelta ? 'Margin locked by open positions and orders, as Delta reports it: wallet balance less available.' : 'Margin locked while positions are open. It comes back when they close. Estimated.'}
        >
          <Money value={heldMargin} />
        </KV>

        <div className="my-0.5 h-px bg-border" />

        <KV label="Open P&L" hint="Profit or loss on open positions at Delta's price. Not yours until you close.">
          <Money value={status.unrealisedPnlUsd ?? null} signed />
        </KV>
        <KV label="Booked today" hint="Trades closed since 05:30 IST.">
          <Money value={today.realisedUsd} signed />
        </KV>
        {lossToday > 0 && (
          <KV label="Loss today" hint="Total losses from trades closed since 05:30 IST.">
            <Money value={-lossToday} signed />
          </KV>
        )}
        {today.chargesUsd > 0 && (
          <KV label="Charges today" hint="Delta's fee plus 18% GST on every fill today.">
            <Money value={-today.chargesUsd} signed />
          </KV>
        )}
        <KV label={<span className="font-semibold text-foreground">Net today</span>}>
          <Money value={today.netUsd} signed strong />
        </KV>

        <div className="my-0.5 h-px bg-border" />

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="m-0 text-[12.5px] text-muted-foreground">Daily loss limit</dt>
            <dd className="m-0 text-[13px] tabular-nums text-foreground" aria-label="loss budget left">
              <span>{inr(usdToInr(left))}</span>{' '}
              <span className="text-[var(--dim)]">of {inr(usdToInr(limit))} left</span>
            </dd>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className={cn('h-full rounded-full', used > 0.75 ? 'bg-[var(--down)]' : 'bg-[var(--warn)]')}
              style={{ width: `${Math.min(100, used * 100)}%` }}
            />
          </div>
          {used >= 1 ? (
            <p className="m-0 mt-1 text-[11px] font-medium text-[var(--down)]">
              Limit reached. New trades are blocked until tomorrow.
            </p>
          ) : used > 0 ? (
            <p className="m-0 mt-1 text-[11px] text-muted-foreground">
              {pct(used, 0)} used. New trades stop at 100%.
            </p>
          ) : null}
        </div>

        <PositionLimits status={status} heldShort={held} />
      </dl>

      {unrealised !== 0 && (
        <p className="m-0 mt-2.5 text-[11px] text-[var(--dim)]">₹ shown at ₹85 per $1.</p>
      )}
    </CollapsibleCard>
  );
}

/**
 * The account's two position limits, each on its own tab -- SELL (the short limit) and BUY (the long limit) --
 * with how much more it can sell or buy right now (5 Oct 2026). The tab chosen is remembered in this browser.
 *
 * The figures are the order gates' own: the limit less what is held, the margin the free balance carries for a
 * sale, and for a buy what the free balance pays for and the day's loss budget allows. Each limit is per account
 * and editable; the server decides, and a short limit above what margin carries is refused.
 */
type Side = 'sell' | 'buy';
function PositionLimits({ status, heldShort }: { status: TradeStatus; heldShort: number }) {
  const [side, setSide] = usePersisted<Side>('positions:limits-side', 'sell');
  const tab = (s: Side, label: string) => (
    <button
      key={s} type="button" role="tab" aria-selected={side === s} onClick={() => setSide(s)}
      className={cn('m-0 h-8 flex-1 appearance-none rounded-md border-0 px-3 font-[inherit] text-[12.5px] font-semibold',
        side === s ? 'bg-background shadow-sm' : 'bg-transparent text-muted-foreground',
        side === s && (s === 'buy' ? 'text-[var(--up)]' : 'text-[var(--down)]'))}
    >
      {label}
    </button>
  );
  const room = status.room;
  return (
    <div>
      <div role="tablist" aria-label="position limits" className="mb-2 flex gap-0.5 rounded-lg bg-muted p-0.5">
        {tab('sell', 'SELL · short limit')}
        {tab('buy', 'BUY · long limit')}
      </div>
      {side === 'sell' ? (
        <>
          <LimitLine side="sell" held={room?.sell.held ?? heldShort} inForce={status.limits.maxShortContracts} />
          {room && (
            <p aria-label="room to sell" className="m-0 mt-1.5 text-[12px] leading-snug text-muted-foreground">
              Can still sell <b className="text-foreground tabular-nums">{room.sell.lots.toLocaleString('en-US')} lots</b>
              {' — '}the limit leaves {room.sell.byLimit.toLocaleString('en-US')}
              {room.sell.byMargin !== null && <>, the free margin carries {room.sell.byMargin.toLocaleString('en-US')} at 200x</>}.
              {room.sell.perLotUsd !== null && <span className="text-[var(--dim)]"> About {inr(usdToInr(room.sell.perLotUsd))} of margin a lot.</span>}
            </p>
          )}
        </>
      ) : (
        <>
          <LimitLine side="buy" held={room?.buy.held ?? 0} inForce={status.limits.maxLongContracts ?? room?.buy.limit ?? 500} />
          {room && (
            <div aria-label="room to buy" className="mt-1.5 text-[12px] leading-snug text-muted-foreground">
              <p className="m-0">
                The limit leaves <b className="text-foreground tabular-nums">{room.buy.byLimit.toLocaleString('en-US')} lots</b>.
                A bought option uses no margin: it is paid for in full from the free balance
                {room.freeUsd !== null && <> ({inr(usdToInr(room.freeUsd))})</>}, and its cost counts against today&apos;s loss budget
                ({inr(usdToInr(room.buy.lossRoomUsd))} left).
              </p>
              <table aria-label="lots you can buy, by premium" className="mt-1.5 w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-[11px] text-[var(--dim)]">
                    <th scope="col" className="py-0.5 text-left font-medium">Premium</th>
                    <th scope="col" className="py-0.5 text-right font-medium">Costs a lot</th>
                    <th scope="col" className="py-0.5 text-right font-medium">Can buy</th>
                  </tr>
                </thead>
                <tbody>
                  {room.buy.byPremium.map((r) => (
                    <tr key={r.premium} className="border-t border-solid border-[var(--line)]">
                      <td className="py-0.5 text-left tabular-nums">${r.premium}</td>
                      <td className="py-0.5 text-right tabular-nums">{inr(usdToInr(r.perLotUsd))}</td>
                      <td className="py-0.5 text-right font-semibold tabular-nums text-foreground">{r.lots.toLocaleString('en-US')} lots</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="m-0 mt-1 text-[11px] text-[var(--dim)]">Each row is the smallest of the limit, the free balance and the loss budget, at that premium, fees included.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One position limit -- the most contracts held short (SELL) or bought (BUY) at once, across all strikes. Editable,
 * but the server decides: it refuses a short limit above what margin can carry, and this shows the answer it gave
 * rather than the number typed.
 */
function LimitLine({ side, held, inForce }: { side: Side; held: number; inForce: number }) {
  const [shortCap, setShortCapState] = useState<ShortCap | null>(null);
  const [longCap, setLongCapState] = useState<LongCap | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSettings()
      .then((r) => { if (live) { setShortCapState(r.shortCap); setLongCapState(r.longCap ?? null); } })
      // Still worth showing without it; the limit in force comes from the status poll.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const selling = side === 'sell';
  const limit = (selling ? shortCap?.inForce : longCap?.inForce) ?? inForce;
  const ceiling = selling ? shortCap?.ceiling ?? null : null;
  const used = limit > 0 ? held / limit : 0;
  const name = selling ? 'Short limit' : 'Long limit';

  const save = async () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1) {
      setRefusal('Enter a whole number of contracts, 1 or more.');
      return;
    }
    setSaving(true);
    setRefusal(null);
    try {
      if (selling) setShortCapState((await setShortCap(n)).shortCap);
      else setLongCapState((await setLongCap(n)).longCap);
      setEditing(false);
    } catch (e) {
      setRefusal((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt
          className="m-0 cursor-help text-[12.5px] text-muted-foreground underline decoration-dotted underline-offset-2"
          title={selling
            ? 'The most contracts this account will be short across all strikes. New sells stop here.'
            : 'The most contracts this account will hold bought across all strikes. New buys stop here.'}
        >
          {name}
        </dt>
        <dd className="m-0 flex items-baseline gap-2 tabular-nums" aria-label={selling ? 'short cap' : 'long cap'}>
          <span className="text-[13px] text-foreground">
            {held} <span className="text-[var(--dim)]">of {limit} contracts</span>
          </span>
          {!editing && (
            <button
              type="button"
              className="inline-flex min-h-8 min-w-8 items-center justify-center text-[12px] text-muted-foreground underline underline-offset-2"
              onClick={() => { setDraft(String(limit)); setRefusal(null); setEditing(true); }}
            >
              Edit
            </button>
          )}
        </dd>
      </div>

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
            aria-label={selling ? 'most contracts short' : 'most contracts long'}
            className="h-9 w-28 rounded border border-[var(--line)] bg-transparent px-2 text-[14px] tabular-nums text-foreground"
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
