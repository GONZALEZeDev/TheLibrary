/**
 * Validation and mapping of deadlock-api's map asset (`GET /v1/assets/map`).
 *
 * The response describes the minimap picture, the world radius, the position of every objective and
 * the zip lines (plus crates, camps and other entities the app does not read). The app keeps the
 * picture link, the radius, the objective positions and the zip lines projected onto the picture,
 * so that the interface never deals in world units.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';
import { worldToRelative, type RelativePoint } from '../match-map/map-geometry';
import { firstAssetImageUrl } from './assets.schema';

/** One zip line of the map, drawn as a coloured polyline on the minimap. */
export interface MapLane {
  /** Colour of the line, as `#rrggbb`. */
  readonly color: string;
  /** Points of the line along its length, on the minimap picture. */
  readonly points: readonly RelativePoint[];
}

/**
 * The map as the app uses it. It is plain JSON (no `Map`, no class) because it goes into the API
 * cache.
 */
export interface MapLayout {
  /** Half the side of the world square, in world units. */
  readonly radius: number;
  /** Link of the minimap picture on the asset bucket (`images.minimap`). */
  readonly imageUrl: string;
  /** Objective positions on the picture, by the API's own key (e.g. `team0_tier1_3`). */
  readonly objectivePositions: Readonly<Record<string, RelativePoint>>;
  /** The zip lines, from left to right (by the first point of each). */
  readonly lanes: readonly MapLane[];
}

/** A world coordinate: a finite number. */
const coordinateSchema = z.number();

/**
 * One zip line, as the API returns it. `P0_points` are offsets from `origin` along the line;
 * `P1_points` and `P2_points` are the Bezier handles of the curve and are not read.
 */
const ziplineSchema = z.object({
  origin: z.tuple([coordinateSchema, coordinateSchema, coordinateSchema]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  P0_points: z.array(z.tuple([coordinateSchema, coordinateSchema, coordinateSchema])).min(1),
});

/** An objective position as the API gives it: already relative to the picture. */
const objectivePositionSchema = z.object({
  left_relative: coordinateSchema,
  top_relative: coordinateSchema,
});

/** The map asset (only the fields the app uses; Zod drops the others). */
const mapBodySchema = z.object({
  radius: z.number().positive(),
  images: z.object({ minimap: z.unknown().optional() }),
  objective_positions: z.record(z.string(), objectivePositionSchema),
  zipline_paths: z.array(ziplineSchema),
});

/**
 * Validate the map asset and project its zip lines onto the minimap picture.
 *
 * A point of a line is its `origin` plus the offset of a `P0_points` entry, taken on the ground plane
 * (the height is left out) and projected with {@link worldToRelative}.
 *
 * @param body - The parsed JSON body of the response.
 * @returns The map layout, with its lanes sorted left to right by their first point.
 * @throws AppError of kind `invalid_payload` when the body is not a readable map, or when the
 *   minimap picture is not on the asset bucket. The context `issue` is `<path>: <code>` of the
 *   first problem, never a value of the payload.
 */
export function parseMapLayout(body: unknown): MapLayout {
  const parsed = mapBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('invalid_payload', 'The map asset is not readable', {
      context: { issue: describeFirstIssue(parsed.error) },
    });
  }
  const { radius, images, objective_positions: positions, zipline_paths: ziplines } = parsed.data;
  // The picture is loaded by the webview: it must come from the asset bucket the CSP allows.
  const imageUrl = firstAssetImageUrl([images.minimap]);
  if (imageUrl === null) {
    throw new AppError('invalid_payload', 'The map picture is not on the asset bucket', {
      context: { issue: 'images.minimap: invalid_value' },
    });
  }
  const objectivePositions = Object.fromEntries(
    Object.entries(positions).map(([key, position]) => [
      key,
      { left: position.left_relative, top: position.top_relative },
    ]),
  );
  const lanes = ziplines
    .map((line): MapLane => ({
      color: line.color,
      points: line.P0_points.map((offset) =>
        worldToRelative({ x: line.origin[0] + offset[0], y: line.origin[1] + offset[1] }, radius),
      ),
    }))
    .toSorted((first, second) => (first.points[0]?.left ?? 0) - (second.points[0]?.left ?? 0));
  return { radius, imageUrl, objectivePositions, lanes };
}
