import { useEffect, useState } from 'react';
import { Check as CheckIcon, X, AlertTriangle } from 'lucide-react';
import type { Leg, SnapshotMeta } from '@/types/desk';
import { Sheet, SheetContent, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { KV } from '@/components/ui/kv';
import { Figure } from '@/components/ui/figure';
import { Badge } from '@/components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  price, signedUsd, signedInr, usd, usdToInr, strike as fmtStrike,
} from '@/lib/format';
import { TIER_LABEL, TIER_TONE, otmPct } from '@/lib/ev-view';
import { cn } from '@/lib/utils';

const dash = (v: number | null | undefined, f: (n: number) => string) =>
  v === null || v === undefined ? '—' : f(v);

/**
 * Everything known about one strike, on one screen, before any order exists.
 *
 * The board has to fit two dozen strikes across a phone, so it carries the four
 * columns you scan on. This is the other half: the distance, the odds, the
 * book, the money, and — the part the board cannot show — *which eligibility
 * rule each strike is failing and by how much*. A red Signal cell with no
 * reason behind it is a cell nobody can argue with.
 *
 * Selling from here goes through the same ticket as a tap on the board. This
 * sheet places nothing.
 */
export function StrikeAnalysis({
  legs,
  strike,
  side: initialSide,
  snap,
  open,
  onOpenChange,
  onSell,
}: {
  /** The whole board — the sheet finds this strike's two legs in it. */
  legs: Leg[];
  strike: number;
  /** Which side the tap came from. The other is one toggle away. */
  side: 'C' | 'P';
  snap: SnapshotMeta;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSell?: (leg: Leg) => void;
}) {
  /*
   * A strike is two contracts, and the board's centre cell belongs to both. So
   * the sheet opens on the side that was tapped and carries the other with it,
   * rather than making someone close it and find the opposite cell.
   */
  const [cp, setCp] = useState<'C' | 'P'>(initialSide);
  useEffect(() => { setCp(initialSide); }, [initialSide, strike]);

  const call = legs.find((l) => l.cp === 'C' && l.strike === strike) ?? null;
  const put = legs.find((l) => l.cp === 'P' && l.strike === strike) ?? null;
  const leg = (cp === 'C' ? call : put) ?? call ?? put;
  if (!leg) return null;

  const ev = leg.ev;
  const side = leg.cp === 'C' ? 'Call' : 'Put';
  const dist = otmPct(leg.strike, snap.spot);
  const mid = leg.bid !== null && leg.ask !== null ? (leg.bid + leg.ask) / 2 : leg.mark;
  const zero = leg.zero?.adjusted ?? null;
  const touch = leg.probs?.touch ?? null;
  /*
   * What a move of exactly one expected move costs, per contract.
   *
   * The stress test in miniature, and the one number here that is money rather
   * than a probability: BTC travels one expected move straight at this strike
   * and settles there. Zero when such a move does not reach the strike, which
   * is the answer for anything past 1.0 EM away -- and saying "nothing" is the
   * point of showing it beside a buffer of 1.88.
   */
  const atOneMove = (() => {
    const em = snap.expectedMove;
    if (em === null || !(em > 0)) return null;
    const settleAt = leg.cp === 'C' ? snap.spot + em : snap.spot - em;
    const intrinsic = leg.cp === 'C'
      ? Math.max(0, settleAt - leg.strike)
      : Math.max(0, leg.strike - settleAt);
    return intrinsic * 0.001;
  })();

  const blocks = ev.checks.filter((c) => c.severity === 'block');
  const warns = ev.checks.filter((c) => c.severity === 'warn');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={`${fmtStrike(strike)} · ${side.toLowerCase()}`}
        description={`${snap.expiry} · settles in ${snap.hoursToExpiry.toFixed(1)}h · sold naked, the way the tested strategy sells`}
      >
        {call && put && (
          <ToggleGroup
            type="single"
            value={cp}
            onValueChange={(v) => v && setCp(v as 'C' | 'P')}
            aria-label="side"
            className="mb-3 flex w-full"
          >
            <ToggleGroupItem value="C" className="flex-1">Call</ToggleGroupItem>
            <ToggleGroupItem value="P" className="flex-1">Put</ToggleGroupItem>
          </ToggleGroup>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TIER_TONE[ev.tier]}>{TIER_LABEL[ev.tier]}</Badge>
          {ev.score !== null && (
            <span className="text-[12px] tabular-nums text-muted-foreground">
              score <b className="text-foreground">{ev.score}</b>/100 against this board
            </span>
          )}
          <span className="basis-full text-[12px] text-muted-foreground">
            {ev.tier === 'avoid'
              ? 'A rule that matters is failing — see below.'
              : ev.signal === 'watch'
                ? 'Nothing hard is failing, but read the warnings.'
                : 'Every eligibility rule is clear.'}
          </span>
        </div>

        {/*
          The five questions, together, because they are different questions
          and reading them apart is how a strike looks safe.

            Expiry OTM   does it finish beyond the strike?
            Touch        does it reach the strike at any point on the way?
            Near-zero    does the premium collapse, so the target fills?
            EM×          how far away is it, in units of today's expected move?
            At ±1 EM     what a move of exactly that size costs, per contract

          A put can be 96.9% to expire worthless and still be touched one day in
          four. That is not a 4% chance of losing and a 24% chance of losing --
          it is one number about the settlement and another about the drawdown
          on the way to it, and a short position is lived through the second
          one. Touching is not losing: a day that touches and comes back settles
          worthless like any other, which is why nothing here is coloured as a
          failure and why no gate refuses a strike for it.
        */}
        <section aria-label="path and settlement" className="mt-4 rounded-lg bg-muted px-3 py-2.5">
          <div className="grid grid-cols-3 gap-x-3 gap-y-2.5 sm:grid-cols-5">
            <Figure
              label="Ends worthless"
              value={dash(zero, (n) => `${(n * 100).toFixed(1)}%`)}
              tone={zero === null ? undefined : zero >= 0.97 ? 'up' : zero >= 0.9 ? 'warn' : 'down'}
              hint="Where it finishes: the chance this option expires worthless, corrected by 733 settlements."
            />
            <Figure
              label="Price gets there"
              value={dash(touch, (n) => `${(n * 100).toFixed(0)}%`)}
              tone={touch === null ? undefined : touch >= 0.5 ? 'down' : touch >= 0.25 ? 'warn' : undefined}
              hint="What it feels like on the way: the chance BTC reaches this strike at least once before settlement. Touching is not losing."
            />
            <Figure
              label="Collapses early"
              value={dash(leg.probs?.nearZero ?? null, (n) => `${(n * 100).toFixed(0)}%`)}
              hint="The chance this option's own price falls to about ten cents before settlement — the target filling. Simulated; blank where it is not worth simulating."
            />
            <Figure
              label="Usual moves away"
              value={dash(leg.emBuffer, (n) => `${n.toFixed(2)}×`)}
              tone={leg.emBuffer === null ? undefined : leg.emBuffer < 1 ? 'down' : leg.emBuffer >= 2 ? 'up' : undefined}
              hint="How far the strike is in expected moves. Under 1.0, today's expected move reaches it."
            />
            <Figure
              label="If BTC moves one usual move"
              value={atOneMove === null ? '—' : atOneMove === 0 ? 'nothing' : `−${usd(atOneMove)}`}
              second="per contract"
              tone={atOneMove === null || atOneMove === 0 ? undefined : 'down'}
              hint="What a move of exactly one expected move, straight at this strike, costs per contract at settlement. Zero means such a move does not reach it."
            />
          </div>
          <p className="m-0 mt-2 text-[11px] leading-snug text-[var(--dim)]">
            These answer different questions. A strike can be {zero === null ? 'almost certain' : `${(zero * 100).toFixed(1)}%`} to
            expire worthless and still be touched {touch === null ? 'often' : `${(touch * 100).toFixed(0)}% of the time`} on the
            way — that is the drawdown to sit through, not a second chance of losing. Nothing here refuses a strike on its own.
          </p>
        </section>

        <dl className="mt-4 flex flex-col gap-1.5">
          <KV label="BTC now">{fmtStrike(Math.round(snap.spot))}</KV>
          <KV label="Distance to the strike">
            {dash(Math.abs(leg.strike - snap.spot), (n) => `$${fmtStrike(Math.round(n))}`)}
            {dist !== null && <span className="text-muted-foreground"> · {dist.toFixed(2)}%</span>}
          </KV>
          <KV
            label="Chance it expires worthless"
            hint="The maths, corrected by what really happened to strikes like this one over 733 settlements."
          >
            <span className={cn(zero !== null && zero >= 0.97 ? 'up' : zero !== null && zero >= 0.9 ? 'warn' : 'down')}>
              {dash(zero, (n) => `${(n * 100).toFixed(1)}%`)}
            </span>
          </KV>
          <KV label="The maths alone" hint="N(d2), before the history correction.">
            <span className="text-muted-foreground">{dash(leg.pOtm, (n) => `${(n * 100).toFixed(1)}%`)}</span>
          </KV>
          <KV label="Delta" hint="How much the premium moves per dollar of BTC.">
            {dash(leg.delta, (n) => n.toFixed(3))}
          </KV>
        </dl>

        <div className="mt-4 border-t border-border pt-3">
          <dl className="flex flex-col gap-1.5">
            <KV label="Bid · ask" hint="You receive the bid when you sell.">
              <span className="up">{price(leg.bid)}</span>
              <span className="text-muted-foreground"> · </span>
              <span className="down">{price(leg.ask)}</span>
            </KV>
            <KV label="Mid">{price(mid)}</KV>
            <KV
              label="Last traded"
              hint="A price nobody has hit in a while is not a price you can sell at."
            >
              {leg.ageMin === null
                ? '—'
                : leg.ageMin === 0
                  ? <span className="up">just now</span>
                  : <span className={leg.ageMin > 30 ? 'warn' : undefined}>{leg.ageMin}m ago</span>}
            </KV>
            <KV label="Open interest">{dash(leg.oi, (n) => n.toLocaleString())}</KV>
            <KV label="Traded today">{dash(leg.volume, (n) => n.toLocaleString())}</KV>
            <KV
              label="Traded against open interest"
              hint="How much of what is open changed hands today — how easily you could get back out."
            >
              {dash(ev.volumeToOi, (n) => `${(n * 100).toFixed(2)}%`)}
            </KV>
          </dl>
        </div>

        <div className="mt-4 border-t border-border pt-3">
          <dl className="flex flex-col gap-1.5">
            <KV
              label="Expected value"
              hint="The credit less the average payout of strikes like this one, after Delta's charges."
            >
              <b className={ev.evUsd === null ? '' : ev.evUsd >= 0 ? 'up' : 'down'}>
                {signedUsd(ev.evUsd)}
              </b>
              <span className="text-muted-foreground"> · {signedInr(usdToInr(ev.evUsd))}</span>
            </KV>
            <KV label="Average payout at settlement" hint="Per BTC, weighted by how often strikes like this really breached.">
              {dash(ev.payoutPerBtc, (n) => `$${n.toFixed(2)}`)}
            </KV>
            <KV
              label="Credit against the margin"
              hint="What the credit is worth as a return on the margin Delta ties up for it."
            >
              {dash(ev.premiumYieldPct, (n) => `${n.toFixed(2)}%`)}
            </KV>
            <KV
              label="Credit against the expected move"
              hint="The premium in units of how far BTC is priced to travel by expiry. Under 1 is being paid less than the move it is exposed to."
            >
              {dash(ev.premiumPerExpectedMove, (n) => `${n.toFixed(3)}×`)}
            </KV>
            <KV label="Break even">{dash(ev.breakeven, (n) => fmtStrike(Math.round(n)))}</KV>
            <KV label="Most it can make" hint="The credit, after charges. A short option has no more upside than that.">
              {usd(ev.maxProfitUsd)}
            </KV>
            <KV label="Worst case">
              <span className="down">
                {ev.maxLossUsd === null ? 'unbounded' : usd(ev.maxLossUsd)}
              </span>
            </KV>
            <KV label="Charges to open">{usd(ev.chargesUsd)}</KV>
          </dl>
        </div>

        {ev.breakdown && (
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
              How that expected value was reached
            </div>
            {/*
              The board shows the answer; this is what a reader needs to argue
              with it. The last line is the same arithmetic written out, so the
              figure above can be checked rather than taken.
            */}
            <dl className="flex flex-col gap-1.5">
              <KV label="Chance it expires worthless">
                <span className="up">{(ev.breakdown.pWin * 100).toFixed(1)}%</span>
              </KV>
              <KV label="Credit if it does" hint="Per BTC. You receive the bid.">
                <span className="up">${ev.breakdown.premiumPerBtc.toFixed(2)}</span>
              </KV>
              <KV label="Chance it breaches">
                <span className="down">{(ev.breakdown.pLoss * 100).toFixed(1)}%</span>
              </KV>
              <KV
                label="Average cost if it does"
                hint="Per BTC, given a breach happens — not the worst case, which is unbounded."
              >
                <span className="down">${ev.breakdown.expectedLossPerBtc.toFixed(2)}</span>
              </KV>
              <KV label="Delta’s charges">{usd(ev.breakdown.feesUsd)}</KV>
            </dl>
            <p className="m-0 mt-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              ({(ev.breakdown.pWin * 100).toFixed(1)}% × ${ev.breakdown.premiumPerBtc.toFixed(2)})
              − ({(ev.breakdown.pLoss * 100).toFixed(1)}% × ${ev.breakdown.expectedLossPerBtc.toFixed(2)})
              {' '}× lots × 0.001 − {usd(ev.breakdown.feesUsd)}
              {' = '}
              <b className={ev.breakdown.evUsd >= 0 ? 'up' : 'down'}>{signedUsd(ev.breakdown.evUsd)}</b>
            </p>
          </div>
        )}

        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground">
            Eligibility
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {[...blocks, ...warns].map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
                {c.ok ? (
                  <CheckIcon size={14} className="mt-[2px] flex-none text-[var(--up)]" aria-label="passes" />
                ) : c.severity === 'block' ? (
                  <X size={14} className="mt-[2px] flex-none text-[var(--down)]" aria-label="fails" />
                ) : (
                  <AlertTriangle size={14} className="mt-[2px] flex-none text-[var(--warn)]" aria-label="warning" />
                )}
                <span className={c.ok ? 'text-muted-foreground' : undefined}>{c.text}</span>
              </li>
            ))}
          </ul>
          <p className="m-0 mt-3 text-[11.5px] leading-snug text-muted-foreground">
            These rules are not what the desk recommends on. They have never been measured
            across 2024, 2025 and 2026 the way the premium floor and the RSI gate were, and
            nothing on the trading side reads them.
          </p>
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {onSell && leg.sellPrice !== null && (
            <Button onClick={() => { onOpenChange(false); onSell(leg); }}>
              Open a ticket
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
