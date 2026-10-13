import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { usePoll } from '@/hooks/usePoll';
import { cn } from '@/lib/utils';

/**
 * A read that knows which question its answer is to (owner, 13 Oct 2026: "after choosing a filter it should say
 * it is loading; the old values stay on the screen"). The answer is kept with the key of what was asked, so the
 * screen can tell the result of the settings now chosen from the one left over from the settings before.
 */
export function useAnswer<T>(key: string, fetch: () => Promise<T>, everyMs: number): {
  data: T | null; error: Error | null;
  /** The answer on the screen is to other settings than those now chosen: a new one is on its way. */
  stale: boolean;
} {
  const read = usePoll(() => fetch().then((data) => ({ key, data })), everyMs, { deps: [key] });
  return {
    data: read.data?.data ?? null,
    // An error is about the question now asked; it is said rather than waited on.
    error: read.error,
    stale: read.data !== null && read.data.key !== key && read.error === null,
  };
}

/**
 * The result, while a new one is worked out: a bar that says so at once, and what is on the screen greyed and
 * marked as the previous settings' -- kept rather than blanked, so the page does not jump, but never mistaken
 * for the answer to the new choice.
 */
export function Updating({ busy, what, children }: { busy: boolean; what: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3" aria-busy={busy}>
      {busy && (
        <div role="status" className="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-[var(--accent)] bg-[var(--panel-2,var(--bg))] px-3 py-2 text-[13.5px]">
          <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-[var(--accent)]" />
          <span>Working out {what} for the settings you chose… <span className="text-muted-foreground">Below: the previous settings&apos; result.</span></span>
        </div>
      )}
      <div className={cn('grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 transition-opacity', busy && 'pointer-events-none select-none opacity-40')}>
        {children}
      </div>
    </div>
  );
}
