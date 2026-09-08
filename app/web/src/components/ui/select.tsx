import * as React from 'react';
import * as RS from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * A listbox, not a native <select>.
 *
 * The native control was the right call while every option was two words. It
 * stopped being right once the options carried a second line of meaning: the
 * platform picker renders one line of plain text, truncates it on a phone, and
 * gives no way to mark one row as the one you actually want. This keeps the
 * keyboard and screen-reader behaviour (Radix does the roving focus, typeahead
 * and aria wiring) and lets a row carry a hint under its label.
 */
export function Select({
  value,
  onValueChange,
  children,
  className,
  ariaLabel,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <RS.Root value={value} onValueChange={onValueChange}>
      <RS.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-md',
          'border border-border bg-[var(--bg)] px-2.5 text-[13px] font-mono text-foreground',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          'data-[placeholder]:text-muted-foreground',
          className,
        )}
      >
        <span className="min-w-0 truncate text-left"><RS.Value /></span>
        <RS.Icon asChild><ChevronDown className="h-3.5 w-3.5 flex-none opacity-50" /></RS.Icon>
      </RS.Trigger>

      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-50 max-h-[min(70vh,420px)] overflow-hidden rounded-md border border-border',
            'bg-[var(--panel)] shadow-lg',
            // match the trigger so a long option never widens the page
            'w-[var(--radix-select-trigger-width)]',
          )}
        >
          <RS.Viewport className="p-1">{children}</RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

/** One row. `hint` is the quiet second line -- context, never the label. */
export function SelectItem({
  value,
  children,
  hint,
  disabled,
}: {
  value: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <RS.Item
      value={value}
      disabled={disabled}
      className={cn(
        'relative flex cursor-pointer select-none items-start gap-2 rounded px-2 py-1.5',
        'text-[12.5px] font-mono text-foreground outline-none',
        'data-[highlighted]:bg-[var(--panel-2)] data-[disabled]:opacity-40',
      )}
    >
      {/* fixed width so the label starts in the same place with or without the tick */}
      <span className="w-3 flex-none pt-[3px]">
        <RS.ItemIndicator><Check className="h-3 w-3 text-[var(--accent)]" /></RS.ItemIndicator>
      </span>
      <span className="min-w-0">
        <RS.ItemText>{children}</RS.ItemText>
        {hint && <span className="mt-0.5 block font-sans text-[11px] text-[var(--dim)]">{hint}</span>}
      </span>
    </RS.Item>
  );
}
