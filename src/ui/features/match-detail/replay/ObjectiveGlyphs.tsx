/**
 * The generic glyphs of the objectives: a half-ring for a Titan, a solid diamond for a Core and a
 * hollow diamond for a Shrine.
 *
 * They are plain geometric shapes, so the tracks (HTML, one inline `<svg>` per glyph) and the map
 * (one `<g>` inside its own SVG) draw the very same marks. The glyph picks its own colour classes
 * from the team: the fill class only for a living Core, the stroke class for every outline.
 *
 * @packageDocumentation
 */

import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import { TEAM_FILL, TEAM_STROKE } from './team-style';

/** What a glyph stands for. */
export type GlyphKind = 'titan' | 'core' | 'shrine';

/** The props of {@link ObjectiveGlyphPath}. */
export interface ObjectiveGlyphPathProps {
  /** Which shape to draw. */
  readonly kind: GlyphKind;
  /** The side of the square box the glyph fills, in the units of the surrounding SVG. */
  readonly size: number;
  /** The team that owns the objective, or `'neutral'` for the muted colour. */
  readonly team: TeamIdentity | 'neutral';
  /** Extra classes for layout only; the colour always comes from `team`. */
  readonly className?: string | undefined;
  /** Whether the objective is destroyed: same outline, no fill, dashed and faded. */
  readonly destroyed: boolean;
  /** Whether the opening of a Titan half-ring faces down (towards a base at the map's bottom). */
  readonly opensDown: boolean;
}

/** The opacity of a destroyed glyph. */
const DESTROYED_OPACITY = 0.55;

/**
 * The colour class of a glyph.
 *
 * @param team - The team of the objective, or `'neutral'`.
 * @param filled - Whether the shape is filled (a living Core) rather than outlined.
 * @returns The `fill-` class of a filled shape, the `stroke-` class of an outline.
 */
function glyphColor(team: TeamIdentity | 'neutral', filled: boolean): string {
  if (team === 'neutral') {
    return filled ? 'fill-fg-muted' : 'stroke-fg-muted';
  }
  return filled ? TEAM_FILL[team] : TEAM_STROKE[team];
}

/**
 * The glyph as a group centred on (0, 0), to be placed inside any `<svg>`.
 *
 * @returns The `<g>` holding the shape.
 */
export function ObjectiveGlyphPath({
  kind,
  size,
  team,
  className = '',
  destroyed,
  opensDown,
}: ObjectiveGlyphPathProps) {
  // Everything scales with the box, so a glyph looks the same at any size.
  const half = size / 2;
  const strokeWidth = Math.max(1, size * 0.12);
  // A destroyed glyph keeps its outline but is dashed, unfilled and faded.
  const dash = destroyed
    ? { strokeDasharray: `${String(size * 0.18)} ${String(size * 0.14)}` }
    : {};
  const opacity = destroyed ? DESTROYED_OPACITY : undefined;

  if (kind === 'titan') {
    // A thick half-ring: the sweep flag picks the top half (opens down) or the bottom half (opens
    // up). The ring and half its stroke reach 0.46 of the box, so nothing is clipped, and the ring
    // is shifted so that the visible arc is centred on (0, 0).
    const radius = size * 0.34;
    const ringWidth = size * 0.24;
    const centreY = ((opensDown ? 1 : -1) * (radius + ringWidth / 2)) / 2;
    const sweep = opensDown ? 1 : 0;
    return (
      <g opacity={opacity}>
        <path
          d={`M ${String(-radius)} ${String(centreY)} A ${String(radius)} ${String(radius)} 0 0 ${String(sweep)} ${String(radius)} ${String(centreY)}`}
          fill="none"
          className={`${glyphColor(team, false)} ${className}`}
          strokeWidth={ringWidth}
          strokeLinecap="butt"
          {...dash}
        />
      </g>
    );
  }

  // A diamond is a square turned by a quarter, drawn from its four corners.
  const reach = half * 0.8;
  const points = `0,${String(-reach)} ${String(reach)},0 0,${String(reach)} ${String(-reach)},0`;
  if (kind === 'core' && !destroyed) {
    return (
      <g>
        <polygon points={points} className={`${glyphColor(team, true)} ${className}`} />
      </g>
    );
  }
  return (
    <g opacity={opacity}>
      <polygon
        points={points}
        fill="none"
        className={`${glyphColor(team, false)} ${className}`}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        {...dash}
      />
    </g>
  );
}

/** The props of {@link ObjectiveGlyph}. */
export interface ObjectiveGlyphProps {
  /** Which shape to draw. */
  readonly kind: GlyphKind;
  /** The side of the square box, in pixels. */
  readonly size: number;
  /** The team that owns the objective, or `'neutral'` for the muted colour. */
  readonly team: TeamIdentity | 'neutral';
  /** Extra classes for the glyph's shapes (layout only). */
  readonly className?: string | undefined;
  /** Whether a Titan's opening faces down; the default is up. */
  readonly opensDown?: boolean;
  /** Whether the objective is destroyed (dashed, unfilled and faded). */
  readonly destroyed?: boolean;
  /** What the glyph is, read by screen readers. */
  readonly label?: string;
  /** Whether the glyph only decorates a text that already says what it is. */
  readonly decorative?: boolean;
}

/**
 * A standalone inline glyph, for the HTML parts of the replay (the tracks and the legend).
 *
 * @returns An `<svg>` of `size` pixels wide and high wrapping {@link ObjectiveGlyphPath}.
 */
export function ObjectiveGlyph({
  kind,
  size,
  team,
  className,
  opensDown = false,
  destroyed = false,
  label,
  decorative = false,
}: ObjectiveGlyphProps) {
  const hidden = decorative || label === undefined;
  return (
    <svg
      role={hidden ? undefined : 'img'}
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden ? true : undefined}
      viewBox={`${String(-size / 2)} ${String(-size / 2)} ${String(size)} ${String(size)}`}
      width={size}
      height={size}
      className="shrink-0"
    >
      <ObjectiveGlyphPath
        kind={kind}
        size={size}
        team={team}
        className={className}
        destroyed={destroyed}
        opensDown={opensDown}
      />
    </svg>
  );
}
