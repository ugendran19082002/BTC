import '@testing-library/jest-dom/vitest';

/**
 * jsdom has no layout, so it has none of the observers Radix uses to measure
 * things. Stubs are enough: nothing under test asserts on a measured size.
 */
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;

// Radix's slider and select both reach for these during a pointer interaction.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
