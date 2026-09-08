import * as React from 'react';

/**
 * A heading inside a card.
 *
 * Same weight and colour as a card title so a folded-in section still reads as
 * its own thing, without pretending to be a card of its own. `hint` is the
 * caveat that used to be a paragraph underneath: on hover, out of the way, and
 * still there for whoever wonders.
 */
export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div
      className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.8px] text-muted-foreground"
      title={hint}
    >
      {children}
    </div>
  );
}
