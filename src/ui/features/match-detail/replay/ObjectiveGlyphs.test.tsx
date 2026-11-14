/**
 * Tests of the objective glyphs: the generic shapes the tracks and the map draw for the Titans,
 * the Cores and the Shrines.
 *
 * @packageDocumentation
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ObjectiveGlyph, ObjectiveGlyphPath } from './ObjectiveGlyphs';

afterEach(cleanup);

/** Renders a bare glyph path inside an SVG, as the map does, and returns its group. */
function renderPath(props: Partial<Parameters<typeof ObjectiveGlyphPath>[0]> = {}): SVGGElement {
  const { container } = render(
    <svg>
      <ObjectiveGlyphPath
        kind="titan"
        size={10}
        team="hidden_king"
        destroyed={false}
        opensDown={false}
        {...props}
      />
    </svg>,
  );
  const group = container.querySelector('g');
  if (group === null) {
    throw new Error('The glyph rendered no group');
  }
  return group;
}

describe('ObjectiveGlyphPath', () => {
  it('draws a Titan as a thick arc path', () => {
    const g = renderPath({ kind: 'titan', team: 'archmother' });
    const path = g.querySelector('path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('fill')).toBe('none');
    expect(path?.getAttribute('class')).toContain('stroke-team-archmother');
    expect(Number(path?.getAttribute('stroke-width'))).toBeGreaterThan(1);
  });

  it('opens the Titan arc up or down', () => {
    const up = renderPath({ opensDown: false }).querySelector('path')?.getAttribute('d');
    cleanup();
    const down = renderPath({ opensDown: true }).querySelector('path')?.getAttribute('d');
    expect(up).not.toBe(down);
  });

  it('draws a Core as a solid diamond, filled and not stroked', () => {
    const polygon = renderPath({ kind: 'core' }).querySelector('polygon');
    expect(polygon).not.toBeNull();
    expect(polygon?.getAttribute('class')).toContain('fill-team-hidden-king');
    expect(polygon?.getAttribute('class')).not.toContain('stroke-');
  });

  it('draws a Shrine as a hollow diamond', () => {
    const polygon = renderPath({ kind: 'shrine', team: 'archmother' }).querySelector('polygon');
    expect(polygon?.getAttribute('fill')).toBe('none');
    expect(polygon?.getAttribute('class')).toContain('stroke-team-archmother');
  });

  it.each(['titan', 'core', 'shrine'] as const)(
    'draws a destroyed %s dashed, unfilled and faded',
    (kind) => {
      const g = renderPath({ kind, destroyed: true });
      const shape = g.querySelector('path, polygon');
      expect(shape?.getAttribute('fill')).toBe('none');
      expect(shape?.getAttribute('stroke-dasharray')).not.toBeNull();
      expect(Number(g.getAttribute('opacity'))).toBeLessThan(1);
    },
  );

  it.each(['titan', 'core', 'shrine'] as const)(
    'outlines a destroyed %s with the stroke class only, so no fill class can win',
    (kind) => {
      const shape = renderPath({ kind, team: 'archmother', destroyed: true }).querySelector(
        'path, polygon',
      );
      expect(shape?.getAttribute('class')).toContain('stroke-team-archmother');
      expect(shape?.getAttribute('class')).not.toContain('fill-');
    },
  );

  it('uses the muted colour for a neutral glyph', () => {
    expect(renderPath({ kind: 'core', team: 'neutral' }).innerHTML).toContain('fill-fg-muted');
    cleanup();
    expect(renderPath({ kind: 'shrine', team: 'neutral' }).innerHTML).toContain('stroke-fg-muted');
  });

  it('adds the extra layout class without touching the colour', () => {
    const polygon = renderPath({ kind: 'shrine', className: 'opacity-80' }).querySelector(
      'polygon',
    );
    expect(polygon?.getAttribute('class')).toContain('opacity-80');
    expect(polygon?.getAttribute('class')).toContain('stroke-team-hidden-king');
  });

  it.each([false, true])('keeps the Titan arc and its stroke in the box (opensDown %s)', (down) => {
    const path = renderPath({ kind: 'titan', size: 20, opensDown: down }).querySelector('path');
    // The path is "M -r cy A r r 0 0 sweep r cy": the numbers hold the radius and the ring's y.
    const numbers = (path?.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const radius = numbers[2] ?? 0;
    const centreY = numbers[1] ?? 0;
    const halfWidth = Number(path?.getAttribute('stroke-width')) / 2;
    // Horizontally the outer edge of the stroke is inside the box.
    expect(radius + halfWidth).toBeLessThanOrEqual(10);
    // Vertically the outer edge of the arc is inside the box too.
    const farEdge = centreY + (down ? -1 : 1) * (radius + halfWidth);
    expect(Math.abs(centreY)).toBeLessThanOrEqual(10);
    expect(Math.abs(farEdge)).toBeLessThanOrEqual(10);
  });

  it('keeps a living glyph undashed and fully opaque', () => {
    const g = renderPath({ kind: 'shrine' });
    expect(g.querySelector('polygon')?.getAttribute('stroke-dasharray')).toBeNull();
    expect(g.getAttribute('opacity')).toBeNull();
  });
});

describe('ObjectiveGlyph', () => {
  it('wraps the glyph in a labelled inline svg of the given size', () => {
    render(<ObjectiveGlyph kind="core" size={12} team="hidden_king" label="Core" />);
    const svg = screen.getByRole('img', { name: 'Core' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.getAttribute('width')).toBe('12');
    expect(svg.getAttribute('height')).toBe('12');
    expect(svg.querySelector('polygon')).not.toBeNull();
  });

  it('hides a decorative glyph from readers', () => {
    render(<ObjectiveGlyph kind="titan" size={12} team="neutral" decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens a Titan down on request, and up by default', () => {
    const down = render(<ObjectiveGlyph kind="titan" size={12} team="neutral" opensDown />)
      .container.querySelector('path')
      ?.getAttribute('d');
    cleanup();
    const up = render(<ObjectiveGlyph kind="titan" size={12} team="neutral" />)
      .container.querySelector('path')
      ?.getAttribute('d');
    expect(down).not.toBe(up);
  });
});
