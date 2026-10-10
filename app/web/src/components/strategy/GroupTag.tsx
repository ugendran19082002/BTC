import { FolderClosed } from 'lucide-react';
import { useGroupOf } from '@/hooks/useGroupOf';
import { cn } from '@/lib/utils';

/**
 * The group a strategy is in, as a small tag beside its name (owner, 10 Oct 2026: "wherever a strategy's name is,
 * its group's name as a tag -- user friendly, desk and phone"). The same shape everywhere -- a folder and the name,
 * in a muted pill -- so it reads as "which group", apart from the strategy's own coloured tag. A long name is cut
 * with an ellipsis and read out whole; a strategy in no group, or a trade by hand, shows nothing.
 */
export function GroupTag({ strategyId, className }: { strategyId: string | null | undefined; className?: string }) {
  const groupOf = useGroupOf();
  const g = groupOf(strategyId);
  if (!g) return null;
  return (
    <span
      aria-label={`Group: ${g.name}`}
      title={`Group ${g.name}${g.accountName ? ` · ${g.accountName}` : ''}`}
      className={cn(
        'inline-flex min-w-0 max-w-[10rem] flex-none items-center gap-1 rounded border border-solid border-[var(--line)] px-1.5 py-px align-middle text-[10.5px] font-medium leading-tight text-muted-foreground',
        className,
      )}
    >
      <FolderClosed className="h-2.5 w-2.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{g.name}</span>
    </span>
  );
}
