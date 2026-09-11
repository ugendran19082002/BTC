import { fireEvent } from '@testing-library/react';

/**
 * Drag a SwipeToConfirm thumb along its track, as a finger would.
 *
 * jsdom has no layout, so the track is given a width first. `to` is how far
 * along, 0 to 1; 1 confirms.
 */
export function swipe(slider: HTMLElement, to = 1, width = 320) {
  const trackEl = slider.parentElement!;
  trackEl.getBoundingClientRect = () => ({ width, height: 56, top: 0, left: 0, right: width, bottom: 56, x: 0, y: 0, toJSON: () => ({}) });
  const travel = width - 48 - 8;
  fireEvent.pointerDown(slider, { clientX: 0, pointerId: 1 });
  fireEvent.pointerMove(slider, { clientX: travel * to, pointerId: 1 });
  fireEvent.pointerUp(slider, { clientX: travel * to, pointerId: 1 });
}

