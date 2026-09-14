import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export type LogTone = 'ok' | 'bad' | 'quiet';

export type LogRow = {
  id: string | number;
  /** When it happened, already in the reader's clock. */
  at: string;
  /** Which strategy, or whatever names the row. */
  who: string;
  /** What happened, in one or two words. */
  outcome: string;
  tone: LogTone;
  /** The server's own sentence about it — the part worth reading. */
  detail: string;
  /** Anything between `who` and `outcome` that is worth a column of its own. */
  extra?: string;
};

const TONE: Record<LogTone, string> = {
  ok: 'text-[var(--up)]',
  bad: 'text-[var(--down)]',
  quiet: 'text-[var(--dim)]',
};

/**
 * A log of what the desk did, as a table.
 *
 * Both logs on this screen — the runs and the adds to the other leg — were
 * fifteen bordered blocks each, every one carrying a name, a time, an outcome
 * and a sentence. Thirty of those is a page you scroll rather than read, and
 * the thing a person is actually doing is scanning one column for the day that
 * went wrong.
 *
 * It is a real table on a desk and a stack on a phone. Not an `overflow-x`
 * scroller like the chain: the chain is genuinely wide and every column of it
 * is a number you compare down, where this is four fields of which one is a
 * sentence, and a sentence in a 90-pixel column is unreadable at any width.
 */
export function LogTable({
  rows,
  label,
  extraHead,
  pageSize = 5,
}: {
  /** Newest first — the order the server returns them in. */
  rows: readonly LogRow[];
  /** What the table is, for a screen reader. */
  label: string;
  /** Heading for the optional middle column, when the rows carry one. */
  extraHead?: string;
  /**
   * How many rows a page holds.
   *
   * Five, because the question this log answers is almost always "what did it
   * do *today*" — and fifteen rows of it, twice on one screen, was a page you
   * scrolled past to reach anything else. The rest is a click away rather than
   * gone.
   */
  pageSize?: number;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));

  // A shorter log than the page you were on — a strategy deleted, a filter
  // changed — must not leave you looking at nothing.
  useEffect(() => { setPage((p) => Math.min(p, pages - 1)); }, [pages]);

  if (!rows.length) return null;
  const hasExtra = rows.some((r) => r.extra);
  const from = page * pageSize;
  const shown = rows.slice(from, from + pageSize);

  return (
    <>
    <table className="logtable" aria-label={label}>
      <thead>
        <tr>
          <th className="when">When</th>
          <th className="who">Strategy</th>
          {hasExtra && <th className="extra">{extraHead ?? ''}</th>}
          <th className="outcome">Outcome</th>
          <th className="detail">What happened</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.id}>
            <td className="when" data-label="When">{r.at}</td>
            <td className="who" data-label="Strategy">{r.who}</td>
            {hasExtra && <td className="extra" data-label={extraHead}>{r.extra ?? '—'}</td>}
            <td className={cn('outcome', TONE[r.tone])} data-label="Outcome">{r.outcome}</td>
            <td className="detail" data-label="What happened">{r.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {pages > 1 && (
      <div className="logpage">
        <span>
          {from + 1}–{Math.min(from + pageSize, rows.length)} of {rows.length}
        </span>
        <span className="logpage-buttons">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            aria-label="newer"
          >
            <ChevronLeft size={13} aria-hidden /> Newer
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            aria-label="older"
          >
            Older <ChevronRight size={13} aria-hidden />
          </button>
        </span>
      </div>
    )}
    </>
  );
}
