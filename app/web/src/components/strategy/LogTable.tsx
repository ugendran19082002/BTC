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
}: {
  rows: readonly LogRow[];
  /** What the table is, for a screen reader. */
  label: string;
  /** Heading for the optional middle column, when the rows carry one. */
  extraHead?: string;
}) {
  if (!rows.length) return null;
  const hasExtra = rows.some((r) => r.extra);

  return (
    <table className="logtable" aria-label={label}>
      <thead>
        <tr>
          <th>When</th>
          <th>Strategy</th>
          {hasExtra && <th>{extraHead ?? ''}</th>}
          <th>Outcome</th>
          <th className="detail">What happened</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
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
  );
}
