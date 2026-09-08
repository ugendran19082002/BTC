import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Minus, Plus, Zap } from 'lucide-react';
import { getTradeQuote, placeOrder, previewOrder } from '@/api/trade';
import type { OrderDraft, PlaceResult, Preview } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Select, SelectItem } from '@/components/ui/select';
import { ExitBars } from '@/components/trade/ExitBars';
import { Checkbox } from '@/components/ui/checkbox';
import { usePersisted } from '@/hooks/usePersisted';
import { usePoll } from '@/hooks/usePoll';
import { countdown, price, signedUsd, strike, usd } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The order ticket.
 *
 * It is built around one idea: you should know whether the order will be
 * refused before you reach for the button, not after. Every keystroke re-runs
 * the server's own gates through /preview, so the button is either live and
 * says what it will do, or it is dead and says why.
 *
 * The price defaults to the market. Selling at the offer earns more and may not
 * fill; selling at the bid fills now. Both are one tap away and the ticket says
 * which is which rather than making you know.
 */

export type TicketSeed = {
  symbol: string;
  side: 'CE' | 'PE';
  strike: number;
  expiryTs: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  /** Lots the desk suggested, if this came from a recommendation. */
  lots?: number;
};

type PriceMode = 'market' | 'bid' | 'ask' | 'custom';

/** A ceiling to stop a stray keystroke, not a risk limit. The gates do that. */
const MAX_LOTS = 100_000;

/** The rungs Delta's own app offers. */
const LEVERAGE_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, 150, 200];

/**
 * Above this the close-out is close enough that the note beside the bar stops
 * being informational and starts being a warning. It is not a block: 200x is
 * the default and what the exchange app itself uses.
 */
const LOUD_LEVERAGE = 100;

export function OrderTicket({
  seed, open, onOpenChange, maxLots: maxLotsProp, onPlaced, defaultLeverage = 200, balanceUsd = null,
}: {
  seed: TicketSeed | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  maxLots?: number;
  onPlaced?: (r: PlaceResult) => void;
  defaultLeverage?: number;
  /** Shown beside the size, so "1 lot" has a reason next to it. */
  balanceUsd?: number | null;
}) {
  const [lots, setLots] = useState(1);
  /**
   * What is actually in the box while you are typing.
   *
   * The size has to be a number, but a half-typed number is a string -- and
   * clamping every keystroke to at least 1 meant backspace did nothing and the
   * field could never be cleared to type a new value. So the text is free while
   * the field has focus and is settled on blur.
   */
  const [lotsText, setLotsText] = useState('1');
  const [leverage, setLeverage] = usePersisted('order:leverage', defaultLeverage);
  // The exits are a habit, not a per-trade decision, so they carry over between
  // tickets. Zero -- off -- is the default until you move them once.
  // Both off until you tick them, and the choice carries between tickets: the
  // exits are a habit rather than a per-trade decision.
  const [targetOn, setTargetOn] = usePersisted('exit:targetOn', false);
  const [stopOn, setStopOn] = usePersisted('exit:stopOn', false);
  const [targetPct, setTargetPct] = usePersisted('exit:targetPct', 0.8);
  const [stopPct, setStopPct] = usePersisted('exit:stopPct', 1.5);
  // "Convert to Market After", the way every options desk words it: rest at the
  // offer, and if nobody has taken it in this long, cross and pay the spread.
  const [convertOn, setConvertOn] = usePersisted('entry:convertOn', false);
  const [convertSec, setConvertSec] = usePersisted('entry:convertSec', 30);
  const [mode, setMode] = useState<PriceMode>('market');
  const [custom, setCustom] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<PlaceResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * The book, live, while the ticket is open.
   *
   * The seed is whatever the chain last fetched, which can be five seconds old
   * by the time you have tapped it -- and a ticket that shows a price you can
   * no longer get is worse than one that shows none. Polled at a second, and
   * the server caches it for just under that.
   */
  const { data: fresh } = usePoll(
    () => getTradeQuote(seed!.symbol),
    1_000,
    { enabled: open && !!seed && !result, deps: [seed?.symbol] },
  );
  const book = {
    bid: fresh?.quote?.bid ?? seed?.bid ?? null,
    ask: fresh?.quote?.ask ?? seed?.ask ?? null,
    mark: fresh?.quote?.mark ?? seed?.mark ?? null,
  };

  /**
   * Every opening is a fresh ticket.
   *
   * Keyed on `open` as well as the contract, because keying on the contract
   * alone left the last order's result on screen when the sheet was opened
   * again -- tapping the same strike twice never changed the symbol, so nothing
   * reset, and you were looking at "Sold 1 at 33.00" over a ticket you had not
   * placed. Carrying the last one's size over is the same class of mistake:
   * it is how you sell ten lots of something you meant to sell one of.
   */
  useEffect(() => {
    if (!seed || !open) return;
    const start = Math.max(1, seed.lots ?? 1);
    setLots(start);
    setLotsText(String(start));
    // The offer, not the market. Selling at the bid gives away the spread on
    // every trade; on a $16 option that spread is a tenth of the premium.
    setMode(seed.ask !== null ? 'ask' : 'market');
    setCustom('');
    setResult(null);
    setFailed(null);
    setPreview(null);
  }, [seed?.symbol, open]);

  /**
   * Does this order sit on the book, or is it taken at once?
   *
   * A limit at or below the bid is lifted immediately and pays the spread; one
   * above it waits. Only a waiting order has anything to convert.
   */
  const rests = useMemo(() => {
    if (mode === 'market' || mode === 'bid') return false;
    if (!book.bid) return true;
    const p = mode === 'ask' ? book.ask : Number(custom);
    return p !== null && Number.isFinite(p) && p > book.bid;
  }, [mode, custom, book.bid, book.ask]);

  const limitPrice = useMemo(() => {
    if (!seed) return null;
    switch (mode) {
      case 'market': return null;                       // take the book
      case 'bid': return book.bid;
      case 'ask': return book.ask;
      case 'custom': {
        const n = Number(custom);
        return Number.isFinite(n) && n > 0 ? n : null;
      }
    }
  }, [mode, custom, book.bid, book.ask]);

  const draft: OrderDraft | null = useMemo(
    () => seed && {
      symbol: seed.symbol, side: seed.side, strike: seed.strike,
      expiryTs: seed.expiryTs, lots, limitPrice, leverage,
      takeProfitPct: targetOn ? targetPct : 0,
      stopLossPct: stopOn ? stopPct : 0,
      // Meaningless on an order that crosses immediately, so it is not sent.
      convertToMarketAfterSec: rests && convertOn ? convertSec : 0,
    },
    [seed, lots, limitPrice, leverage, targetPct, stopPct, targetOn, stopOn, rests, convertOn, convertSec],
  );

  // Debounced, because typing a price should not be a request per keystroke.
  useEffect(() => {
    if (!open || !draft) return;
    let alive = true;
    setChecking(true);
    const id = setTimeout(() => {
      previewOrder(draft)
        .then((p) => { if (alive) { setPreview(p); setFailed(null); } })
        .catch((e: Error) => { if (alive) setFailed(e.message); })
        .finally(() => { if (alive) setChecking(false); });
    }, 220);
    return () => { alive = false; clearTimeout(id); };
  }, [open, draft]);

  const submit = useCallback(async () => {
    if (!draft || placing) return;
    setPlacing(true);
    try {
      const r = await placeOrder(draft);
      setResult(r);
      onPlaced?.(r);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setPlacing(false);
    }
  }, [draft, placing, onPlaced]);

  if (!seed) return null;

  const working = limitPrice ?? book.bid;
  // A quoted price is dollars per BTC and a contract is 0.001 of one, so the
  // fallback has to carry the contract size or it reads a thousand times high.
  const credit =
    preview?.creditUsd ?? (working !== null ? working * lots * (preview?.contractValue ?? 0.001) : null);
  const blocked = preview !== null && !preview.ok;
  const canSend = !!preview?.ok && !placing && !checking;
  /**
   * What the balance covers -- shown, never enforced.
   *
   * Clamping the field to it made the plus button dead the moment the account
   * was small, which is exactly when you most want to see what a bigger size
   * would cost. Delta's own ticket lets you type any size and then says
   * "Insufficient Balance", and that is the better shape: the size is yours to
   * choose, the refusal comes from the gates, in words, with the number in it.
   */
  const cap = maxLotsProp ?? preview?.maxLots ?? null;
  const capKnown = cap !== null && cap > 0;
  const overCap = capKnown && lots > cap!;

  /** Keep the number and the text in the box in step. */
  const setSize = (n: number) => {
    const next = Math.max(1, Math.min(MAX_LOTS, Math.floor(n)));
    setLots(next);
    setLotsText(String(next));
  };
  const step = (by: number) => setSize(lots + by);
  // How far the option can rise before the exchange closes the position, as a
  // multiple of what it was sold for. This is the number leverage actually moves.
  const room =
    preview?.liquidationPrice != null && working
      ? preview.liquidationPrice / working
      : null;
  /** Not enough free margin for the size asked for. Both lines go red together. */
  const short =
    preview?.marginUsd != null && balanceUsd !== null && preview.marginUsd > balanceUsd;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={`Sell ${strike(seed.strike)} ${seed.side}`}
        description={
          preview?.product
            ? `${countdown(preview.product.expiryTs * 1000)} · ${preview.mode === 'live' ? 'real money' : 'paper'}`
            : undefined
        }
      >
        {result ? (
          <Placed
            result={result}
            onDone={() => onOpenChange(false)}
            working={working}
            lots={lots}
          />
        ) : (
          <>
            <BookStrip bid={book.bid} mark={book.mark} ask={book.ask} mode={mode} onPick={setMode} />

            <div className="mt-3.5">
              <Label>price</Label>
              <ToggleGroup
                type="single"
                value={mode}
                onValueChange={(v) => v && setMode(v as PriceMode)}
                className="mt-1 flex w-full"
              >
                <ToggleGroupItem value="market">market</ToggleGroupItem>
                <ToggleGroupItem value="bid">bid</ToggleGroupItem>
                <ToggleGroupItem value="ask">ask</ToggleGroupItem>
                <ToggleGroupItem value="custom">set</ToggleGroupItem>
              </ToggleGroup>
              <p className="m-0 mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                {mode === 'market' && 'Sells straight into the bid. Fills now, earns least.'}
                {mode === 'bid' && `Rests at ${price(book.bid)}. Fills as soon as anyone takes it.`}
                {mode === 'ask' && `Rests at ${price(book.ask)}. Earns most, may not fill at all.`}
                {mode === 'custom' && 'Your own price. Rounded to the tick before it is sent.'}
              </p>
              {mode === 'custom' && (
                <Input
                  className="mt-2"
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  placeholder={price(book.mark)}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  aria-label="limit price"
                />
              )}

              {rests && (
                <div className="mt-2">
                  <Checkbox
                    checked={convertOn}
                    onChange={(e) => setConvertOn(e.target.checked)}
                    label={
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span>if it has not filled, cross after</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label="seconds before crossing"
                          value={convertSec}
                          onClick={(e) => e.preventDefault()}
                          onChange={(e) => {
                            const n = Number(e.target.value.replace(/[^0-9]/g, ''));
                            setConvertSec(Math.max(1, Math.min(600, n || 1)));
                          }}
                          disabled={!convertOn}
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
                  <p className="m-0 pl-[26px] text-[11.5px] leading-snug text-muted-foreground">
                    {convertOn
                      ? `Waits ${convertSec}s at ${price(limitPrice)}, then takes the bid and pays the spread.`
                      : 'Without it the order waits for as long as it takes.'}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-3.5">
              <Label>lots</Label>
              <div className="mt-1 flex items-center gap-2">
                <Stepper onClick={() => step(-1)} disabled={lots <= 1} label="one fewer lot">
                  <Minus className="h-4 w-4" />
                </Stepper>
                <Input
                  className="flex-1 text-center text-[16px] font-semibold"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={lotsText}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/[^0-9]/g, '');
                    setLotsText(digits);
                    const n = Number(digits);
                    if (digits !== '' && n >= 1) setLots(Math.min(MAX_LOTS, n));
                  }}
                  onBlur={() => setLotsText(String(lots))}
                  aria-label="lots"
                />
                <Stepper onClick={() => step(1)} disabled={lots >= MAX_LOTS} label="one more lot">
                  <Plus className="h-4 w-4" />
                </Stepper>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                {[1, 5, 10, 25].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-label={`add ${n} lot${n === 1 ? '' : 's'}`}
                    onClick={() => step(n)}
                    className={cn(
                      'flex-1 appearance-none rounded-md border border-border bg-muted py-1',
                      'font-[inherit] text-[11.5px] text-muted-foreground hover:border-[var(--accent)] hover:text-foreground',
                    )}
                  >
                    +{n}
                  </button>
                ))}
                {capKnown && (
                  <button
                    type="button"
                    aria-label="as many lots as the balance covers"
                    onClick={() => setSize(cap!)}
                    className={cn(
                      'flex-1 appearance-none rounded-md border border-border bg-muted py-1',
                      'font-[inherit] text-[11.5px] text-muted-foreground hover:border-[var(--accent)] hover:text-foreground',
                      lots === cap && 'border-[var(--accent)] text-foreground',
                    )}
                  >
                    max
                  </button>
                )}
              </div>
              {capKnown && (
                <p className={cn('m-0 mt-1 text-[11px]', overCap ? 'text-[var(--warn)]' : 'text-muted-foreground')}>
                  {balanceUsd !== null && <>{usd(balanceUsd)} available — </>}
                  {cap} lot{cap === 1 ? '' : 's'} at {leverage}x
                  {overCap && <> · {lots} needs more margin than that</>}
                </p>
              )}
            </div>

            <div className="mt-3.5">
              <Label>leverage</Label>
              <div className="mt-1">
                <Select ariaLabel="leverage" value={String(leverage)} onValueChange={(v) => setLeverage(Number(v))}>
                  {LEVERAGE_STEPS.map((n) => (
                    <SelectItem
                      key={n}
                      value={String(n)}
                      hint={n >= LOUD_LEVERAGE ? 'little room before the close-out' : undefined}
                    >
                      {n}x
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <LeverageNote leverage={leverage} room={room} liquidation={preview?.liquidationPrice ?? null} />
            </div>

            <Separator className="my-3.5" />

            <ExitBars
              entry={working}
              size={preview?.size ?? lots}
              contractValue={preview?.contractValue ?? 0.001}
              targetOn={targetOn}
              stopOn={stopOn}
              onTargetOn={setTargetOn}
              onStopOn={setStopOn}
              targetPct={targetPct}
              stopPct={stopPct}
              onTargetPct={setTargetPct}
              onStopPct={setStopPct}
              liquidationPrice={preview?.liquidationPrice ?? null}
            />

            <Separator className="my-3" />

            <dl className="m-0 grid gap-1.5">
              <Line label="you get" value={usd(credit)} strong tone="up" />
              <Line
                label="margin needed"
                value={usd(preview?.marginUsd)}
                hint={`Delta calls this "Funds req." It is held while the position is open and given back when it closes.`}
                tone={short ? 'down' : undefined}
              />
              <Line
                label="available margin"
                value={usd(balanceUsd)}
                hint={`What is free in the account right now. Delta calls this "Available Margin".`}
                tone={short ? 'down' : undefined}
              />
              <Line
                label="they close you at"
                value={price(preview?.liquidationPrice)}
                tone={room !== null && room < 2 ? 'down' : undefined}
                hint="The price at which the exchange buys your position back, whether you want it to or not. Lower leverage moves this further away."
              />
              <Line
                label={stopOn && stopPct > 0 ? 'worst case' : 'worst case, no stop'}
                value={preview?.worstCaseLossUsd != null ? signedUsd(-preview.worstCaseLossUsd) : '—'}
                tone="down"
                hint={
                  stopOn && stopPct > 0
                    ? 'What the stop costs you if it fires.'
                    : 'With no stop, the position ends where the exchange closes it. That is the cap.'
                }
              />
            </dl>

            {/*
              Stuck to the bottom, with the button.
              These sat under a summary long enough to push them off screen, so
              the button was dead and the reason for it was a scroll away --
              which is the same as not saying anything.
            */}
            {(blocked || failed) && (
              <div className="sticky bottom-[60px] z-10 -mx-4 mt-3 border-t border-[var(--down)]/30 bg-[var(--down-bg)] px-4 py-2.5">
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {preview?.failures.map((f) => (
                    <li key={f.code} className="flex gap-1.5 text-[12px] leading-snug text-[var(--down)]">
                      <AlertTriangle className="mt-[1px] h-3.5 w-3.5 flex-none" />
                      <span>{f.message}</span>
                    </li>
                  ))}
                  {failed && (
                    <li className="flex gap-1.5 text-[12px] leading-snug text-[var(--down)]">
                      <AlertTriangle className="mt-[1px] h-3.5 w-3.5 flex-none" />
                      <span>{failed}</span>
                    </li>
                  )}
                </ul>
              </div>
            )}

            <SheetFooter>
              <Button variant="outline" className="h-11 flex-none px-4" onClick={() => onOpenChange(false)}>
                cancel
              </Button>
              <button
                onClick={() => void submit()}
                disabled={!canSend}
                className={cn(
                  'flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg',
                  'appearance-none border-0 font-[inherit] text-[14px] font-semibold',
                  'bg-[var(--down)] text-white transition-opacity hover:opacity-90',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {placing || checking ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {placing ? 'sending' : blocked ? 'cannot sell' : `Sell · ${usd(credit)}`}
              </button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * What this leverage buys and what it costs, in one line.
 *
 * Leverage does not change what a sold option can lose -- that is the same at
 * 1x and at 200x. It changes how far the option can move before the exchange
 * closes you out, and that is what this says, in the option's own prices.
 */
function LeverageNote({ leverage, room, liquidation }: {
  leverage: number; room: number | null; liquidation: number | null;
}) {
  const loud = leverage >= LOUD_LEVERAGE;
  return (
    <p
      className={cn(
        'm-0 mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug',
        loud ? 'text-[var(--warn)]' : 'text-muted-foreground',
      )}
    >
      {loud && <Zap className="mt-[2px] h-3.5 w-3.5 flex-none" />}
      <span>
        {liquidation === null || room === null ? (
          <>Sets the margin held, and how far this can move before it is closed out.</>
        ) : (
          <>
            Closed out at <b className="tabular-nums">{price(liquidation)}</b> — a{' '}
            <b>{((room - 1) * 100).toFixed(0)}%</b> move.{' '}
            {loud
              ? 'Lower leverage holds more margin and gives the trade more room.'
              : 'You lose the same either way; leverage only moves this line.'}
          </>
        )}
      </span>
    </p>
  );
}

function Stepper({ children, onClick, disabled, label }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-9 w-11 flex-none appearance-none items-center justify-center',
        'rounded-md border border-border bg-muted p-0 text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/** Bid, mark and offer as three tappable prices — the fastest way to set one. */
function BookStrip({ bid, mark, ask, mode, onPick }: {
  bid: number | null; mark: number | null; ask: number | null;
  mode: PriceMode; onPick: (m: PriceMode) => void;
}) {
  const cell = 'flex flex-1 appearance-none flex-col items-center gap-0.5 border-0 bg-transparent py-2 font-[inherit]';
  return (
    <div className="flex overflow-hidden rounded-lg border border-border bg-muted">
      <button className={cn(cell, mode === 'bid' && 'bg-background')} onClick={() => onPick('bid')}>
        <span className="text-[10px] uppercase tracking-[0.6px] text-muted-foreground">bid</span>
        <span className="text-[15px] font-semibold tabular-nums text-[var(--down)]">{price(bid)}</span>
      </button>
      <div className={cn(cell, 'pointer-events-none')}>
        <span className="text-[10px] uppercase tracking-[0.6px] text-muted-foreground">mark</span>
        <span className="text-[15px] font-semibold tabular-nums text-foreground">{price(mark)}</span>
      </div>
      <button className={cn(cell, mode === 'ask' && 'bg-background')} onClick={() => onPick('ask')}>
        <span className="text-[10px] uppercase tracking-[0.6px] text-muted-foreground">ask</span>
        <span className="text-[15px] font-semibold tabular-nums text-[var(--up)]">{price(ask)}</span>
      </button>
    </div>
  );
}

function Line({ label, value, strong, tone, hint }: {
  label: string; value: string; strong?: boolean; tone?: 'up' | 'down'; hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt
        className={cn('m-0 text-[12.5px] text-muted-foreground', hint && 'cursor-help underline decoration-dotted underline-offset-2')}
        title={hint}
      >
        {label}
      </dt>
      <dd
        className={cn(
          'm-0 tabular-nums',
          strong ? 'text-[16px] font-semibold text-foreground' : 'text-[13px] text-foreground',
          tone === 'down' && 'text-[var(--down)]',
          tone === 'up' && 'text-[var(--up)]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * What happened, after the button.
 *
 * Three outcomes and they are not the same thing, so they do not read the same:
 * filled (you are short, at this price), working (the order is on the book and
 * has not traded), refused (nothing happened, here is why). "Order is working"
 * on its own left the most important question unanswered -- am I short or not.
 */
function Placed({ result, onDone, working, lots }: {
  result: PlaceResult;
  onDone: () => void;
  working: number | null;
  lots: number;
}) {
  const t = result.trade;
  const ok = result.ok;
  const filled = ok && t.position !== 0;
  const resting = ok && t.position === 0;

  return (
    <div className="py-1">
      <div
        className={cn(
          'rounded-lg border p-3',
          filled ? 'border-[var(--up)]/40 bg-[var(--up)]/10'
            : resting ? 'border-[var(--warn)]/40 bg-[var(--warn)]/10'
            : 'border-[var(--down)]/40 bg-[var(--down)]/10',
        )}
      >
        <p
          className={cn(
            'm-0 text-[15px] font-semibold',
            filled ? 'text-[var(--up)]' : resting ? 'text-[var(--warn)]' : 'text-[var(--down)]',
          )}
        >
          {filled ? `Sold ${Math.abs(t.position)} at ${price(t.entryAvgPrice)}`
            : resting ? 'Waiting on the book'
            : 'Nothing was sent'}
        </p>

        <p className="m-0 mt-1 text-[12.5px] leading-snug text-muted-foreground">
          {filled && <>You are short {Math.abs(t.position)} contract{Math.abs(t.position) === 1 ? '' : 's'}.</>}
          {resting && (
            <>
              {lots} lot{lots === 1 ? '' : 's'} offered at {price(working)}. Nothing has traded
              yet — it fills when someone takes it, and you are not short until then.
            </>
          )}
          {!ok && <>No position was opened and no margin was used.</>}
        </p>

        {!ok && (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {result.failures.map((f) => (
              <li key={f.code} className="text-[12.5px] leading-snug text-[var(--down)]">{f.message}</li>
            ))}
          </ul>
        )}
        {ok && t.note && <p className="m-0 mt-1.5 text-[12px] text-[var(--dim)]">{t.note}</p>}
      </div>

      {ok && (
        <p className="m-0 mt-2.5 text-[12px] text-muted-foreground">
          {resting ? 'It will appear under Positions the moment it fills.' : 'Watch it under Positions.'}
        </p>
      )}
      {result.mode === 'paper' && (
        <p className="m-0 mt-1.5 text-[12px] text-[var(--warn)]">
          Paper. Nothing reached the exchange.
        </p>
      )}

      <SheetFooter>
        {/* An acknowledgement, not an action. The loud button was the Sell one. */}
        <Button variant="outline" className="h-10 flex-1" onClick={onDone}>done</Button>
      </SheetFooter>
    </div>
  );
}
