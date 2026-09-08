import * as React from 'react';
import * as TG from '@radix-ui/react-toggle-group';
import { cn } from '@/lib/utils';

export const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof TG.Root>,
  React.ComponentPropsWithoutRef<typeof TG.Root>
>(({ className, ...props }, ref) => (
  <TG.Root
    ref={ref}
    className={cn(
      // Scrolls rather than squeezes: five chips crushed into a phone width
      // wrap "server · 1" onto two lines, which reads as two chips.
      'inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5',
      className,
    )}
    {...props}
  />
));
ToggleGroup.displayName = 'ToggleGroup';

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof TG.Item>,
  React.ComponentPropsWithoutRef<typeof TG.Item>
>(({ className, ...props }, ref) => (
  <TG.Item
    ref={ref}
    className={cn(
      'appearance-none border-0 bg-transparent font-[inherit]',
      'inline-flex h-7 flex-none items-center justify-center gap-1 whitespace-nowrap rounded-md px-2.5',
      'text-[12.5px] font-medium',
      'text-muted-foreground transition-colors hover:text-foreground',
      'data-[state=on]:bg-background data-[state=on]:text-foreground',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      className,
    )}
    {...props}
  />
));
ToggleGroupItem.displayName = 'ToggleGroupItem';
