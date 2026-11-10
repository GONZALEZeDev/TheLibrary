/**
 * The projection of the game world onto the minimap picture.
 *
 * Deadlock positions are in world units, on a square centred on the origin; the minimap picture
 * shows that square, so a world point lands on the picture by a plain linear map.
 *
 * @packageDocumentation
 */
import type { MapPoint } from '../match-detail/player-paths';

/**
 * A position on the minimap picture, as a fraction of its size: `left` runs from 0 (left edge) to 1
 * (right edge) and `top` from 0 (top edge) to 1 (bottom edge). It stays valid whatever size the
 * picture is drawn at.
 */
export interface RelativePoint {
  /** Fraction of the picture width, from the left edge. */
  readonly left: number;
  /** Fraction of the picture height, from the top edge. */
  readonly top: number;
}

/**
 * Project a world position onto the minimap picture.
 *
 * The world y axis points up while the picture's top axis points down, hence the flip:
 * `left = (x + R) / 2R` and `top = (R - y) / 2R`.
 *
 * @param point - A world position.
 * @param radius - Half the side of the world square (`radius` of the map asset), in world units.
 * @returns The same place on the picture; outside 0 to 1 when the point is off the map.
 */
export function worldToRelative(point: MapPoint, radius: number): RelativePoint {
  const diameter = 2 * radius;
  return {
    left: (point.x + radius) / diameter,
    top: (radius - point.y) / diameter,
  };
}
