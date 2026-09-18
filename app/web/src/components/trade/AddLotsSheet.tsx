import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { addToPosition, previewAdd } from '@/api/trade';
import type { AddDraft, AddPreview, Trade } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Figure } from '@/components/ui/figure';
import { KV } from '@/components/ui/kv';
import { SwipeToConfirm } from '@/components/ui/swipe-confirm';
import { contractLabel, inr, price, size as fmtSize, usd, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Sell more of a contract that is already held.
 *
 * The same thing the strategy does when a target fills, offered by hand from
 * the position card -- and going through the same engine path, so a hand add
 * and a strategy add leave the same journal and the same single position with
 * one average, one target and one stop covering all of it.
 *
 * Two steps, like the ticket. The preview runs every gate -- margin, the short
 * cap, the daily loss, the spread, the feed -- and prices the add in money:
 * the credit, Delta's charges to open, the margin the exchange will hold, and
 * the average the position moves to. What it shows is what the add will be
 * judged on, because both send the same body to the same gates. Sending takes
 * a swipe, as anything that creates risk does here.
 *
 * A typed price is also the floor: an add "at 9.50" is never sold under 9.50.
 * Left blank, the add starts at the offer and may walk to the bid, not past it.
 */
const num = (s: string, fallback: number) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

/** The server's own default and ceiling, in `http/add-body.ts`. */
export const ADD_WINDOW_DEFAULT_MIN = 60;
/** What the desk has always done with an add by hand: walk to the bid over five seconds. */
export const ADD_CHASE_DEFAULT_SEC = 5;
export const ADD_CHASE_MAX_SEC = 600;
export const ADD_WINDOW_MAX_MIN = 240;
const ADD_WINDOWS = [['15m', 15], ['1h', 60], ['4h', 240]] as const;

/** "1h", "4h", "15 minutes" -- the way the number was picked. */
export function describeWindow(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60}h`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function AddLotsSheet({ trade, open, onOpenChange, onAdded }: {
  trade: Trade;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded?: () => void;
}) {
  const held = Math.abs(trade.position);
  const [lots, setLots] = useState('');
  const [priceText, setPriceText] = useState('');
  /*
   * How long the add may work before whatever is unfilled is cancelled.
   *
   * An hour by default. The window is the whole point of an add by hand --
   * "sell more of this if the price comes to me" -- and five minutes answered
   * a question nobody asked: either it fills in the first seconds of the
   * chase, or it needs long enough for the market to come back. The chips are
   * the windows anyone actually picks; the box takes any number of minutes up
   * to four hours, and the add can be stopped from the card at any point.
   */
  const [windowMin, setWindowMin] = useState(String(ADD_WINDOW_DEFAULT_MIN));
  /*
   * "If not filled, sell at bid after N seconds" -- the ticket's control, on
   * the add, because the add does the same thing: it rests at the offer and
   * nobody is watching it. On by default at five seconds, which is what every
   * add by hand has done since the sheet existed; switched off it rests at the
   * offer and never crosses, and the window still ends it. A typed price stays
   * the floor either way, so crossing can never sell under it.
   */
  const [chaseOn, setChaseOn] = useState(true);
  const [chaseSec, setChaseSec] = useState(ADD_CHASE_DEFAULT_SEC);
  const [preview, setPreview] = useState<AddPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // A fresh sheet each time: yesterday's lots are not today's, and a stale
  // preview under a new number is the screen disagreeing with the book.
  useEffect(() => {
    if (!open) return;
    setLots('');
    setPriceText('');
    setWindowMin(String(ADD_WINDOW_DEFAULT_MIN));
    setChaseOn(true);
    setChaseSec(ADD_CHASE_DEFAULT_SEC);
    setPreview(null);
    setFailed(null);
  }, [open]);

  const lotsN = Math.trunc(num(lots, 0));
  const limit = priceText.trim() === '' ? null : num(priceText, -1);
  const minutes = num(windowMin, NaN);
  const windowOk = Number.isFinite(minutes) && minutes > 0 && minutes <= ADD_WINDOW_MAX_MIN;
  const draft = useMemo<AddDraft | null>(() => {
    if (!(lotsN >= 1)) return null;
    if (limit !== null && !(limit > 0)) return null;
    if (!windowOk) return null;
    return {
      tradeId: trade.tradeId, lots: lotsN, limitPrice: limit, timeoutMin: minutes,
      chaseSeconds: chaseOn ? chaseSec : 0,
    };
  }, [trade.tradeId, lotsN, limit, windowOk, minutes, chaseOn, chaseSec]);

  // Debounced, as on the ticket: typing a size is not a request per keystroke.
  useEffect(() => {
    if (!open || !draft) { setPreview(null); return; }
    let alive = true;
    setChecking(true);
    const id = setTimeout(() => {
      previewAdd(draft)
        .then((p) => { if (alive) { setPreview(p); setFailed(null); } })
        .catch((e: Error) => { if (alive) setFailed(e.message); })
        .finally(() => { if (alive) setChecking(false); });
    }, 220);
    return () => { alive = false; clearTimeout(id); };
  }, [open, draft]);

  /*
   * The walk with nowhere to go: the floor is at or above the price the order
   * starts at, so nothing will ever cross however many seconds are set.
   */
  const deadWalk = chaseOn && preview !== null && preview.canWalk === false;

  const send = async () => {
    if (!draft) return;
    setFailed(null);
    const r = await addToPosition(draft);
    if (!r.ok) {
      setFailed(r.failures.length ? r.failures.map((f) => f.message).join(' ') : r.error);
      throw new Error(r.error);
    }
    onAdded?.();
    onOpenChange(false);
  };

  const blocked = preview !== null && !preview.ok;
  const canSend = Boolean(draft) && Boolean(preview?.ok) && !checking;
  const bid = trade.live?.bid ?? preview?.quote?.bid ?? null;
  const ask = trade.live?.ask ?? preview?.quote?.ask ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={`Add lots · ${contractLabel(trade.symbol)}`}
        description={`Short ${fmtSize(held)} @ ${price(trade.entryAvgPrice)} avg. Sells more of the same contract under this position.`}
      >
        <div className="mb-3 grid grid-cols-3 gap-2 rounded-lg bg-muted px-2.5 py-2">
          <Figure label="Bid" value={price(bid)} hint="What a seller gets right now." />
          <Figure label="Ask" value={price(ask)} hint="Where the add starts when no price is typed." />
          <Figure label="Held" value={fmtSize(held)} second={`@ ${price(trade.entryAvgPrice)}`} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
            Lots to add
            <Input
              aria-label="lots to add"
              inputMode="numeric"
              value={lots}
              placeholder="0"
              onChange={(e) => setLots(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
            Price · blank starts at the ask
            <Input
              aria-label="add price"
              inputMode="decimal"
              value={priceText}
              placeholder={ask !== null ? price(ask) : '—'}
              onChange={(e) => setPriceText(e.target.value)}
            />
          </label>
        </div>
        <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
          {limit !== null && limit > 0
            ? `Never sold under ${price(limit)} — the price you typed is the floor.`
            : chaseOn
              ? `Starts at the ask and walks toward the bid over ${chaseSec} second${chaseSec === 1 ? '' : 's'}, never past it.`
              : 'Rests at the ask and never crosses — only the window ends it.'}
        </p>

        <div className="mt-2">
          <Checkbox
            checked={chaseOn}
            onChange={(e) => setChaseOn(e.target.checked)}
            label={
              <span className="flex flex-wrap items-center gap-1.5">
                <span>If not filled, sell at bid after</span>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="seconds before selling at the bid"
                  value={chaseSec}
                  onClick={(e) => e.preventDefault()}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/[^0-9]/g, ''));
                    setChaseSec(Math.max(1, Math.min(ADD_CHASE_MAX_SEC, n || 1)));
                  }}
                  disabled={!chaseOn}
                  className={cn(
                    'h-6 w-12 rounded border border-border bg-muted px-1 text-center',
                    'font-[inherit] text-[12px] tabular-nums text-foreground outline-none',
                    'focus-visible:border-[var(--accent)] disabled:opacity-50',
                  )}
                />
                <span>sec</span>
              </span>
            }
          />
          {/*
            What the walk will actually do, from the book the server just read.
            A typed price is also the floor, so "sell at bid after 5 sec" over a
            price at or above the ask asks for a crossing the price forbids --
            on 18 September that left an add resting at 20.00 with the bid at
            19.00 for an hour. It says so here, before the order is sent.
          */}
          <p className={cn('m-0 pl-[26px] text-[11.5px] leading-snug', deadWalk ? 'text-[var(--warn)]' : 'text-muted-foreground')}>
            {!chaseOn
              ? 'Left at the ask until it fills or the window ends.'
              : deadWalk
                ? `Nothing to walk to: ${price(preview!.startPrice)} is also the floor`
                  + `${preview?.bid != null ? `, and the bid is ${price(preview.bid)}` : ''}. `
                  + 'Leave the price blank, or set it under the ask, for it to cross.'
                : preview
                  ? `Walks ${price(preview.startPrice)} → ${price(preview.floorPrice)} over `
                    + `${chaseSec} second${chaseSec === 1 ? '' : 's'}, and never under ${price(preview.floorPrice)}.`
                  : `Walks from the ask toward the bid over ${chaseSec} second${chaseSec === 1 ? '' : 's'}`
                    + `${limit !== null && limit > 0 ? `, and never under $${price(limit)}` : ', never past the bid'}.`}
          </p>
        </div>

        {/* Wraps: on a narrow sheet the box and four chips do not share a line. */}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-[0.6px] text-muted-foreground">
            Works for · minutes
            <Input
              aria-label="how long the add works for"
              inputMode="numeric"
              value={windowMin}
              onChange={(e) => setWindowMin(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-1.5 pb-0.5">
            {ADD_WINDOWS.map(([label, n]) => (
              <Button
                key={label}
                type="button"
                variant="outline"
                aria-pressed={windowOk && minutes === n}
                className={cn('h-10 px-3 text-[12px]', windowOk && minutes === n && 'border-foreground text-foreground')}
                onClick={() => setWindowMin(String(n))}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
          {windowOk
            ? `Rests until it fills or ${describeWindow(minutes)} passes, then whatever is left is cancelled. `
              + 'It can be stopped from the position card before that.'
            : <span className="text-[var(--down)]">A window of more than 0 and at most {ADD_WINDOW_MAX_MIN} minutes.</span>}
        </p>

        {/*
          Priced in money, from the server's own arithmetic. "425 lots" reads
          fine; "$1,820 of margin against a $228 account" is the number the
          decision turns on, and it is only known once the gates have run.
        */}
        {draft && (
          <dl
            aria-label="what this add does"
            className="m-0 mt-3 grid gap-1 rounded-lg bg-muted px-2.5 py-2 text-[12px]"
          >
            <KV label="Starts at">{checking ? '…' : price(preview?.startPrice)}</KV>
            <KV label="Position after">
              {preview?.newSize != null
                ? `${fmtSize(preview.newSize)} @ ${price(preview.newAvgPrice)} avg`
                : '—'}
            </KV>
            <KV label="Premium collected" hint="Credit for the added contracts, before charges.">
              {preview?.creditUsd != null ? `${inr(usdToInr(preview.creditUsd))} · ${usd(preview.creditUsd)}` : '—'}
            </KV>
            <KV label="Charges to open" hint="Delta's fee plus 18% GST, by the statement's own formula.">
              {preview?.entryChargesUsd != null ? inr(usdToInr(preview.entryChargesUsd)) : '—'}
            </KV>
            <KV label="Margin held" hint="What the exchange will hold for the extra contracts.">
              {preview?.marginUsd != null ? `${inr(usdToInr(preview.marginUsd))} · ${usd(preview.marginUsd)}` : '—'}
            </KV>
          </dl>
        )}

        {blocked && (
          <ul aria-label="why not" className="m-0 mt-2 list-none p-0 text-[11.5px] leading-snug text-[var(--down)]">
            {(preview!.failures.length ? preview!.failures.map((f) => f.message) : [preview!.reason ?? 'Refused.'])
              .map((m) => <li key={m}>{m}</li>)}
          </ul>
        )}
        {failed && <p className="m-0 mt-2 text-[12px] text-[var(--down)]">{failed}</p>}

        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          The target and stop already on this position are resized to cover the whole of it once
          the add fills.
        </p>

        <SheetFooter>
          <Button variant="outline" className="h-11 flex-none px-4" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <SwipeToConfirm
            className="min-w-0 flex-1"
            tone="up"
            label={draft ? `Swipe to add ${fmtSize(lotsN)}` : 'Swipe to add'}
            busyLabel="Sending…"
            disabledLabel={checking ? 'Checking…' : blocked ? "Can't add" : !windowOk ? 'Check the window' : 'Enter lots'}
            disabled={!canSend}
            onConfirm={send}
          />
          {checking && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
