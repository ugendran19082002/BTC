import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Minus, Plus, Zap } from 'lucide-react';
import { placeOrder, previewOrder } from '@/api/trade';
import type { OrderDraft, PlaceResult, Preview } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Select, SelectItem } from '@/components/ui/select';
import { ExitBars } from '@/components/trade/ExitBars';
import { usePersisted } from '@/hooks/usePersisted';
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
  const [leverage, setLeverage] = usePersisted('order:leverage', defaultLeverage);
  // The exits are a habit, not a per-trade decision, so they carry over between
  // tickets. Zero -- off -- is the default until you move them once.
  // Both off until you tick them, and the choice carries between tickets: the
  // exits are a habit rather than a per-trade decision.
  const [targetOn, setTargetOn] = usePersisted('exit:targetOn', false);
  const [stopOn, setStopOn] = usePersisted('exit:stopOn', false);
  const [targetPct, setTargetPct] = usePersisted('exit:targetPct', 0.8);
  const [stopPct, setStopPct] = usePersisted('exit:stopPct', 1.5);
  const [mode, setMode] = useState<PriceMode>('market');
  const [custom, setCustom] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<PlaceResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // A fresh contract is a fresh ticket. Carrying the last one's size over is
  // how you sell ten lots of something you meant to sell one of.
  useEffect(() => {
    if (!seed) return;
    setLots(Math.max(1, seed.lots ?? 1));
    // The offer, not the market. Selling at the bid gives away the spread on
    // every trade; on a $16 option that spread is a tenth of the premium.
    setMode(seed.ask !== null ? 'ask' : 'market');
    setCustom('');
    setResult(null);
    setFailed(null);
    setPreview(null);
  }, [seed?.symbol]);

  const limitPrice = useMemo(() => {
    if (!seed) return null;
    switch (mode) {
      case 'market': return null;                       // take the book
      case 'bid': return seed.bid;
      case 'ask': return seed.ask;
      case 'custom': {
        const n = Number(custom);
        return Number.isFinite(n) && n > 0 ? n : null;
      }
    }
  }, [mode, custom, seed?.bid, seed?.ask]);

  const draft: OrderDraft | null = useMemo(
    () => seed && {
      symbol: seed.symbol, side: seed.side, strike: seed.strike,
      expiryTs: seed.expiryTs, lots, limitPrice, leverage,
      takeProfitPct: targetOn ? targetPct : 0,
      stopLossPct: stopOn ? stopPct : 0,
    },
    [seed, lots, limitPrice, leverage, targetPct, stopPct, targetOn, stopOn],
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

  const working = limitPrice ?? preview?.quote?.bid ?? seed.bid;
  // A quoted price is dollars per BTC and a contract is 0.001 of one, so the
  // fallback has to carry the contract size or it reads a thousand times high.
  const credit =
    preview?.creditUsd ?? (working !== null ? working * lots * (preview?.contractValue ?? 0.001) : null);
  const blocked = preview !== null && !preview.ok;
  const canSend = !!preview?.ok && !placing && !checking;
  // A cap of zero is not a cap, it is a missing answer -- and clamping to it
  // pinned the size at zero and made the plus button do nothing. An unknown
  // balance must not decide the size; the server refuses the order anyway if
  // there is really no margin, and it says so in words.
  const cap = maxLotsProp ?? preview?.maxLots ?? null;
  const maxLots = cap !== null && cap > 0 ? cap : Number.MAX_SAFE_INTEGER;
  const capKnown = cap !== null && cap > 0;
  // How far the option can rise before the exchange closes the position, as a
  // multiple of what it was sold for. This is the number leverage actually moves.
  const room =
    preview?.liquidationPrice != null && working
      ? preview.liquidationPrice / working
      : null;

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
          <Placed result={result} onDone={() => onOpenChange(false)} />
        ) : (
          <>
            <BookStrip bid={seed.bid} mark={seed.mark} ask={seed.ask} mode={mode} onPick={setMode} />

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
                {mode === 'bid' && `Rests at ${price(seed.bid)}. Fills as soon as anyone takes it.`}
                {mode === 'ask' && `Rests at ${price(seed.ask)}. Earns most, may not fill at all.`}
                {mode === 'custom' && 'Your own price. Rounded to the tick before it is sent.'}
              </p>
              {mode === 'custom' && (
                <Input
                  className="mt-2"
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  placeholder={price(seed.mark)}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  aria-label="limit price"
                />
              )}
            </div>

            <div className="mt-3.5">
              <Label>lots</Label>
              <div className="mt-1 flex items-center gap-2">
                <Stepper onClick={() => setLots((n) => Math.max(1, n - 1))} disabled={lots <= 1} label="one fewer lot">
                  <Minus className="h-4 w-4" />
                </Stepper>
                <Input
                  className="flex-1 text-center text-[16px] font-semibold"
                  type="number"
                  inputMode="numeric"
                  value={lots}
                  onChange={(e) => setLots(Math.max(1, Math.min(maxLots, Math.floor(Number(e.target.value) || 1))))}
                  aria-label="lots"
                />
                <Stepper onClick={() => setLots((n) => Math.min(maxLots, n + 1))} disabled={lots >= maxLots} label="one more lot">
                  <Plus className="h-4 w-4" />
                </Stepper>
              </div>
              {/* only worth showing when there is more than one choice to make */}
              <div className={cn('mt-1.5 flex gap-1.5', capKnown && cap! <= 1 && 'hidden')}>
                {[1, 5, 10, 25, ...(capKnown ? [cap!] : [])]
                  .filter((n, i, a) => n >= 1 && a.indexOf(n) === i && n <= maxLots)
                  .map((n) => (
                  <button
                    key={n}
                    onClick={() => setLots(n)}
                    className={cn(
                      'flex-1 cursor-pointer appearance-none rounded-md border border-border bg-muted py-1',
                      'font-[inherit] text-[11.5px] text-muted-foreground hover:text-foreground',
                      lots === n && 'border-[var(--accent)] text-foreground',
                    )}
                  >
                    {capKnown && n === cap ? 'max' : n}
                  </button>
                ))}
              </div>
              {capKnown && (
                <p className="m-0 mt-1 text-[11px] text-muted-foreground">
                  {balanceUsd !== null && <>{usd(balanceUsd)} available — </>}
                  {cap} lot{cap === 1 ? '' : 's'} at {leverage}x.
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
              <Line label="you receive" value={usd(credit)} strong />
              <Line
                label={`margin held at ${leverage}x`}
                value={usd(preview?.marginUsd)}
                hint="Delta calls this Funds req. It is locked while the position is open and returned when it closes."
              />
              <Line
                label="closed out if it reaches"
                value={price(preview?.liquidationPrice)}
                tone={room !== null && room < 2 ? 'down' : undefined}
                hint="Where the exchange buys the position back whether you want it to or not. Lower leverage moves this further away."
              />
              <Line
                label={stopOn && stopPct > 0 ? 'most you can lose' : 'most you can lose, with no stop'}
                value={preview?.worstCaseLossUsd != null ? signedUsd(-preview.worstCaseLossUsd) : '—'}
                tone="down"
              />
            </dl>

            {blocked && (
              <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 rounded-lg border border-[var(--down)]/40 bg-[var(--down)]/10 p-2.5 pl-2.5">
                {preview!.failures.map((f) => (
                  <li key={f.code} className="flex gap-1.5 text-[12px] leading-snug text-[var(--down)]">
                    <AlertTriangle className="mt-[1px] h-3.5 w-3.5 flex-none" />
                    <span>{f.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {failed && <p className="m-0 mt-3 text-[12px] text-[var(--down)]">{failed}</p>}

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
        'flex h-9 w-11 flex-none cursor-pointer appearance-none items-center justify-center',
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
  const cell = 'flex flex-1 cursor-pointer appearance-none flex-col items-center gap-0.5 border-0 bg-transparent py-2 font-[inherit]';
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

function Placed({ result, onDone }: { result: PlaceResult; onDone: () => void }) {
  const t = result.trade;
  const ok = result.ok;
  return (
    <div className="py-2">
      <div
        className={cn(
          'rounded-lg border p-3',
          ok ? 'border-[var(--up)]/40 bg-[var(--up)]/10' : 'border-[var(--down)]/40 bg-[var(--down)]/10',
        )}
      >
        <p className={cn('m-0 text-[14px] font-semibold', ok ? 'text-[var(--up)]' : 'text-[var(--down)]')}>
          {ok
            ? t.position !== 0
              ? `Sold ${Math.abs(t.position)} at ${price(t.entryAvgPrice)}`
              : 'Order is working'
            : 'Not sent'}
        </p>
        {!ok && (
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            {result.failures.map((f) => (
              <li key={f.code} className="text-[12px] text-[var(--down)]">{f.message}</li>
            ))}
          </ul>
        )}
        {ok && t.note && <p className="m-0 mt-1 text-[12px] text-muted-foreground">{t.note}</p>}
      </div>
      {result.mode === 'paper' && (
        <p className="m-0 mt-2.5 text-[12px] text-[var(--warn)]">
          Paper. Nothing reached the exchange.
        </p>
      )}
      <SheetFooter>
        <Button className="h-11 flex-1" onClick={onDone}>done</Button>
      </SheetFooter>
    </div>
  );
}
