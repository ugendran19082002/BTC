import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SwipeToConfirm } from '@/components/ui/swipe-confirm';

/**
 * A swipe, not a tap. What has to hold: a tap never confirms, a part-way drag
 * never confirms, a drag to the end confirms exactly once, and Enter works for
 * a keyboard.
 */

export function swipe(slider: HTMLElement, to = 1, width = 320) {
  // jsdom has no layout: give the track a width so the thumb has somewhere to go
  const trackEl = slider.parentElement!;
  trackEl.getBoundingClientRect = () => ({ width, height: 56, top: 0, left: 0, right: width, bottom: 56, x: 0, y: 0, toJSON: () => ({}) });
  const travel = width - 48 - 8;
  fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(slider, { clientX: travel * to, pointerId: 1 });
  fireEvent.pointerUp(slider, { clientX: travel * to, pointerId: 1 });
}

const slider = () => screen.getByRole('slider');

describe('swipe to confirm', () => {
  it('[critical] a tap does nothing', () => {
    const onConfirm = vi.fn();
    render(<SwipeToConfirm label="Swipe to sell" onConfirm={onConfirm} />);
    fireEvent.click(slider());
    swipe(slider(), 0);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('[critical] a drag most of the way, let go, springs back and does nothing', () => {
    const onConfirm = vi.fn();
    render(<SwipeToConfirm label="Swipe to sell" onConfirm={onConfirm} />);
    swipe(slider(), 0.7);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(slider()).toHaveAttribute('aria-valuenow', '0');
  });

  it('[critical] a drag all the way confirms, once', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    render(<SwipeToConfirm label="Swipe to sell" onConfirm={onConfirm} />);
    swipe(slider(), 1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
    // swiping again while it is sending does not send twice
    swipe(slider(), 1);
    fireEvent.keyDown(slider(), { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByText('Sending…')).toBeNull());
  });

  it('Enter confirms from the keyboard', () => {
    const onConfirm = vi.fn();
    render(<SwipeToConfirm label="Swipe to close" onConfirm={onConfirm} />);
    fireEvent.keyDown(slider(), { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('[critical] disabled cannot be swiped or pressed, and says why', () => {
    const onConfirm = vi.fn();
    render(<SwipeToConfirm label="Swipe to sell" disabledLabel="Can’t sell" disabled onConfirm={onConfirm} />);
    swipe(slider(), 1);
    fireEvent.keyDown(slider(), { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('Can’t sell')).toBeInTheDocument();
    expect(slider()).toHaveAttribute('aria-disabled', 'true');
  });

  it('a failed action lets it be tried again', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('no')).mockResolvedValue(undefined);
    render(<SwipeToConfirm label="Swipe to close" onConfirm={onConfirm} />);
    swipe(slider(), 1);
    await waitFor(() => expect(screen.queryByText('Sending…')).toBeNull());
    swipe(slider(), 1);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('tells a screen reader what it does and how', () => {
    render(<SwipeToConfirm label="Swipe to close all" onConfirm={() => {}} />);
    expect(slider()).toHaveAccessibleName('Swipe to close all. Swipe all the way right, or press Enter, to confirm.');
  });
});
