import { useEffect, useState } from 'react';
import type { TradeStatus } from '@/types/trade';
import { Card, CardTitle } from '@/components/ui/card';
import { getSettings, setShortCap, type ShortCap } from '@/api/desk';
import { inr, pct, signedInr, signedUsd, usd, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The money, in plain words.
 *
 * Four questions, in the order they get asked: what did I put in, what is free,
 * how is it doing, and how much of today's loss budget is left. Dollars because
 * that is what the exchange quotes in, rupees beside them because that is the
 * account -- neither should have to be converted in your head.
 *
 * It sits above the positions rather than on the Live tab, where it used to be.
 * "Can I afford this" is a question you ask before a trade; "how am I doing" is
 * one you ask after, and this card only answers the second.
 */
export function AccountCard({ status }: { status: TradeStatus | null }) {
  if (!status) return null;

  const free = status.balanceUsd;
  // What the open positions are holding. The exchange reports free margin, so
  // what is tied up is the difference from the equity below -- and equity is
  // free plus the mark-to-market on what is open.
  const unrealised = status.unrealisedPnlUsd ?? 0;
  const booked = status.realisedTodayUsd ?? 0;
  const held = status.positions.reduce((n, p) => n + Math.abs(p.size), 0);

  const budget = status.limits.maxDailyLossUsd;
  const spent = Math.max(0, -booked);
  const leftOfBudget = Math.max(0, budget - spent);
  const budgetUsed = budget > 0 ? spent / budget : 0;

  return (
    <Card>
      <CardTitle
        right={
          <span className="text-[11px] text-muted-foreground">
            {status.mode === 'live' ? 'real money' : 'paper'}
          </span>
        }
      >
        Your account
      </CardTitle>

      <dl className="m-0 grid gap-2">
        <Line
          label="free to trade with"
          usdValue={free}
          hint={`What is not already tied up in a position. Delta calls this "Available Margin".`}
        />
        <Line
          label="held against open positions"
          usdValue={heldMarginOf(status)}
          note={held > 0 ? `${held} contract${held === 1 ? '' : 's'}` : 'nothing open'}
          hint="Locked while the position is on, and returned when it closes."
        />

        <div className="my-0.5 h-px bg-border" />

        <Line
          label="open positions are up"
          usdValue={status.unrealisedPnlUsd ?? null}
          signed
          hint="Marked at the exchange's price. You have not banked it until you close."
        />
        <Line
          label="booked today"
          usdValue={status.realisedTodayUsd ?? null}
          signed
          hint="Closed trades since 05:30 IST, when the daily contract opens."
        />

        <div className="my-0.5 h-px bg-border" />

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="m-0 text-[12.5px] text-muted-foreground">today&rsquo;s loss budget</dt>
            <dd className="m-0 text-[13px] tabular-nums text-foreground" aria-label="loss budget left">
              {/* A real space, not a margin: a margin is not read aloud, and
                  "₹425of ₹425 left" is what a screen reader would say. */}
              <span>{inr(usdToInr(leftOfBudget))}</span>{' '}
              <span className="text-[var(--dim)]">of {inr(usdToInr(budget))} left</span>
            </dd>
          </div>
          {/* The gate that stops new trades. Worth seeing before it fires. */}
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className={cn('h-full rounded-full', budgetUsed > 0.75 ? 'bg-[var(--down)]' : 'bg-[var(--warn)]')}
              style={{ width: `${Math.min(100, budgetUsed * 100)}%` }}
            />
          </div>
          {budgetUsed >= 1 ? (
            // Past the limit, the percentage stops being the point: what matters
            // is that the gate is shut.
            <p className="m-0 mt-1 text-[11px] font-medium text-[var(--down)]">
              Budget spent. New trades are blocked until tomorrow.
            </p>
          ) : budgetUsed > 0 ? (
            <p className="m-0 mt-1 text-[11px] text-muted-foreground">
              {pct(budgetUsed, 0)} used. New trades stop when it runs out.
            </p>
          ) : null}
        </div>

        <ShortCapLine held={held} inForce={status.limits.maxShortContracts} />
      </dl>

      {unrealised !== 0 && (
        <p className="m-0 mt-2.5 text-[11.5px] text-[var(--dim)]">
          Rupees at ₹85 to the dollar, the same rate the 733-day record uses.
        </p>
      )}
    </Card>
  );
}

/**
 * The most the desk may be short, and how close it is.
 *
 * This gate refuses in the order ticket, several taps away from here, and until
 * now the only way to find out was to be turned down by it: "would take total
 * short to 820, limit is 500" arrived after the size was typed, with no way to
 * see the limit beforehand or to change it.
 *
 * The number is editable, but the *server* decides. It refuses a cap above what
 * the margin could carry, and this shows the answer it gave rather than the
 * number that was typed -- the same rule the mode switch follows, and for the
 * same reason: a screen that can raise its own risk limit is one that can do it
 * by accident.
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
      // The card is still worth showing without it; the cap in force comes from
      // the status poll either way.
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const limit = cap?.inForce ?? inForce;
  const ceiling = cap?.ceiling ?? null;
  const used = limit > 0 ? held / limit : 0;

  const save = async () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1) {
      setRefusal('A whole number of contracts, at least 1.');
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
          title="The most contracts this desk will be short across every strike at once. New sells are refused at this line."
        >
          most you may be short
        </dt>
        <dd className="m-0 flex items-baseline gap-2 tabular-nums" aria-label="short cap">
          <span className="text-[13px] text-foreground">
            {held} <span className="text-[var(--dim)]">of {limit} contracts</span>
          </span>
          {!editing && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline underline-offset-2"
              onClick={() => {
                setDraft(String(limit));
                setRefusal(null);
                setEditing(true);
              }}
            >
              change
            </button>
          )}
        </dd>
      </div>

      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--line)]">
        <div
          className={cn('h-full rounded-full', used > 0.75 ? 'bg-[var(--down)]' : 'bg-[var(--warn)]')}
          style={{ width: `${Math.min(100, used * 100)}%` }}
        />
      </div>

      {editing && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={draft}
            aria-label="most contracts short"
            className="w-24 rounded border border-[var(--line)] bg-transparent px-2 py-1 text-[13px] tabular-nums text-foreground"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            disabled={saving}
            className="rounded border border-[var(--line)] px-2 py-1 text-[12px] text-foreground disabled:opacity-50"
            onClick={save}
          >
            {saving ? 'saving…' : 'save'}
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline underline-offset-2"
            onClick={() => { setEditing(false); setRefusal(null); }}
          >
            cancel
          </button>
          {ceiling !== null && (
            <span className="text-[11px] text-[var(--dim)]">
              margin covers {ceiling} at 200x
            </span>
          )}
        </div>
      )}

      {refusal && (
        <p className="m-0 mt-1 text-[11px] font-medium text-[var(--down)]">{refusal}</p>
      )}
    </div>
  );
}

/**
 * What the open positions are holding, estimated.
 *
 * The exchange reports free margin rather than used, so this is worked out from
 * the leverage each trade was opened at. It is an estimate and reads as one --
 * the authority is the Delta screen.
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

function Line({ label, usdValue, signed, note, hint }: {
  label: string;
  usdValue: number | null;
  signed?: boolean;
  note?: string;
  hint?: string;
}) {
  const rupees = usdToInr(usdValue);
  const tone = signed && usdValue ? (usdValue > 0 ? 'up' : 'down') : null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt
        className={cn('m-0 text-[12.5px] text-muted-foreground', hint && 'cursor-help underline decoration-dotted underline-offset-2')}
        title={hint}
      >
        {label}
        {note && <span className="ml-1.5 text-[11px] text-[var(--dim)]">{note}</span>}
      </dt>
      <dd className="m-0 flex items-baseline gap-2 tabular-nums">
        {/* Rupees lead. The exchange quotes in dollars, so they stay beside. */}
        <span
          className={cn(
            'text-[14px] font-semibold',
            tone === 'up' ? 'text-[var(--up)]' : tone === 'down' ? 'text-[var(--down)]' : 'text-foreground',
          )}
        >
          {signed ? signedInr(rupees) : inr(rupees)}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {signed ? signedUsd(usdValue) : usd(usdValue)}
        </span>
      </dd>
    </div>
  );
}
