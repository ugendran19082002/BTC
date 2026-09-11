import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

/**
 * On or off, with what it does beside it.
 *
 * Replaces a pair of "On" / "Off" cards that each carried a sentence: two tall
 * buttons per setting was most of why the strategy form needed so much
 * scrolling. The sentence stays, once, under the label -- and it describes the
 * state the switch is in, so it never argues with it.
 */
export function Switch({
  checked, onCheckedChange, label, description, className, id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  description?: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const auto = React.useId();
  const htmlId = id ?? auto;
  return (
    <div className={cn('flex items-start justify-between gap-3 py-2', className)}>
      <label htmlFor={htmlId} className="min-w-0 cursor-pointer">
        <span className="block text-[13px] font-medium text-foreground">{label}</span>
        {description && <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{description}</span>}
      </label>
      <SwitchPrimitive.Root
        id={htmlId}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className={cn(
          'relative m-0 mt-0.5 inline-flex h-6 w-11 flex-none cursor-pointer appearance-none items-center rounded-full border-0 p-0 transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--line)]',
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'block h-5 w-5 rounded-full bg-background shadow transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-[2px]',
          )}
        />
      </SwitchPrimitive.Root>
    </div>
  );
}
