/**
 * Tests of the windowed rows hook: the window it answers for a long list, when the scrolling
 * container moves or resizes, when the container has no height, when the list starts below the top
 * of the container and when the number of rows changes.
 *
 * @packageDocumentation
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWindowedRows } from './use-windowed-rows';

/** Sizes used by every test: a 44 px row, 10 rows of overscan and at least 30 rows rendered. */
const ROW_HEIGHT = 44;
const OVERSCAN = 10;
const MIN_RENDERED = 30;

/**
 * Builds a scrolling container whose `scrollTop` and `clientHeight` the test controls (jsdom does
 * no layout, so both are always 0 otherwise). `scrollTo` moves the container and dispatches the
 * `scroll` event the browser would send.
 */
function makeScrollElement(clientHeight: number, scrollTop = 0) {
  const element = document.createElement('div');
  let currentHeight = clientHeight;
  let currentScrollTop = scrollTop;
  Object.defineProperty(element, 'clientHeight', { get: () => currentHeight });
  Object.defineProperty(element, 'scrollTop', { get: () => currentScrollTop });
  return {
    element,
    scrollTo(top: number) {
      currentScrollTop = top;
      element.dispatchEvent(new Event('scroll'));
    },
    resizeTo(height: number) {
      currentHeight = height;
      window.dispatchEvent(new Event('resize'));
    },
  };
}

/** Renders the hook with the shared sizes, letting a test override any argument. */
function renderWindow(
  initial: Partial<Parameters<typeof useWindowedRows>[0]> & {
    scrollElement: HTMLElement | null;
  },
) {
  return renderHook((props: Parameters<typeof useWindowedRows>[0]) => useWindowedRows(props), {
    initialProps: {
      count: 5_000,
      rowHeight: ROW_HEIGHT,
      overscan: OVERSCAN,
      minRendered: MIN_RENDERED,
      ...initial,
    },
  });
}

describe('useWindowedRows', () => {
  it('renders a bounded window of a long list', () => {
    const container = makeScrollElement(440);
    const { result } = renderWindow({ scrollElement: container.element });

    // 440 px show 10 rows; 10 more of overscan below; nothing above the first row.
    expect(result.current).toEqual({
      start: 0,
      end: 20,
      offsetTop: 0,
      totalHeight: 5_000 * ROW_HEIGHT,
    });
    expect(result.current.end - result.current.start).toBeLessThan(5_000);
  });

  it('moves the window when the container scrolls', () => {
    const container = makeScrollElement(440);
    const { result } = renderWindow({ scrollElement: container.element });

    // Row 100 is at the top of the container: 100 - 10 overscan above, 110 + 10 below.
    act(() => {
      container.scrollTo(100 * ROW_HEIGHT);
    });

    expect(result.current.start).toBe(90);
    expect(result.current.end).toBe(120);
    // The padding above the rendered rows is the height of the 90 rows left out.
    expect(result.current.offsetTop).toBe(90 * ROW_HEIGHT);
    expect(result.current.totalHeight).toBe(5_000 * ROW_HEIGHT);
  });

  it('renders the first rows when the container has no height', () => {
    const container = makeScrollElement(0, 100 * ROW_HEIGHT);
    const { result } = renderWindow({ scrollElement: container.element });

    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(MIN_RENDERED);

    // Without any element at all, the answer is the same.
    const withoutElement = renderWindow({ scrollElement: null });
    expect(withoutElement.result.current.start).toBe(0);
    expect(withoutElement.result.current.end).toBe(MIN_RENDERED);
  });

  it('counts the rows from the start of the list when the list starts below the top of the container', () => {
    // A page header and filters take 300 px above the list.
    const container = makeScrollElement(440, 300);
    const { result } = renderWindow({
      scrollElement: container.element,
      listOffset: 300,
    });

    // Scrolled exactly to the top of the list: the first row is at the top of the view.
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(20);

    // Scrolled 300 px (the header) plus 50 rows down, row 50 is at the top of the view.
    act(() => {
      container.scrollTo(300 + 50 * ROW_HEIGHT);
    });
    expect(result.current.start).toBe(40);
    expect(result.current.end).toBe(70);

    // The list still has the page header above it: no row is skipped near its start.
    act(() => {
      container.scrollTo(0);
    });
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(14);
  });

  it('clamps the window to the new number of rows when the list shrinks', () => {
    const container = makeScrollElement(440, 400 * ROW_HEIGHT);
    const { result, rerender } = renderWindow({ scrollElement: container.element });
    expect(result.current.end).toBe(420);

    // A filter leaves 50 rows while the container is still scrolled far past them.
    rerender({
      count: 50,
      rowHeight: ROW_HEIGHT,
      overscan: OVERSCAN,
      minRendered: MIN_RENDERED,
      scrollElement: container.element,
    });

    // The window sits past the end of the list: it falls back on the last rows, never beyond them.
    expect(result.current.start).toBe(50 - MIN_RENDERED);
    expect(result.current.end).toBe(50);
    expect(result.current.offsetTop).toBe(20 * ROW_HEIGHT);
    expect(result.current.totalHeight).toBe(50 * ROW_HEIGHT);
  });

  it('renders every row of a list shorter than the minimum, and nothing for an empty list', () => {
    const container = makeScrollElement(440);
    const short = renderWindow({ scrollElement: container.element, count: 12 });
    expect(short.result.current).toEqual({
      start: 0,
      end: 12,
      offsetTop: 0,
      totalHeight: 12 * ROW_HEIGHT,
    });

    const empty = renderWindow({ scrollElement: container.element, count: 0 });
    expect(empty.result.current).toEqual({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
  });

  it('follows a resize of the window', () => {
    const container = makeScrollElement(440);
    const { result } = renderWindow({ scrollElement: container.element });
    expect(result.current.end).toBe(20);

    // A taller container shows 40 rows, so the window reaches 40 + overscan rows.
    act(() => {
      container.resizeTo(40 * ROW_HEIGHT);
    });
    expect(result.current.end).toBe(50);
  });

  it('does not render again when a scroll leaves the window unchanged', () => {
    const container = makeScrollElement(440);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useWindowedRows({
        count: 5_000,
        rowHeight: ROW_HEIGHT,
        overscan: OVERSCAN,
        minRendered: MIN_RENDERED,
        scrollElement: container.element,
      });
    });
    expect(result.current.end).toBe(20);

    // One pixel down reveals a part of an eleventh row: the window grows by a row. This proves the
    // scroll listener is attached.
    act(() => {
      container.scrollTo(1);
    });
    expect(result.current.end).toBe(21);
    const before = renders;

    // Further down by less than one row height the same rows are visible: same window, no render.
    act(() => {
      container.scrollTo(2);
    });
    act(() => {
      container.scrollTo(4);
    });

    expect(result.current.end).toBe(21);
    expect(renders).toBe(before);
  });

  it('gives an empty window when the container is scrolled above a list that starts below it', () => {
    // The list starts 1000 px down, far below the 440 px the container shows: no row is in view or
    // near enough to be in the overscan.
    const container = makeScrollElement(440, 0);
    const { result } = renderWindow({ scrollElement: container.element, listOffset: 1_000 });

    expect(result.current).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 5_000 * ROW_HEIGHT,
    });
  });

  it('moves its listeners to the new element when the scroll element changes', () => {
    const first = makeScrollElement(440);
    const second = makeScrollElement(440, 100 * ROW_HEIGHT);
    const removeFromFirst = vi.spyOn(first.element, 'removeEventListener');
    const removeFromWindow = vi.spyOn(window, 'removeEventListener');
    const { result, rerender } = renderWindow({ scrollElement: first.element });
    expect(result.current.start).toBe(0);

    rerender({
      count: 5_000,
      rowHeight: ROW_HEIGHT,
      overscan: OVERSCAN,
      minRendered: MIN_RENDERED,
      scrollElement: second.element,
    });

    // The old element and the window lose their listeners, and the window follows the new element.
    expect(removeFromFirst).toHaveBeenCalledWith('scroll', expect.any(Function));
    expect(removeFromWindow).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(result.current.start).toBe(90);
    expect(result.current.end).toBe(120);

    // Scrolling the old element no longer moves the window; scrolling the new one does.
    act(() => {
      first.scrollTo(300 * ROW_HEIGHT);
    });
    expect(result.current.start).toBe(90);
    act(() => {
      second.scrollTo(200 * ROW_HEIGHT);
    });
    expect(result.current.start).toBe(190);
    removeFromWindow.mockRestore();
  });

  it('stops listening when it unmounts', () => {
    const container = makeScrollElement(440);
    const removeListener = vi.spyOn(container.element, 'removeEventListener');
    const { unmount } = renderWindow({ scrollElement: container.element });

    unmount();

    expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
