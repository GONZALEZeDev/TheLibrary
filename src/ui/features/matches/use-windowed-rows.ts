/**
 * Windowed rows: the hook that lets a very long list of fixed-height rows (the whole match history,
 * hundreds or thousands of rows) render only the rows near the visible part of the container that
 * scrolls it, with no library.
 *
 * The caller renders `rows.slice(start, end)` inside a box that is `totalHeight` tall and pushes the
 * rendered rows down by `offsetTop`, so the scrollbar and the position of every row stay those of
 * the full list. The hook counts rows and knows nothing about what a row is (a header row counts
 * like any other).
 *
 * @packageDocumentation
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** What the caller gives the hook. */
export interface WindowedRowsOptions {
  /** Number of rows of the whole list. */
  readonly count: number;
  /** Height of one row, in pixels. Must be a positive number; every row must have exactly this height. */
  readonly rowHeight: number;
  /** Rows rendered above and below the visible ones, so a fast scroll never shows an empty gap. */
  readonly overscan: number;
  /**
   * Rows rendered when the container reports no height (it is not laid out yet, or the tests run
   * without a layout engine): the first rows of the list. A list with fewer rows renders them all.
   */
  readonly minRendered: number;
  /**
   * The element that scrolls the list, or `null` while the caller does not have it yet (the hook
   * then answers the first `minRendered` rows). The page finds it once it is mounted, for example
   * with `document.querySelector('main')` in an effect stored in state, or holds it through a
   * callback ref: a state value, not a ref object, so that the hook listens to the element as soon
   * as there is one.
   */
  readonly scrollElement: HTMLElement | null;
  /**
   * Distance in pixels between the top of the scrolled content and the first row, for a list that
   * does not start at the top of the container (a page header and filters sit above it). Defaults
   * to 0. The caller measures it, for example with the `offsetTop` of the box that holds the rows
   * when the container is its offset parent.
   */
  readonly listOffset?: number;
}

/** The window the hook answers. */
export interface WindowedRows {
  /** Index of the first row to render. */
  readonly start: number;
  /** Index after the last row to render (exclusive), never above `count`. */
  readonly end: number;
  /** Height in pixels of the rows left out above the window: the padding above the rendered rows. */
  readonly offsetTop: number;
  /** Height in pixels of the whole list. */
  readonly totalHeight: number;
}

/** The part of {@link WindowedRows} that depends on the scroll position. */
interface RowRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Computes the range of rows to render from what the container reports.
 *
 * The rows in view run from the one at the top edge of the container down to the one at its bottom
 * edge, measured from the start of the list (`listOffset` is taken off the scroll position). The
 * overscan widens that range on both sides, and everything is clamped to the list. A container with
 * no height gives the first `minRendered` rows. A range that sits past the end of the list (the list
 * just got shorter) falls back on its last `minRendered` rows.
 *
 * @param options - The list and the row sizes (everything the caller gives but the element).
 * @param scrollTop - Pixels the container is scrolled by.
 * @param clientHeight - Visible height of the container in pixels, 0 when it has no layout.
 * @returns The first row to render and the index after the last one.
 */
function computeRange(
  options: Omit<WindowedRowsOptions, 'scrollElement'>,
  scrollTop: number,
  clientHeight: number,
): RowRange {
  const { count, rowHeight, overscan, minRendered, listOffset = 0 } = options;
  if (clientHeight <= 0) {
    return { start: 0, end: Math.min(count, minRendered) };
  }
  const viewTop = scrollTop - listOffset;
  const firstVisible = Math.floor(viewTop / rowHeight);
  const lastVisible = Math.ceil((viewTop + clientHeight) / rowHeight);
  const latestStart = Math.max(0, count - minRendered);
  return {
    start: Math.min(Math.max(0, firstVisible - overscan), latestStart),
    end: Math.min(count, Math.max(0, lastVisible + overscan)),
  };
}

/**
 * Tells which rows of a long, fixed-height list to render.
 *
 * It reads `scrollTop` and `clientHeight` of the scroll element when the element changes, when the
 * element scrolls (a passive `scroll` listener), when the window or the element is resized (a
 * `resize` listener on the window, plus a `ResizeObserver` on the element where the platform has one,
 * as jsdom has not) and when the sizes or the count change. The state changes only when the range of
 * rows changes, so a scroll that leaves the same rows in the window renders nothing. The listeners
 * are removed when the component unmounts and when the element changes.
 *
 * @param options - The list, the row sizes and the scroll element.
 * @returns The rows to render, and the heights that keep the scrollbar and the rows in place.
 */
export function useWindowedRows(options: WindowedRowsOptions): WindowedRows {
  const { count, rowHeight, overscan, minRendered, scrollElement, listOffset = 0 } = options;

  // The range measured last. It starts at the first rows: the effect below measures the element
  // before the browser paints, so the first rows never show when the element is already scrolled.
  const [range, setRange] = useState<RowRange>(() => ({
    start: 0,
    end: Math.min(count, minRendered),
  }));

  // The range last given to the state. Comparing with it, rather than with the state in an updater,
  // keeps React from rendering once more for a range that did not change.
  const lastRange = useRef(range);

  // Reads the element and updates the range only when it changed. Re-created only when a number it
  // depends on changes.
  const measure = useCallback(() => {
    const next = computeRange(
      { count, rowHeight, overscan, minRendered, listOffset },
      scrollElement?.scrollTop ?? 0,
      scrollElement?.clientHeight ?? 0,
    );
    if (lastRange.current.start !== next.start || lastRange.current.end !== next.end) {
      lastRange.current = next;
      setRange(next);
    }
  }, [count, rowHeight, overscan, minRendered, listOffset, scrollElement]);

  useLayoutEffect(() => {
    // Measure at once: the element, the count or a size just changed.
    measure();
    if (scrollElement === null) {
      return;
    }

    scrollElement.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    // The container can change size without the window doing so (a side panel opening, say).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scrollElement);

    return () => {
      scrollElement.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [measure, scrollElement]);

  // The state can be a render behind a shorter list (the effect has not run yet): clamp it, so a
  // row past the end is never asked for.
  const end = Math.min(range.end, count);
  const start = Math.min(range.start, end);
  return { start, end, offsetTop: start * rowHeight, totalHeight: count * rowHeight };
}
