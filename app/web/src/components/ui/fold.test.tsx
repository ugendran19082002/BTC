import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FoldButton, useFold } from '@/components/ui/fold';

/** A card with its own header folds like the plain ones, and remembers it. */
function Panel() {
  const [open, setOpen] = useFold('test-panel');
  return (
    <section aria-label="panel" className="fold-host" data-folded={!open}>
      <div className="fold-head"><FoldButton open={open} onToggle={() => setOpen(!open)} label="panel" /> Title</div>
      <div>body</div>
    </section>
  );
}

beforeEach(() => localStorage.clear());

describe('folding a card that draws its own header', () => {
  it('[critical] folds and unfolds, says which way for a screen reader, and is remembered', () => {
    const { unmount } = render(<Panel />);
    const btn = screen.getByRole('button', { name: 'Collapse panel' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(btn);
    expect(screen.getByRole('region', { name: 'panel' })).toHaveAttribute('data-folded', 'true');
    expect(screen.getByRole('button', { name: 'Expand panel' })).toHaveAttribute('aria-expanded', 'false');
    unmount();
    render(<Panel />);
    expect(screen.getByRole('region', { name: 'panel' })).toHaveAttribute('data-folded', 'true');   // remembered
  });
});
