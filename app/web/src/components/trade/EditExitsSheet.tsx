import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { updateExits } from '@/api/trade';
import type { Trade } from '@/types/trade';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ExitBars } from '@/components/trade/ExitBars';
import { Figure } from '@/components/ui/figure';
import { checkExits } from '@/lib/exit-checks';
import { exitAskOf, inputProblem, levelOf, type ExitInput } from '@/lib/exit-input';
import { MAX_EXIT_POINTS, MAX_STOP_PCT, MAX_TARGET_PCT } from '@/lib/strategy-exits';
import {
  contractLabel, price, signedInr, signedUsd, usdToInr,
} from '@/lib/format';

/**
 * Change the stop and the target on a position that is already on.
 *
 * The same exit boxes as the ticket, on purpose: the control that set these levels
 * and the control that moves them should not be two different things to learn.
 *
 * The percentages are read back off the position rather than starting from a
 * default, so opening this shows where the levels actually are instead of
 * where a fresh ticket would have put them.
 */
/** Keeps a reverse-computed value inside what the box accepts. */
const clampTo = (n: number, max: number) => Math.min(max, Math.max(0, Math.round(n * 10_000) / 10_000));
const OFF: ExitInput = { on: false, mode: 'pct', pct: 0.8, points: 10, price: 0 };

/**
 * The mode an exit was set in, from the plan: following the fill as a % or as
 * points, or -- a leg the plan does not follow -- a fixed price.
 */
function modeOf(ask: NonNullable<Trade['plan']>['exitAsk'] | null, leg: 'target' | 'stop', level: number | null): ExitInput['mode'] {
  // Nothing set yet has no mode of its own: a new exit starts as a percentage.
  if (level === null) return 'pct';
  const pct = leg === 'target' ? ask?.takeProfitPct : ask?.stopLossPct;
  const pts = leg === 'target' ? ask?.takeProfitPoints : ask?.stopLossPoints;
  if ((pts ?? 0) > 0) return 'points';
  if ((pct ?? 0) > 0) return 'pct';
  return 'price';
}

export function EditExitsSheet({ trade, open, onOpenChange, onSaved }: {
  trade: Trade | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: () => void;
}) {
  const entry = trade?.entryAvgPrice ?? null;
  const [target, setTarget] = useState<ExitInput>(OFF);
  const [stop, setStop] = useState<ExitInput>({ ...OFF, pct: 1.5 });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * Seed the boxes from the levels that are live, exactly once per opening.
   *
   * The trade object is replaced every second by the poll, so an effect that
   * depends on anything inside it re-runs while you are typing and puts the
   * number back where it started. Seeding is keyed on the opening itself, and a
   * ref makes that literal rather than a hope about dependency arrays: once the
   * form is seeded for this open, nothing reseeds it until it closes.
   */
  const seededFor = useRef<string | null>(null);

  // Closing clears the mark. As a cleanup rather than a branch, so React runs
  // it on unmount too and there is no path where the ref is left set.
  useEffect(() => {
    if (!open) return;
    return () => { seededFor.current = null; };
  }, [open]);

  useEffect(() => {
    if (!open || !trade || entry === null || entry <= 0) return;
    if (seededFor.current === trade.tradeId) return;
    seededFor.current = trade.tradeId;

    // The book first, the plan only as a fallback. The bar is a picture of the
    // levels that are live, so it has to start from the ones that are live --
    // seeding it from the plan showed −94% beside a book holding 25.10.
    const tp = trade.onBook?.target ?? trade.plan?.takeProfitPrice ?? null;
    const sl = trade.onBook?.stop ?? trade.plan?.stopPrice ?? null;
    // Both readings of each level are filled in, so either mode opens on the
    // price that is live: a target at 3.00 off 15 is 80% and 12 points alike.
    // Each exit opens in the terms it was set in -- a strategy's "stop at 70"
    // opens as Price 70, not as "+250%" -- so saving it unchanged changes nothing.
    const ask = trade.plan?.exitAsk ?? null;
    setTarget({
      ...OFF, on: tp !== null, mode: modeOf(ask, 'target', tp),
      ...(tp !== null ? { pct: clampTo(1 - tp / entry, MAX_TARGET_PCT), points: clampTo(entry - tp, MAX_EXIT_POINTS), price: tp } : {}),
    });
    setStop({
      ...OFF, pct: 1.5, on: sl !== null, mode: modeOf(ask, 'stop', sl),
      ...(sl !== null ? { pct: clampTo(sl / entry - 1, MAX_STOP_PCT), points: clampTo(sl - entry, MAX_EXIT_POINTS), price: sl } : {}),
    });
    setFailed(null);
  }, [open, trade, entry]);

  if (!trade) return null;

  // Read off the exchange, not off the plan. A panel headed "on the book now"
  // that reads the plan is simply wrong in the one case worth showing: when the
  // two disagree.
  const liveTarget = trade.onBook?.target ?? null;
  const liveStop = trade.onBook?.stop ?? null;
  const asked = trade.plan?.takeProfitPrice ?? null;
  const drifted = asked !== null && liveTarget !== null && Math.abs(asked - liveTarget) > 0.05;

  const mark = trade.live?.markPrice ?? null;
  const pnl = trade.live?.unrealisedPnl ?? null;

  /*
   * Where the mark is relative to the target being set.
   *
   * This is a short, so the target is below and the mark has to *fall* to reach
   * it. A positive number is how much further it has to go.
   */
  const wantedTarget = levelOf('target', target, entry);
  const toTarget = mark !== null && wantedTarget !== null ? mark - wantedTarget : null;

  /*
   * The levels being set, checked against the price right now.
   *
   * The shared rule rather than one written here, so the ticket and this sheet
   * cannot end up telling the same story two different ways. Nothing it finds
   * blocks the button: the desk closing a position at a level you asked it to
   * close at is the system working, and somebody may well mean it. It is said
   * before the button rather than discovered after it.
   */
  const wantedStop = levelOf('stop', stop, entry);
  const typedWrong = inputProblem('target', target, entry) ?? inputProblem('stop', stop, entry);
  const problems = checkExits({ mark, entry, targetPrice: wantedTarget, stopPrice: wantedStop });

  const save = async () => {
    setBusy(true);
    try {
      await updateExits(trade.tradeId, exitAskOf(target, stop));
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={`Edit exits · ${contractLabel(trade.symbol)}`}
        description={`Sold ${Math.abs(trade.position)} @ ${price(entry)}`}
      >
        {/*
          Where the position actually is, in the exchange's own numbers and in
          the same three words the positions card uses. Setting an exit without
          being able to see the price it is being set against is guesswork, and
          the trade object is refreshed by the poll, so these tick.
        */}
        <div className="mb-3 grid grid-cols-3 gap-2 rounded-lg bg-muted px-2.5 py-2">
          <Figure label="Price now" value={price(mark)} />
          <Figure
            label="P&L"
            value={signedInr(usdToInr(pnl))}
            second={signedUsd(pnl)}
            tone={pnl == null || pnl === 0 ? undefined : pnl > 0 ? 'up' : 'down'}
          />
          <Figure
            label="To target"
            // Points still to fall, as a plain number -- a signed one invites the
            // reader to work out which direction is good, and the answer differs
            // for a short.
            value={toTarget === null ? '—' : toTarget > 0 ? toTarget.toFixed(2) : 'reached'}
            tone={toTarget !== null && toTarget <= 0 ? 'up' : undefined}
            hint="How far the price still has to fall to reach the target."
          />
        </div>

        <ExitBars
          entry={entry}
          size={Math.abs(trade.position)}
          contractValue={0.001}
          target={target}
          stop={stop}
          onTarget={(p) => setTarget((x) => ({ ...x, ...p }))}
          onStop={(p) => setStop((x) => ({ ...x, ...p }))}
          liquidationPrice={trade.live?.liquidationPrice ?? null}
        />

        {/*
          What is on the book right now, in the exchange's own prices. Without
          it there is no way to tell whether a change landed -- the boxes show
          what you have asked for, which is not the same question.
        */}
        <dl className="m-0 mt-3 grid gap-1 rounded-lg bg-muted px-2.5 py-2 text-[12px]">
          <div className="flex justify-between gap-3">
            <dt className="m-0 text-muted-foreground">On Delta now · target</dt>
            <dd className="m-0 tabular-nums text-foreground">
              {liveTarget !== null ? price(liveTarget) : 'none'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="m-0 text-muted-foreground">On Delta now · stop</dt>
            <dd className="m-0 tabular-nums text-foreground">
              {liveStop !== null ? price(liveStop) : 'none'}
            </dd>
          </div>
        </dl>

        {problems.map((p) => (
          <p
            key={`${p.leg}-${p.kind}`}
            className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--warn)]"
          >
            {p.message}
          </p>
        ))}

        {drifted && (
          <p className="m-0 mt-2 text-[11.5px] leading-snug text-[var(--warn)]">
            You asked for {price(asked)} but Delta holds {price(liveTarget)}. Delta's order is what
            will fill — save again to bring them together.
          </p>
        )}
        <p className="m-0 mt-2 text-[11.5px] leading-snug text-muted-foreground">
          Orders are edited in place, so the position is never left without them.
        </p>
        {failed && <p className="m-0 mt-2 text-[12px] text-[var(--down)]">{failed}</p>}

        <SheetFooter>
          <Button variant="outline" className="h-11 flex-none px-4" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="h-11 flex-1" disabled={busy || typedWrong !== null} onClick={() => void save()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Save exits
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
