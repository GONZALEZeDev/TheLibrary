/**
 * Tests of the validation and projection of deadlock-api's map asset.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { worldToRelative } from '../match-map/map-geometry';
import { ASSET_IMAGE_ORIGIN } from './assets.schema';
import { parseMapLayout } from './map.schema';

/** Half-width of the playable square in world units, as the real response gives it. */
const RADIUS = 10_752;

/** The minimap image link, on the asset bucket. */
const MINIMAP_URL = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/maps/minimap_midtown_mid.png`;

/**
 * The map asset in the shape of the API, trimmed from a real response: the radius, the images, two
 * objective positions, three zip lines reduced to a few offsets, and the entries the app ignores.
 * The zip lines come in an order that is NOT left to right, so the sort is exercised.
 *
 * @param overrides - Fields to change.
 * @returns A raw response body.
 */
function rawMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    radius: RADIUS,
    images: { minimap: MINIMAP_URL, plain: MINIMAP_URL, frame: `${ASSET_IMAGE_ORIGIN}frame.png` },
    objective_positions: {
      team0_core: { left_relative: 0.2905, top_relative: 0.92 },
      team1_tier1_3: { left_relative: 0.4095, top_relative: 0.0 },
    },
    zipline_paths: [
      {
        // Rightmost lane: starts at x = 1218.
        origin: [1218, 10784, 1524],
        color: '#F1CC30',
        P0_points: [
          [0, 0, 0],
          [0, -1158, 288],
          [16, -1847, 708],
        ],
        P1_points: [[9, 9, 9]],
        P2_points: [[9, 9, 9]],
        color_parsed: [241, 204, 48],
      },
      {
        // Leftmost lane: starts at x = -1280.
        origin: [-1280, -10774, 1472],
        color: '#29b1cc',
        P0_points: [
          [0, 0, 0],
          [0, 1158, 288],
          [0, 1847, 708],
        ],
        P1_points: [[9, 9, 9]],
        P2_points: [[9, 9, 9]],
      },
      {
        origin: [-1088, -10790, 1472],
        color: '#59b247',
        P0_points: [
          [0, 0, 0],
          [0, 1158, 288],
        ],
      },
    ],
    neutral_camps: [{ name: 'dock_camp', kind: 'strong' }],
    entities: { crates: [{ position: [-8976, 3840, 640.5], kind: 'wooden_crate' }] },
    ...overrides,
  };
}

describe('parseMapLayout', () => {
  it('parses radius, image, positions', () => {
    const layout = parseMapLayout(rawMap());

    expect(layout.radius).toBe(RADIUS);
    expect(layout.imageUrl).toBe(MINIMAP_URL);
    expect(layout.objectivePositions).toEqual({
      team0_core: { left: 0.2905, top: 0.92 },
      team1_tier1_3: { left: 0.4095, top: 0 },
    });
  });

  it('lanes are origin + P0 points projected, sorted by first point left', () => {
    const { lanes } = parseMapLayout(rawMap());

    expect(lanes.map((lane) => lane.color)).toEqual(['#29b1cc', '#59b247', '#F1CC30']);
    // The first lane's second point is its origin plus the offset [0, 1158].
    expect(lanes[0]?.points).toEqual([
      worldToRelative({ x: -1280, y: -10774 }, RADIUS),
      worldToRelative({ x: -1280, y: -10774 + 1158 }, RADIUS),
      worldToRelative({ x: -1280, y: -10774 + 1847 }, RADIUS),
    ]);
    // The offsets of the third lane move its x too (16 on the last point).
    expect(lanes[2]?.points[2]).toEqual(worldToRelative({ x: 1218 + 16, y: 10784 - 1847 }, RADIUS));
    const lefts = lanes.map((lane) => lane.points[0]?.left ?? Number.NaN);
    expect(lefts).toEqual(lefts.toSorted((first, second) => first - second));
  });

  it('projects a world point like the API does for its own crate entry', () => {
    const point = worldToRelative({ x: -8976, y: 3840 }, RADIUS);

    expect(point.left).toBeCloseTo(0.0826, 4);
    expect(point.top).toBeCloseTo(0.3214, 4);
  });

  it('is plain JSON, so that it can go in the API cache', () => {
    const layout = parseMapLayout(rawMap());

    expect(JSON.parse(JSON.stringify(layout))).toEqual(layout);
  });

  it('refuses an image off the asset bucket', () => {
    const body = rawMap({ images: { minimap: 'https://example.com/minimap.png' } });

    expect(() => parseMapLayout(body)).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });

  it('refuses a colour that is not #rrggbb', () => {
    const body = rawMap({
      zipline_paths: [{ origin: [0, 0, 0], color: 'red', P0_points: [[0, 0, 0]] }],
    });

    expect(() => parseMapLayout(body)).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });

  it('refuses a body that is not the map, without quoting a value', () => {
    expect(() => parseMapLayout(null)).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
    expect(() => parseMapLayout(rawMap({ radius: -5 }))).toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });

  it('ignores unknown keys (entities, neutral_camps)', () => {
    const layout = parseMapLayout(rawMap({ something_new: { a: 1 } }));

    expect(Object.keys(layout).toSorted()).toEqual([
      'imageUrl',
      'lanes',
      'objectivePositions',
      'radius',
    ]);
  });
});
