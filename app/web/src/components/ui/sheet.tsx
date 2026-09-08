import * as React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A panel that comes up from the bottom on a phone and sits in the middle on a
 * desktop.
 *
 * The order ticket lives in here, which is why it slides from the bottom: on a
 * phone that is where the thumb already is, and the confirm button lands under
 * it rather than at the top of the screen where it has to be reached for.
 */

export const Sheet = Dialog.Root;
export const SheetTrigger = Dialog.Trigger;
export const SheetClose = Dialog.Close;

export function SheetContent({
  children, className, title, description,
}: {
  children: React.ReactNode;
  className?: string;
  title: string;
  description?: string;
}) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px]',
          'data-[state=open]:animate-in',
        )}
      />
      <Dialog.Content
        className={cn(
          'fixed z-50 flex flex-col border border-border bg-background shadow-2xl',
          'focus:outline-none',
          // phone: a sheet off the bottom edge, safe-area aware
          'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl',
          'pb-[env(safe-area-inset-bottom)]',
          // desktop: a centred dialog
          'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[420px]',
          'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
          'data-[state=open]:animate-in',
          className,
        )}
      >
        {/* the grab handle is the affordance that says "this can be dragged away" */}
        <div className="mx-auto mt-2 h-1 w-9 flex-none rounded-full bg-[var(--line)] sm:hidden" />
        <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3">
          <div className="min-w-0">
            <Dialog.Title className="m-0 truncate text-[15px] font-semibold text-foreground">
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description className="m-0 mt-0.5 text-[12px] text-muted-foreground">
                {description}
              </Dialog.Description>
            )}
          </div>
          <Dialog.Close
            aria-label="close"
            // preflight is off, so a bare button keeps the platform's own chrome
            className="-mr-1 flex h-7 w-7 flex-none appearance-none items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Dialog.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/** A row of actions pinned under the content, where a thumb expects them. */
export function SheetFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('sticky bottom-0 -mx-4 mt-3 flex gap-2 border-t border-border bg-background px-4 pb-1 pt-3', className)}>
      {children}
    </div>
  );
}
