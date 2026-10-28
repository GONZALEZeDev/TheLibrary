/**
 * Tests of the panel of evidence: where it stands on screen, and that it follows its wrapper.
 *
 * What the panel says and when it opens are tested through the rows that use it (the metrics of the
 * match page, the damage sources, the rows of the review).
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidencePanel, placePanel, type ScreenBox } from './EvidencePanel';

/** A window of 1,200 × 800 pixels. */
const VIEWPORT = { width: 1200, height: 800 };

/** A panel of 200 × 100 pixels. */
const PANEL = { width: 200, height: 100 };

/**
 * A row of 400 × 30 pixels at a place on screen.
 *
 * @param top - Its top edge.
 * @param left - Its left edge.
 * @returns Its box.
 */
function rowAt(top: number, left = 300): ScreenBox {
  return { top, left, width: 400, height: 30 };
}

describe('placePanel', () => {
  it('opens the panel under the wrapper, from its left edge by default', () => {
    expect(placePanel(rowAt(100), PANEL, VIEWPORT, 'start')).toEqual({ top: 130, left: 300 });
  });

  it('lines the panel up with the right edge of the wrapper at the end', () => {
    expect(placePanel(rowAt(100), PANEL, VIEWPORT, 'end')).toEqual({ top: 130, left: 500 });
  });

  it('opens the panel above the wrapper when the window has no room under it', () => {
    // 700 + 30 + 100 is past the bottom of the window less its margin.
    expect(placePanel(rowAt(700), PANEL, VIEWPORT, 'start')).toEqual({ top: 600, left: 300 });
  });

  it('keeps the panel under the wrapper when it just fits above the margin', () => {
    // 662 + 30 + 100 = 792, the bottom of the window less its 8 pixels.
    expect(placePanel(rowAt(662), PANEL, VIEWPORT, 'start').top).toBe(692);
  });

  it('keeps the panel inside the window on the side with the more room when it fits on neither', () => {
    const tall = { width: 200, height: 500 };
    // 300 pixels above the row, 470 under it: under, pushed up to stay inside.
    expect(placePanel(rowAt(300), tall, VIEWPORT, 'start').top).toBe(292);
    // 500 pixels above the row, 270 under it: above, pushed down to stay inside.
    expect(placePanel(rowAt(500), tall, VIEWPORT, 'start').top).toBe(8);
  });

  it('keeps the panel inside the window on the left and on the right', () => {
    expect(placePanel(rowAt(100, -50), PANEL, VIEWPORT, 'start').left).toBe(8);
    expect(placePanel(rowAt(100, 1000), PANEL, VIEWPORT, 'start').left).toBe(992);
    expect(placePanel(rowAt(100, -300), PANEL, VIEWPORT, 'end').left).toBe(8);
  });

  it('keeps the top left corner of a panel larger than the window inside it', () => {
    const huge = { width: 2000, height: 1000 };
    expect(placePanel(rowAt(100), huge, VIEWPORT, 'end')).toEqual({ top: 8, left: 8 });
  });
});

describe('EvidencePanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Render a panel whose wrapper and panel have a box on screen, as jsdom draws nothing.
   *
   * @param wrapperBox - The box of the wrapper, which a test may move.
   * @param shown - Whether the style sheet shows the panel, which jsdom does not apply: a hidden
   *   panel has no box. Shown unless a test says otherwise.
   * @returns The wrapper and the panel.
   */
  function renderPlaced(wrapperBox: { current: ScreenBox }, shown = { current: true }) {
    render(
      <EvidencePanel label="KDA" lines={['Your median: 2.0']} placement="end">
        <span>KDA</span>
      </EvidencePanel>,
    );
    const wrapper = screen.getByRole('group');
    const panel = screen.getByRole('tooltip', { hidden: true });
    vi.spyOn(wrapper, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect(wrapperBox.current),
    );
    vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ x: 0, y: 0, ...PANEL }),
    );
    // A list of one box when the panel is shown, of none when it is hidden, as a browser gives it.
    vi.spyOn(panel, 'getClientRects').mockImplementation(
      () =>
        (shown.current
          ? [DOMRect.fromRect({ x: 0, y: 0, ...PANEL })]
          : []) as unknown as DOMRectList,
    );
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(VIEWPORT.width);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(VIEWPORT.height);
    return { wrapper, panel };
  }

  it('places the panel on screen when the pointer comes, and follows the wrapper as the page scrolls', async () => {
    const user = userEvent.setup();
    const box = { current: { ...rowAt(100), x: 300, y: 100 } };
    const { wrapper, panel } = renderPlaced(box);
    // Invisible until it is placed, so that it never shows in the corner of the window.
    expect(panel).toHaveClass('invisible', 'data-placed:visible');
    expect(panel).not.toHaveAttribute('data-placed');

    await user.hover(wrapper);

    expect(panel).toHaveStyle({ top: '130px', left: '500px' });
    expect(panel).toHaveAttribute('data-placed');

    // The page scrolls under the pointer: the panel follows the row.
    box.current = { ...rowAt(700), x: 300, y: 700 };
    document.dispatchEvent(new Event('scroll'));

    expect(panel).toHaveStyle({ top: '600px', left: '500px' });
  });

  it('stops following the wrapper once the pointer has left', async () => {
    const user = userEvent.setup();
    const box = { current: { ...rowAt(100), x: 300, y: 100 } };
    const { wrapper, panel } = renderPlaced(box);
    await user.hover(wrapper);
    await user.unhover(wrapper);
    expect(panel).not.toHaveAttribute('data-placed');

    box.current = { ...rowAt(700), x: 300, y: 700 };
    document.dispatchEvent(new Event('scroll'));

    expect(panel).toHaveStyle({ top: '130px' });
  });

  it('does not place a panel the style sheet hides, and places it when it shows again', async () => {
    const user = userEvent.setup();
    const box = { current: { ...rowAt(100), x: 300, y: 100 } };
    const shown = { current: true };
    const { wrapper, panel } = renderPlaced(box, shown);
    // A click gives the focus, but not a keyboard focus: once the pointer leaves, the style sheet
    // hides the panel while the focus stays.
    await user.click(wrapper);
    shown.current = false;
    await user.unhover(wrapper);

    // The page scrolls: the hidden panel, which has no size, is not placed by it.
    box.current = { ...rowAt(700), x: 300, y: 700 };
    document.dispatchEvent(new Event('scroll'));
    expect(panel).not.toHaveAttribute('data-placed');

    // The pointer comes back: the panel shows, placed where the row is now.
    shown.current = true;
    await user.hover(wrapper);
    expect(panel).toHaveStyle({ top: '600px', left: '500px' });
    expect(panel).toHaveAttribute('data-placed');
  });

  it('hides the panel while its wrapper is out of the window, and shows it when it comes back', async () => {
    const user = userEvent.setup();
    const box = { current: { ...rowAt(100), x: 300, y: 100 } };
    const { wrapper, panel } = renderPlaced(box);
    await user.hover(wrapper);

    // Scrolled above the window, then below it: the panel would float over other rows.
    box.current = { ...rowAt(-40), x: 300, y: -40 };
    document.dispatchEvent(new Event('scroll'));
    expect(panel).not.toHaveAttribute('data-placed');
    box.current = { ...rowAt(801), x: 300, y: 801 };
    document.dispatchEvent(new Event('scroll'));
    expect(panel).not.toHaveAttribute('data-placed');

    box.current = { ...rowAt(100), x: 300, y: 100 };
    document.dispatchEvent(new Event('scroll'));
    expect(panel).toHaveAttribute('data-placed');
    expect(panel).toHaveStyle({ top: '130px' });
  });

  it('leaves the panel unplaced once Escape closed it', async () => {
    const user = userEvent.setup();
    const box = { current: { ...rowAt(100), x: 300, y: 100 } };
    const { wrapper, panel } = renderPlaced(box);
    await user.click(wrapper);
    expect(panel).toHaveAttribute('data-placed');

    await user.keyboard('{Escape}');

    expect(panel).not.toHaveAttribute('data-placed');
  });
});
