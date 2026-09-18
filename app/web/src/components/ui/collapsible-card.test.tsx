import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';

/**
 * Every card folds, and remembers it. The title stays when folded -- a card
 * that hides its own name cannot be found again -- and a control beside the
 * title is its own button, never one nested inside the fold button.
 */

beforeEach(() => localStorage.clear());

describe('a card that folds', () => {
  it('[critical] folds on its title and remembers the choice across a reload', () => {
    const { unmount } = render(<CollapsibleCard id="t" title="Open positions"><p>body</p></CollapsibleCard>);
    expect(screen.getByText('body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open positions' }));
    expect(screen.queryByText('body')).toBeNull();
    unmount();
    render(<CollapsibleCard id="t" title="Open positions"><p>body</p></CollapsibleCard>);
    expect(screen.queryByText('body')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open positions' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('starts folded where asked, as on a phone', () => {
    render(<CollapsibleCard id="t2" title="Market" defaultOpen={false}><p>body</p></CollapsibleCard>);
    expect(screen.queryByText('body')).toBeNull();
  });

  it('[critical] a button beside the title is its own control, and pressing it does not fold the card', () => {
    const onNew = vi.fn();
    render(
      <CollapsibleCard id="t3" title="Strategies" right={<button type="button" onClick={onNew}>New</button>}>
        <p>body</p>
      </CollapsibleCard>,
    );
    const newButton = screen.getByRole('button', { name: 'New' });
    expect(newButton.closest('button[aria-expanded]')).toBeNull();
    fireEvent.click(newButton);
    expect(onNew).toHaveBeenCalled();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('a badge beside the title stays readable when folded, and the card can be named', () => {
    render(
      <CollapsibleCard id="t4" title="Account" right={<span>LIVE</span>} ariaLabel="account" defaultOpen={false}>
        <p>body</p>
      </CollapsibleCard>,
    );
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByLabelText('account')).toBeInTheDocument();
  });
});
