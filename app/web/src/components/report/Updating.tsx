import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { usePoll } from '@/hooks/usePoll';
import { cn } from '@/lib/utils';

/**
 * A read that knows which question its answer is to (owner, 13 Oct 2026: "after choosing a filter it should say
 * it is loading; the old values stay on the screen"). The answer is kept with the key of what was asked, so the
 * screen can tell the result of the settings now chosen from the one left over from the settings before.
 */
/**
 * `settleMs` (18 Oct 2026, owner: "a change takes a long time"): a question is asked once the settings have stood
 * still that long, not at every change -- each step of a stepper, each digit typed was a whole backtest, and the
 * backtest's thread works them one after another, so five quick edits waited for five. The first question is asked at
 * once; while one is being settled the screen already says a new answer is on its way (`stale`).
 */
export function useAnswer<T>(key: string, fetch: () => Promise<T>, everyMs: number, settleMs = 0, enabled = true): {
  data: T | null; error: Error | null;
  /** The answer on the screen is to other settings than those now chosen: a new one is on its way. */
  stale: boolean;
  /**
   * The settings now chosen were refused, or failed, and the answer on the screen is to others (19 Oct 2026, owner:
   * "portfolio not working" -- methods by win % refused with a reason, and the last run's result went on showing as
   * if it were the answer). Why, in words; null otherwise.
   */
  failed: string | null;
} {
  const [asked, setAsked] = useState(key);
  useEffect(() => {
    if (key === asked) return undefined;
    if (settleMs <= 0) { setAsked(key); return undefined; }
    const t = setTimeout(() => setAsked(key), settleMs);
    return () => clearTimeout(t);
  }, [key, asked, settleMs]);
  // Asked with the settings as they are when it settles: the question and its key are the same one.
  const settled = settleMs <= 0 ? key : asked;
  // An error carries the question it answered: the poll keeps its last one until the next answer comes, and a refusal
  // of the settings before is not one of the settings now chosen (19 Oct 2026: "Days before" refused, "First days"
  // chosen, and the old refusal said over it for the seconds the new run took).
  const read = usePoll(() => fetch().then((data) => ({ key: settled, data }), (e: unknown) => {
    throw new AnswerError(settled, e);
  }), everyMs, { deps: [settled], enabled });
  const error = read.error instanceof AnswerError ? (read.error.key === key ? read.error : null) : read.error;
  return {
    data: read.data?.data ?? null,
    // An error is about the question now asked; it is said rather than waited on.
    error,
    stale: read.data !== null && read.data.key !== key && error === null,
    failed: error !== null && read.data !== null && read.data.key !== key ? error.message : null,
  };
}

/** A failed answer, with the question it was to. */
class AnswerError extends Error {
  constructor(readonly key: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : 'Error';
  }
}

/**
 * The result, while a new one is worked out: a bar that says so at once, and what is on the screen greyed and
 * marked as the previous settings' -- kept rather than blanked, so the page does not jump, but never mistaken
 * for the answer to the new choice.
 */
export function Updating({ busy, what, failed = null, children }: {
  busy: boolean; what: string;
  /** The settings now chosen could not be worked out, and why: said above, and what is below greyed as the previous settings'. */
  failed?: string | null;
  children: ReactNode;
}) {
  const greyed = busy || failed !== null;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3" aria-busy={busy}>
      {failed !== null && (
        <div role="alert" className="sticky top-0 z-10 rounded-md border border-[var(--down)] bg-[var(--panel-2,var(--bg))] px-3 py-2 text-[13.5px] leading-snug">
          <span className="font-semibold text-[var(--down)]">These settings could not be run:</span> {failed}
          <span className="block text-[12.5px] text-muted-foreground">Below: the previous settings&apos; result, not these.</span>
        </div>
      )}
      {busy && failed === null && (
        <div role="status" className="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-[var(--accent)] bg-[var(--panel-2,var(--bg))] px-3 py-2 text-[13.5px]">
          <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
          <span>Working out {what} for the settings you chose… <span className="text-muted-foreground">Below: the previous settings&apos; result.</span></span>
        </div>
      )}
      <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 transition-opacity', greyed && 'pointer-events-none select-none opacity-40')}>
        {children}
      </div>
    </div>
  );
}
