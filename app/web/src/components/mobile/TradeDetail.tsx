import { useEffect } from 'react';
import { AlertOctagon, ArrowLeft, CheckCircle2, CircleDot, Info, LogIn, LogOut, Radio, ShieldCheck } from 'lucide-react';
import { getTradeDetail } from '@/api/phone';
import { NotSignedIn } from '@/api/client';
import { Card, CardTitle } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { usePoll } from '@/hooks/usePoll';
import { contractLabel, price, size, stamp } from '@/lib/format';
import { journalSteps, type Stage } from '@/lib/journal-steps';
import { isLongTrade } from '@/lib/long-exits';
import { cn } from '@/lib/utils';
import { usePhone } from '@/components/mobile/phone-context';
import { PositionCard } from '@/components/mobile/PositionCard';

/**
 * One trade, start to end, read only (the phone's Level 2, 6 Oct 2026): what it is and what it made, then its
 * whole journal as a line of steps -- signal, entry, fill, protection, exit, closed. Opened from a position, a
 * signal, or the link in a Telegram fill alert (`/m?trade=<id>`). Refreshes while the trade is open.
 */

const STAGE: Record<Stage, { icon: typeof Info; tone: string; label: string }> = {
  signal: { icon: Radio, tone: 'text-[var(--accent)]', label: 'Signal' },
  entry: { icon: LogIn, tone: 'text-foreground', label: 'Entry' },
  fill: { icon: CircleDot, tone: 'text-[var(--up)]', label: 'Fill' },
  protection: { icon: ShieldCheck, tone: 'text-[var(--up)]', label: 'Protection' },
  exit: { icon: LogOut, tone: 'text-foreground', label: 'Exit' },
  closed: { icon: CheckCircle2, tone: 'text-[var(--up)]', label: 'Closed' },
  problem: { icon: AlertOctagon, tone: 'text-[var(--down)]', label: 'Problem' },
  info: { icon: Info, tone: 'text-muted-foreground', label: 'Note' },
};

export function TradeDetail({ tradeId, onClose, onSignedOut }: { tradeId: string; onClose: () => void; onSignedOut: () => void }) {
  const detail = usePoll(() => getTradeDetail(tradeId), 5_000, { deps: [tradeId] });
  useEffect(() => { if (detail.error instanceof NotSignedIn) onSignedOut(); }, [detail.error, onSignedOut]);
  // The page behind does not scroll under the sheet.
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = before; };
  }, []);

  /*
   * The trade as the status has it, while it is open: the journal route carries no prices, so an open trade read
   * "If closed now — –" (the live phone, 6 Oct 2026). The status the phone already reads does, so the same live
   * card as the Positions screen stands here -- P&L, the SL / TGT lines -- for as long as the trade is open.
   */
  const p = usePhone();
  const liveTrade = p.status?.open.find((x) => x.tradeId === tradeId) ?? null;
  const d = detail.data;
  const t = d?.trade ?? null;
  const steps = d ? journalSteps(d.trade, d.events) : [];
  const open = t !== null && t.position !== 0;
  const long = t ? isLongTrade(t) : false;

  return (
    // `m-phone`: the phone's card titles at 11.5px here too -- this layer sits outside the frame (9 Oct 2026).
    <div role="dialog" aria-modal="true" aria-label="Trade detail" className="m-phone fixed inset-0 z-30 overflow-y-auto bg-[var(--bg)]">
      <header className="sticky top-0 z-10 flex items-center gap-1 border-b border-border bg-[var(--bg)]/95 px-2 pb-2 pt-[calc(8px+env(safe-area-inset-top))] backdrop-blur">
        <button type="button" onClick={onClose} aria-label="Back" className="grid h-11 w-11 place-items-center rounded-md border-0 bg-transparent text-foreground active:bg-muted">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="m-0 truncate text-[17px] font-semibold">{t ? contractLabel(t.symbol) : 'Trade'}</h1>
        {t && (
          <span className={cn('ml-1 rounded px-1.5 py-0.5 text-[11px] font-semibold', long ? 'bg-[var(--up-bg)] text-[var(--up)]' : 'bg-[var(--down-bg)] text-[var(--down)]')}>
            {long ? 'BUY' : 'SELL'}
          </span>
        )}
        {t && <span className="ml-auto pr-2 text-[12px] text-muted-foreground">{open ? 'Open' : 'Closed'}</span>}
      </header>

      <main className="mx-auto flex max-w-[560px] flex-col gap-3 px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-3 text-[14px]">
        {!d ? (
          <Card aria-busy={!detail.error}>
            <p className="m-0 text-muted-foreground">
              {detail.error ? (/no such trade/i.test(detail.error.message) ? 'No such trade on this desk.' : `Could not read the trade: ${detail.error.message}`) : 'Reading the trade…'}
            </p>
          </Card>
        ) : (
          <>
            {liveTrade ? (
              <PositionCard trade={liveTrade} alarms={p.status?.alarms ?? []} perpMark={p.perp} perpLive={p.perpLive} now={p.now} showAccount={p.shown === 'all'} />
            ) : (
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 text-[13px] text-muted-foreground">
                  <div>{size(t!.entrySize || t!.requestedSize)} contracts · in at {price(t!.entryAvgPrice)}{t!.exitAvgPrice !== null ? ` · out at ${price(t!.exitAvgPrice)}` : ''}</div>
                  {t!.plan?.strategyName && <div>Strategy “{t!.plan.strategyName}”</div>}
                  {t!.account && <div>Account {t!.account.name}</div>}
                </div>
                <div className="text-right">
                  <div className="text-[11.5px] text-muted-foreground">{open ? 'If closed now' : 'Made, after charges'}</div>
                  <Money value={open ? (t!.live?.netIfClosedUsd ?? t!.live?.unrealisedPnl ?? null) : (t!.netRealisedUsd ?? t!.realisedPnl)} signed strong />
                </div>
              </div>
              {t!.charges && <div className="mt-2 text-[12px] text-muted-foreground">Charges paid <Money value={t!.charges.paidUsd} className="[&>span]:text-[12px]" /></div>}
              {(t!.alarm || t!.protectionProblem || t!.plan?.exitProblem) && (
                <div role="alert" className="mt-3 rounded-md bg-[var(--down-bg)] px-3 py-2 text-[13.5px] text-[#ffb3ae]">
                  {[t!.alarm, t!.protectionProblem, t!.plan?.exitProblem].filter(Boolean).join(' ')}
                </div>
              )}
            </Card>
            )}

            <Card>
              <CardTitle>What happened</CardTitle>
              <ol className="m-0 list-none p-0" aria-label="Journal">
                {steps.map((s, i) => {
                  const v = STAGE[s.stage];
                  const lastOne = i === steps.length - 1;
                  return (
                    <li key={`${s.at}-${i}`} className="relative flex gap-3 pb-3">
                      {!lastOne && <span aria-hidden="true" className="absolute left-[11px] top-6 bottom-0 w-px bg-[var(--line)]" />}
                      <v.icon aria-hidden="true" className={cn('mt-0.5 h-[22px] w-[22px] shrink-0', v.tone)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={cn('text-[14px] font-medium', s.stage === 'problem' && 'text-[var(--down)]')}>
                            <span className="sr-only">{v.label}: </span>{s.title}
                          </span>
                        </div>
                        {s.detail && <div className="text-[12.5px] leading-snug text-muted-foreground">{s.detail}</div>}
                        <div className="text-[11.5px] tabular-nums text-[var(--time)]">{stamp(s.at)}</div>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {steps.length === 0 && <p className="m-0 text-muted-foreground">Nothing in the journal yet.</p>}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
