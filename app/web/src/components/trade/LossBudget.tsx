import { useEffect, useState } from 'react';
import type { TradeStatus } from '@/types/trade';
import { getSettings, setLossLimit, type LossLimit } from '@/api/desk';
import { inr, pct, usd, usdToInr } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Rupees to the dollar on this desk's screens (lib/format): what an amount typed in rupees is kept as. */
const USDINR = 85;
/** How long the answer to a change made here stands in for the status, while the next poll catches up. */
const ANSWER_HOLDS_MS = 5_000;

/**
 * The day's loss budget, and the two things the owner can do to it (13 Oct 2026): switch it on or off, and set
 * its amount.
 *
 * Until then it was half the account and read-only. An afternoon that had lost more than that refused every
 * signal -- "Worst case $0 exceeds the $-82 left in today's loss budget" -- and the card that showed the limit
 * had nothing on it to change it with. Each account has its own; on "All accounts" the figure is every
 * account's added, and it is changed on an account's own tab.
 *
 * The status poll is the authority for what is shown. The server's answer to a change made here stands in for
 * it for a few seconds, so the switch does not flick back while the next poll is on its way.
 */
export function LossBudget({ status, dense = false }: { status: TradeStatus; dense?: boolean }) {
  const combined = status.combined ?? null;
  const [answer, setAnswer] = useState<LossLimit | null>(null);
  const [known, setKnown] = useState<LossLimit | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // The default and the amount chosen, for the edit form's own words. The figures shown come from the status.
  useEffect(() => {
    if (combined || !editing) return;
    let live = true;
    getSettings().then((r) => { if (live && r.lossLimit) setKnown(r.lossLimit); }).catch(() => {});
    return () => { live = false; };
  }, [combined, editing]);

  useEffect(() => {
    if (!answer) return;
    const t = setTimeout(() => setAnswer(null), ANSWER_HOLDS_MS);
    return () => clearTimeout(t);
  }, [answer]);

  // A server from before the switch says nothing about it: the budget is on, as it always was.
  const on = combined ? combined.lossLimitUsd > 0 : answer?.on ?? status.limits.dailyLossOn ?? true;
  const limit = combined ? combined.lossLimitUsd : answer?.inForceUsd ?? status.limits.maxDailyLossUsd;
  const lost = Math.max(0, -(status.realisedTodayUsd ?? 0));
  const left = combined ? combined.lossLeftUsd : Math.max(0, limit - lost);
  const used = limit > 0 ? Math.min(1, Math.max(0, 1 - left / limit)) : 0;
  const defaultUsd = (answer ?? known)?.defaultUsd ?? null;
  const chosenUsd = answer ? answer.chosenUsd : known?.chosenUsd ?? null;

  const change = async (ask: { on?: boolean; usd?: number | null }, done?: () => void) => {
    setBusy(true);
    setRefusal(null);
    try {
      const r = await setLossLimit(ask);
      setAnswer(r.lossLimit);
      setKnown(r.lossLimit);
      done?.();
    } catch (e) {
      setRefusal((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const rupees = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(rupees) || rupees <= 0) {
      setRefusal('Enter an amount in rupees, above 0.');
      return;
    }
    void change({ usd: Math.round((rupees / USDINR) * 100) / 100 }, () => setEditing(false));
  };

  const typed = Number(draft);
  const text = dense ? 'text-[12px]' : 'text-[13px]';

  return (
    // The switch sits over the list's corner, not inside it: a <dl> holds names and values only.
    <div className="relative">
      {!combined && (
        <button
          type="button" role="switch" aria-checked={on} aria-label="Daily loss limit" disabled={busy}
          title={on ? 'On: new orders stop when today\'s losses reach the limit. Tap to switch off.' : 'Off: today\'s losses stop no order. Tap to switch on.'}
          onClick={() => void change({ on: !on })}
          className={cn(
            'absolute right-0 top-0 m-0 inline-flex h-6 w-11 cursor-pointer appearance-none items-center rounded-full border-0 p-0 transition-colors disabled:opacity-60',
            on ? 'bg-[var(--accent-fill)]' : 'bg-[var(--line)]',
          )}
        >
          {/* Off, the thumb is lighter than the track: a dark thumb on a dark track read as no switch at all. */}
          <span className={cn('block h-5 w-5 rounded-full shadow transition-transform', on ? 'translate-x-[22px] bg-background' : 'translate-x-0.5 bg-muted-foreground')} />
        </button>
      )}
      <dl className="m-0">
        <dt className={cn('m-0 pr-12 leading-6 text-muted-foreground', dense ? 'text-[12px]' : 'text-[13px]')}>Daily loss limit</dt>
        {on ? (
          <dd className={cn('m-0 mt-0.5 tabular-nums text-foreground', text)} aria-label="loss budget left">
            <span>{inr(usdToInr(left))}</span>{' '}
            <span className="text-[11.5px] text-[var(--dim)]">of {inr(usdToInr(limit))} left</span>
          </dd>
        ) : (
          <dd className={cn('m-0 mt-0.5 font-semibold text-[var(--warn)]', text)} aria-label="loss budget left">Off</dd>
        )}
      </dl>

      {on ? (
        <>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className={cn('h-full rounded-full', used > 0.75 ? 'bg-[var(--down)]' : 'bg-[var(--warn)]')}
              style={{ width: `${Math.min(100, used * 100)}%` }}
            />
          </div>
          {combined ? (
            <p className="m-0 mt-1 text-[11px] text-muted-foreground">Each account&apos;s own limit, added up. Change one on its own tab.</p>
          ) : used >= 1 ? (
            <p className="m-0 mt-1 text-[11px] font-medium text-[var(--down)]">
              Limit reached. New trades are blocked until tomorrow &mdash; or raise the limit, or switch it off.
            </p>
          ) : used > 0 ? (
            <p className="m-0 mt-1 text-[11px] text-muted-foreground">{pct(used, 0)} used. New trades stop at 100%.</p>
          ) : null}
        </>
      ) : (
        <p className="m-0 mt-1 text-[11px] leading-snug text-muted-foreground">
          {combined
            ? 'No account is keeping a loss limit today.'
            : <>Today&apos;s losses stop no new trade. Switched on, the limit is {inr(usdToInr(limit))}.</>}
        </p>
      )}

      {!combined && !editing && (
        <button
          type="button" aria-label="Edit the daily loss limit"
          className="m-0 mt-1 inline-flex min-h-8 appearance-none items-center border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2"
          onClick={() => { setDraft(String(Math.round(limit * USDINR))); setRefusal(null); setEditing(true); }}
        >
          Change the amount
        </button>
      )}

      {!combined && editing && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-muted-foreground">₹</span>
            <input
              type="number" min={1} step={1} inputMode="decimal" value={draft} aria-label="daily loss limit in rupees"
              className="h-9 w-24 rounded border border-[var(--line)] bg-transparent px-2 text-[14px] tabular-nums text-foreground"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
            <button
              type="button" disabled={busy} onClick={save}
              className="h-9 rounded border border-[var(--line)] px-3 text-[13px] text-foreground disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button" className="h-9 px-1 text-[12px] text-muted-foreground underline underline-offset-2"
              onClick={() => { setEditing(false); setRefusal(null); }}
            >
              Cancel
            </button>
          </div>
          <p className="m-0 mt-1 text-[11px] leading-snug text-[var(--dim)]">
            {Number.isFinite(typed) && typed > 0 ? <>{usd(typed / USDINR)} at ₹{USDINR} per $1. </> : null}
            {defaultUsd !== null && (chosenUsd === null
              ? <>This is the default: half the account, {inr(usdToInr(defaultUsd))}.</>
              : <>The default is half the account, {inr(usdToInr(defaultUsd))}.</>)}
          </p>
          {chosenUsd !== null && (
            <button
              type="button" disabled={busy}
              className="m-0 mt-0.5 inline-flex min-h-8 appearance-none items-center border-0 bg-transparent p-0 font-[inherit] text-[12px] text-[var(--accent)] underline underline-offset-2 disabled:opacity-50"
              onClick={() => void change({ usd: null }, () => setEditing(false))}
            >
              Back to the default
            </button>
          )}
        </div>
      )}

      {refusal && <p role="alert" className="m-0 mt-1 text-[11px] font-medium text-[var(--down)]">{refusal}</p>}
    </div>
  );
}
