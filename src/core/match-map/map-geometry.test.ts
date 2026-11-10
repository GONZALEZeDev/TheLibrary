import { describe, expect, it } from 'vitest';
import { worldToRelative } from './map-geometry';

/** Half the side of the world square on the current map. */
const RADIUS = 10752;

describe('worldToRelative', () => {
  it('puts the world origin at the centre of the picture', () => {
    expect(worldToRelative({ x: 0, y: 0 }, RADIUS)).toEqual({ left: 0.5, top: 0.5 });
  });

  it('matches the position the API gives for a known crate', () => {
    // The API reports this crate at left 0.0826 and top 0.3214 (rounded to 4 decimals).
    const point = worldToRelative({ x: -8976, y: 3840 }, RADIUS);
    expect(point.left).toBeCloseTo(0.0826, 4);
    expect(point.top).toBeCloseTo(0.3214, 4);
  });

  it('maps the four corners of the world square to the corners of the picture', () => {
    // The world y axis points up, so +y is the top edge of the picture.
    expect(worldToRelative({ x: -RADIUS, y: RADIUS }, RADIUS)).toEqual({ left: 0, top: 0 });
    expect(worldToRelative({ x: RADIUS, y: RADIUS }, RADIUS)).toEqual({ left: 1, top: 0 });
    expect(worldToRelative({ x: -RADIUS, y: -RADIUS }, RADIUS)).toEqual({ left: 0, top: 1 });
    expect(worldToRelative({ x: RADIUS, y: -RADIUS }, RADIUS)).toEqual({ left: 1, top: 1 });
  });

  it('goes outside 0 to 1 for a point off the map', () => {
    const point = worldToRelative({ x: 2 * RADIUS, y: -2 * RADIUS }, RADIUS);
    expect(point.left).toBe(1.5);
    expect(point.top).toBe(1.5);
  });
});
