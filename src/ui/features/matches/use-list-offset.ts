/**
 * Where a windowed list sits in the element that scrolls it: the element itself (the closest
 * `<main>`) and how far the first row is from the top of its content, kept up to date as the page
 * above the list changes. The windowing hook (`./use-windowed-rows`) needs both to tell which rows
 * are visible.
 *
 * @packageDocumentation
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** What {@link useListOffset} gives the list. */
export interface ListOffset {
  /** The callback ref of the body of the list (its `<tbody>`). */
  readonly bodyRef: (element: HTMLTableSectionElement | null) => void;
  /** The element that scrolls the list, `<main>`; `null` before the body is mounted. */
  readonly scrollElement: HTMLElement | null;
  /** How far the first row is from the top of the content of the scrolling element, in pixels. */
  readonly listOffset: number;
}

/**
 * List the elements that sit above an element inside a container: its previous siblings, then the
 * previous siblings of each of its parents up to the container.
 *
 * @param element - The element, inside the container.
 * @param container - The element to stop at.
 * @returns The elements above, nearest first.
 */
function elementsAbove(element: Element, container: Element): Element[] {
  const above: Element[] = [];
  for (
    let current: Element | null = element;
    current !== null && current !== container;
    current = current.parentElement
  ) {
    for (
      let sibling = current.previousElementSibling;
      sibling !== null;
      sibling = sibling.previousElementSibling
    ) {
      above.push(sibling);
    }
  }
  return above;
}

/**
 * Find the element that scrolls a list and measure where the list starts in it.
 *
 * The body of the list and `<main>` are both set by the callback ref of the body once it is
 * mounted. `<main>` is held in state, so that the windowing hook listens to it as soon as there is
 * one; it is the closest one around the list, so the list asks nothing of the shell that draws it.
 * The body is only measured, so a ref is enough.
 *
 * The offset is what sits above the first row (the page header, the banner, the filters and the
 * header row). It is measured, not assumed: the top of the body relative to the top of `<main>`,
 * plus the distance `<main>` is scrolled by, which gives the same number whatever the scroll
 * position. It is measured before the browser paints, then again:
 * - whenever an element above the list changes height (an error line appears in the banner, a
 *   sentence wraps onto a second line): a `ResizeObserver` watches each element that sits above
 *   the list inside `<main>`, where the platform has one;
 * - when the window is resized and when `content` changes (a filter brings a new list): the
 *   fallback where there is no `ResizeObserver` (jsdom has none), harmless where there is one.
 *
 * @param content - What the list shows; a new value measures again.
 * @returns The ref of the body, the scrolling element and the offset.
 */
export function useListOffset(content: unknown): ListOffset {
  const body = useRef<HTMLTableSectionElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const bodyRef = useCallback((element: HTMLTableSectionElement | null) => {
    body.current = element;
    setScrollElement(element?.closest('main') ?? null);
  }, []);

  const [listOffset, setListOffset] = useState(0);
  useLayoutEffect(() => {
    const list = body.current;
    if (scrollElement === null || list === null) {
      return;
    }
    const measure = (): void => {
      setListOffset(
        list.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop,
      );
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const element of elementsAbove(list, scrollElement)) {
      observer?.observe(element);
    }
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [scrollElement, content]);

  return { bodyRef, scrollElement, listOffset };
}
