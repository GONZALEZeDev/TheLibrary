/**
 * Tests of the bar of a share: the fill as long as the share, the optional mark of a second share,
 * the clamp that keeps both inside the box, and the fact that the bar is a picture for the eye that
 * says nothing to assistive technologies (the figure is always written beside it).
 *
 * @packageDocumentation
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShareBar } from './ShareBar';

/**
 * Draw a bar and find its parts.
 *
 * @param share - The share the bar draws.
 * @param mark - Where the mark stands, or nothing for a bar given no mark.
 * @returns The track, its fill, and its mark (`null` when there is none).
 */
function drawBar(
  share: number,
  mark?: number | null,
): { track: Element; fill: HTMLElement; mark: HTMLElement | null } {
  const { container } = render(
    mark === undefined ? <ShareBar share={share} /> : <ShareBar share={share} mark={mark} />,
  );
  const track = container.firstElementChild ?? expect.unreachable('The bar draws a track');
  return {
    track,
    fill: container.querySelector<HTMLElement>('.bg-accent') ?? expect.unreachable('A fill'),
    mark: container.querySelector<HTMLElement>('.bg-secondary'),
  };
}

describe('ShareBar', () => {
  it('draws a fill as long as the share', () => {
    expect(drawBar(0.46).fill.style.width).toBe('46%');
  });

  it('rounds the length to one decimal', () => {
    expect(drawBar(0.4666).fill.style.width).toBe('46.7%');
  });

  it('draws nothing for a share of zero, and the whole bar for a share of one', () => {
    expect(drawBar(0).fill.style.width).toBe('0%');
    expect(drawBar(1).fill.style.width).toBe('100%');
  });

  it('holds a share outside the bar to its ends', () => {
    expect(drawBar(1.2).fill.style.width).toBe('100%');
    expect(drawBar(-0.3).fill.style.width).toBe('0%');
  });

  it('has no mark unless it is given one', () => {
    expect(drawBar(0.46).mark).toBeNull();
    expect(drawBar(0.46, null).mark).toBeNull();
  });

  it('draws a mark where the second share stands', () => {
    expect(drawBar(0.46, 0.44).mark?.style.left).toBe('44%');
  });

  it('draws the mark of a share of zero, which is a share like another', () => {
    expect(drawBar(0.46, 0).mark?.style.left).toBe('0%');
  });

  it('holds the mark inside the bar too', () => {
    expect(drawBar(0.46, 1.4).mark?.style.left).toBe('100%');
    expect(drawBar(0.46, -0.2).mark?.style.left).toBe('0%');
  });

  it('puts the mark and the fill in the same track', () => {
    const bar = drawBar(0.46, 0.44);

    expect(bar.fill.parentElement).toBe(bar.track);
    expect(bar.mark?.parentElement).toBe(bar.track);
    // The fill comes first, then the mark over it.
    expect(bar.fill.compareDocumentPosition(bar.mark ?? bar.track)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('is hidden from assistive technologies and carries no text', () => {
    const { track } = drawBar(0.46, 0.44);

    // The figure is written beside the bar: the bar alone would say nothing a person could use.
    expect(track).toHaveAttribute('aria-hidden', 'true');
    expect(track.textContent).toBe('');
  });
});
