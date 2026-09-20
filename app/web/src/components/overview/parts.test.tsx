import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Panel, PanelFold } from './parts';

/** Every panel folds to its header, remembers it, and follows collapse-all / expand-all. */
describe('Panel folding', () => {
  beforeEach(() => localStorage.clear());

  it('hides the body and the header extras when folded, and remembers it', () => {
    const { unmount } = render(<Panel title="Skew" right={<span>extra</span>}><p>body</p></Panel>);
    expect(screen.getByText('body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /collapse skew/i }));
    expect(screen.queryByText('body')).toBeNull();
    expect(screen.queryByText('extra')).toBeNull();
    expect(localStorage.getItem('btc-desk:live:fold:Skew')).toBe('true');
    unmount();
    render(<Panel title="Skew"><p>body</p></Panel>);
    expect(screen.queryByText('body')).toBeNull();
    expect(screen.getByRole('button', { name: /expand skew/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keys a panel with a dynamic title by its name', () => {
    render(<Panel title={<span>What changed · 80,600 CE</span>} name="What changed"><p>rows</p></Panel>);
    fireEvent.click(screen.getByRole('button', { name: /collapse/i }));
    expect(localStorage.getItem('btc-desk:live:fold:What changed')).toBe('true');
  });

  it('follows collapse-all and expand-all from the screen, each press once', () => {
    const { rerender } = render(
      <PanelFold.Provider value={{ stamp: 0, collapsed: false }}><Panel title="A"><p>a</p></Panel><Panel title="B"><p>b</p></Panel></PanelFold.Provider>,
    );
    rerender(<PanelFold.Provider value={{ stamp: 1, collapsed: true }}><Panel title="A"><p>a</p></Panel><Panel title="B"><p>b</p></Panel></PanelFold.Provider>);
    expect(screen.queryByText('a')).toBeNull();
    expect(screen.queryByText('b')).toBeNull();
    // One panel reopened by hand stays open: the stamp has not changed.
    fireEvent.click(screen.getByRole('button', { name: /expand a/i }));
    expect(screen.getByText('a')).toBeInTheDocument();
    rerender(<PanelFold.Provider value={{ stamp: 2, collapsed: false }}><Panel title="A"><p>a</p></Panel><Panel title="B"><p>b</p></Panel></PanelFold.Provider>);
    expect(screen.getByText('b')).toBeInTheDocument();
  });
});
