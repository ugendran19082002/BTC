import { useEffect, useState } from 'react';
import type { TradeStatus } from '@/types/trade';
import { Card, CardTitle } from '@/components/ui/card';
import { KV } from '@/components/ui/kv';
import { Money } from '@/components/ui/money';
import { getSettings, setShortCap, type ShortCap } from '@/api/desk';
import { inr, pct, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The money, in plain words: what is free, what is in use, how today is going
 * after charges, and how much of today's loss limit is left.
 */
export function AccountCard({ status }: { status: TradeStatus | null }) {
  if (!status) return null;

  const unrealised = status.unrealisedPnlUsd ?? 0;
  const booked = status.realisedTodayUsd ?? 0;
  const today = status.today ?? { realisedUsd: booked, unrealisedUsd: unrealised, chargesUsd: 0, netUsd: booked + unrealised };
  const held = status.positions.reduce((n, p) => n + Math.abs(p.size), 0);

  const limit = status.limits.maxDailyLossUsd;
  const lost = Math.max(0, -booked);
  const left = Math.max(0, limit - lost);
  const used = limit > 0 ? lost / limit : 0;

  return (
    <Card>
      <CardTitle
        right={
          <span className={cn('text-[11px] font-semibold', status.mode === 'live' ? 'text-[var(--down)]' : 'text-[var(--warn)]')}>
            {status.mode === 'live' ? 'LIVE' : 'PAPER'}
          </span>
        }
      >
        Account
      </CardTitle>

      <dl className="m-0 grid gap-2">
        <KV label="Available" hint='Money not tied up in a position. Delta calls this "Available Margin".'>
          <Money value={status.balanceUsd} />
        </KV>
        <KV
          label={<>Used for positions <span className="ml-1 text-[11px] text-[var(--dim)]">{held > 0 ? `${held} contract${held === 1 ? '' : 's'}` : 'none'}</span></>}
          hint="Margin locked while positions are open. It comes back when they close. Estimated."
        >
          <Money value={heldMarginOf(status)} />
        </KV>

        <div className="my-0.5 h-px bg-border" />

        <KV label="Open P&L" hint="Profit or loss on open positions at Delta's price. Not yours until you close.">
          <Money value={status.unrealisedPnlUsd ?? null} signed />
        </KV>
        <KV label="Booked today" hint="Trades closed since 05:30 IST.">
          <Money value={today.realisedUsd} signed />
        </KV>
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

        <ShortCapLine held={held} inForce={status.limits.maxShortContracts} />
      </dl>

      {unrealised !== 0 && (
        <p className="m-0 mt-2.5 text-[11px] text-[var(--dim)]">₹ shown at ₹85 per $1.</p>
      )}
    </Card>
  );
}

/**
 * The most contracts the desk may be short at once. Editable, but the server
 * decides: it refuses a limit above what margin can carry, and this shows the
 * answer it gave rather than the number typed.
 */
function ShortCapLine({ held, inForce }: { held: number; inForce: number }) {
  const [cap, setCap] = useState<ShortCap | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getSettings()
      .then((r) => { if (live) setCap(r.shortCap); })
      // Still worth showing without it; the limit in force comes from the status poll.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const limit = cap?.inForce ?? inForce;
  const ceiling = cap?.ceiling ?? null;
  const used = limit > 0 ? held / limit : 0;

  const save = async () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1) {
      setRefusal('Enter a whole number of contracts, 1 or more.');
      return;
    }
    setSaving(true);
    setRefusal(null);
    try {
      const r = await setShortCap(n);
      setCap(r.shortCap);
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
          title="The most contracts the desk will be short across all strikes. New sells stop here."
        >
          Short limit
        </dt>
        <dd className="m-0 flex items-baseline gap-2 tabular-nums" aria-label="short cap">
          <span className="text-[13px] text-foreground">
            {held} <span className="text-[var(--dim)]">of {limit} contracts</span>
          </span>
          {!editing && (
            <button
              type="button"
              className="text-[12px] text-muted-foreground underline underline-offset-2"
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
            aria-label="most contracts short"
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
  const rows = status.open.filter((t) => t.position !== 0);
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
