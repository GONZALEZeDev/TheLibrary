/**
 * Where the timeline chart of the match page draws each thing: the frame of the picture, the rows
 * of the markers under the souls, and the scales that turn a time of the match and an amount of
 * souls into a place in the picture.
 *
 * The chart is drawn in a fixed frame (its `viewBox`) that the page stretches to its width, so every
 * place here is in the units of that frame, not in pixels. Everything here is pure: the same input
 * gives the same place.
 *
 * @packageDocumentation
 */
import type { SoulsPoint } from '../../../services/match-timeline-view';

/**
 * The frame of the chart, from the top down: the names of the phases, the souls lines, the three
 * rows of markers (deaths, kills, purchases) and the time axis. The left and right edges leave room
 * for half the largest marker (the ring of an avoidable death picked in the list, drawn larger) at
 * the first and the last second of the match.
 */
export const CHART_FRAME = {
  /** The width of the frame. */
  width: 640,
  /** The height of the frame. */
  height: 224,
  /** Where the time of the start of the match stands. */
  left: 16,
  /** Where the time of the end of the match stands. */
  right: 624,
  /** The baseline of the names of the phases, at the top of their bands. */
  phaseNameY: 14,
  /** The top of the souls lines: the most souls of the match. */
  soulsTop: 24,
  /** The bottom of the souls lines: no souls. */
  soulsBottom: 140,
  /** The middle of the row of the deaths. */
  deathRowY: 158,
  /** The middle of the row of the kills. */
  killRowY: 178,
  /** The middle of the row of the purchases. */
  purchaseRowY: 196,
  /** The bottom of the bands of the phases, under the last row of markers. */
  bandBottom: 204,
  /** The baseline of the times of the axis. */
  axisY: 218,
} as const;

/**
 * The narrowest band whose phase is named: a phase the match barely reached (a late game of half a
 * minute) has no room for its name, which would run over the band beside it.
 */
export const MIN_NAMED_BAND_WIDTH = 48;

/** The size of the texts of the chart (the names of the phases, the times of the axis). */
export const CHART_TEXT_SIZE = 11;

/** The width of the souls lines and of the cross of a death. */
export const LINE_WIDTH = 2;

/** The dashes of the line of the lane opponents, which tell it from the line of the player. */
export const OPPONENT_DASHES = '6 4';

/** Half the size of a marker. */
const MARKER_HALF_SIZE = 4.5;

/**
 * The shapes of the markers, drawn around the point `(0, 0)` so that the chart and its legend place
 * them where they need them:
 * - the cross of a death, from corner to corner;
 * - the ring around the cross of an avoidable death, clear of its corners;
 * - the triangle of a kill, pointing up;
 * - the dot of a purchase, smaller than the others, as a match has many more purchases;
 * - the square the pointer can rest on over a death, larger than the thin strokes of its cross.
 */
export const MARKER_SHAPES = {
  crossPath: [
    ['M', -MARKER_HALF_SIZE, -MARKER_HALF_SIZE],
    ['L', MARKER_HALF_SIZE, MARKER_HALF_SIZE],
    ['M', -MARKER_HALF_SIZE, MARKER_HALF_SIZE],
    ['L', MARKER_HALF_SIZE, -MARKER_HALF_SIZE],
  ]
    .map((command) => command.join(' '))
    .join(' '),
  ringRadius: MARKER_HALF_SIZE * 1.9,
  ringWidth: 1.5,
  trianglePoints: [
    [0, -MARKER_HALF_SIZE],
    [MARKER_HALF_SIZE, MARKER_HALF_SIZE * 0.8],
    [-MARKER_HALF_SIZE, MARKER_HALF_SIZE * 0.8],
  ]
    .map((point) => point.join(','))
    .join(' '),
  dotRadius: MARKER_HALF_SIZE * 0.6,
  hitHalfSize: MARKER_HALF_SIZE * 2,
} as const;

/** How much larger the marker of the death picked in the list is drawn. */
const SELECTED_SCALE = 1.6;

/**
 * The `transform` that puts a marker at its place.
 *
 * @param x - The place across the frame.
 * @param y - The middle of the row of the marker.
 * @param selected - Whether the marker is the one of the death picked, drawn larger.
 * @returns The transform.
 */
export function markerTransform(x: number, y: number, selected = false): string {
  const place = `translate(${x.toFixed(1)} ${String(y)})`;
  return selected ? `${place} scale(${String(SELECTED_SCALE)})` : place;
}

/** The scales of a chart: where a time and an amount of souls stand in the frame. */
export interface ChartScales {
  /**
   * Where a time of the match stands across the frame.
   *
   * @param timeS - The time, in seconds since the start of the match.
   * @returns The place across the frame; a time outside the match stands at its nearer end.
   */
  readonly x: (timeS: number) => number;
  /**
   * Where an amount of souls stands up the frame.
   *
   * @param souls - The souls.
   * @returns The place up the frame: no souls at the bottom of the lines, the most at their top.
   */
  readonly y: (souls: number) => number;
}

/**
 * Make the scales of a chart.
 *
 * The time runs from the start of the match to its end, and the souls from none to the most that
 * any line reaches, so that the lines fill the height and the two of them share one scale.
 *
 * @param durationS - The length of the match, in seconds.
 * @param lines - The souls lines the chart draws; a line that is not drawn is `null`.
 * @returns The scales.
 */
export function chartScales(
  durationS: number,
  lines: readonly (readonly SoulsPoint[] | null)[],
): ChartScales {
  const { left, right, soulsTop, soulsBottom } = CHART_FRAME;
  // A match of no length or lines of no souls would divide by zero: one second and one soul
  // stand in for them, which leaves every line flat at the bottom.
  const lengthS = Math.max(1, durationS);
  const mostSouls = Math.max(1, ...lines.flatMap((line) => (line ?? []).map((p) => p.souls)));
  return {
    x: (timeS) => left + (Math.min(lengthS, Math.max(0, timeS)) / lengthS) * (right - left),
    y: (souls) => soulsBottom - (Math.max(0, souls) / mostSouls) * (soulsBottom - soulsTop),
  };
}

/**
 * Write the points of a souls line as the `points` of an SVG polyline.
 *
 * @param line - The points of the line, in the order of the match.
 * @param scales - The scales of the chart.
 * @returns The points, `x,y` pairs separated by spaces, rounded to a tenth of a unit of the frame.
 */
export function polylinePoints(line: readonly SoulsPoint[], scales: ChartScales): string {
  return line
    .map(({ timeS, souls }) => `${scales.x(timeS).toFixed(1)},${scales.y(souls).toFixed(1)}`)
    .join(' ');
}
