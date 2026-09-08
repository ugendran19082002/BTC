import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/utils';

/**
 * A drag bar sized for a thumb.
 *
 * The track is 4px because that is what reads well, but the hit area is 40px
 * tall and invisible: on a phone a 4px target is a target you miss. Radix gives
 * keyboard and screen-reader behaviour for free, which a div with a drag
 * handler does not.
 */
export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { tone?: 'up' | 'down' | 'accent' }
>(({ className, tone = 'accent', 'aria-label': label, ...props }, ref) => {
  const colour =
    tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--accent)';
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        // the generous, invisible hit area
        'h-10 cursor-grab active:cursor-grabbing',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-[var(--line)]">
        <SliderPrimitive.Range className="absolute h-full rounded-full" style={{ background: colour }} />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        // Radix puts role="slider" on the thumb, so the label belongs here and
        // not on the root -- on the root it labels nothing a reader can reach.
        aria-label={label}
        className={cn(
          'block h-5 w-5 rounded-full border-2 bg-background shadow-md',
          'transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'active:scale-110',
        )}
        style={{ borderColor: colour }}
      />
    </SliderPrimitive.Root>
  );
});
Slider.displayName = 'Slider';
