import { DestroyRef, effect, type ElementRef, inject, type Signal, signal } from '@angular/core';

/**
 * The width in pixels of an element, kept up to date as it is resized. A chart lays itself out in
 * real pixels (its text stays the size of the page's text instead of scaling with the picture), so
 * it needs to know how much room it has.
 *
 * Until the element has been measured, and wherever there is no `ResizeObserver` (the unit tests,
 * which have no layout), the width is `fallback`. Call it in an injection context.
 */
export function elementWidth(
  element: Signal<ElementRef<HTMLElement> | undefined>,
  fallback: number,
): Signal<number> {
  const width = signal(fallback);
  if (typeof ResizeObserver === 'undefined') return width.asReadonly();

  const observer = new ResizeObserver((entries) => {
    const entry = entries.at(-1);
    if (!entry) return;
    const measured = Math.round(entry.contentRect.width);
    // A hidden element measures 0: keep the last real width instead of laying out in nothing.
    if (measured > 0) width.set(measured);
  });
  inject(DestroyRef).onDestroy(() => observer.disconnect());

  effect((onCleanup) => {
    const target = element()?.nativeElement;
    if (!target) return;
    observer.observe(target);
    onCleanup(() => observer.unobserve(target));
  });
  return width.asReadonly();
}
