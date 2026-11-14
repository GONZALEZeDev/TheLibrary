/**
 * A game icon for the HTML parts of the replay: the picture of the asset bucket while it loads,
 * and a drawn shape in its place when it fails, in the very same box so that nothing around it
 * moves. (The map is an SVG and draws its own fallback.)
 *
 * @packageDocumentation
 */

import { useEffect, useState } from 'react';
import {
  GAME_ICONS,
  gameIconContentScale,
  type GameIconId,
} from '../../../../core/match-map/game-icons';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import { TEAM_FILL, TEAM_TEXT } from './team-style';

/** The shape drawn when the picture of an icon cannot be loaded. */
export type GameIconFallback = 'circle' | 'diamond' | 'square';

/** The props of {@link GameIcon}. */
export interface GameIconProps {
  /** Which icon to show. */
  readonly icon: GameIconId;
  /** What the icon is, read by screen readers (the alternative text of the picture). */
  readonly label: string;
  /** The side of the square box the icon fills, in pixels. */
  readonly size: number;
  /** The shape drawn instead of the picture when it fails to load. */
  readonly fallback: GameIconFallback;
  /** Whether the icon only decorates a text that already says what it is (hidden from readers). */
  readonly decorative?: boolean;
  /**
   * Paints the icon in one flat colour: a team's, or `'neutral'` for the muted text colour. The
   * picture then only serves as a mask, so the colour of the file itself is ignored.
   */
  readonly tint?: TeamIdentity | 'neutral';
}

/**
 * The background class of a tinted icon (the colour that shows through the mask).
 *
 * @param tint - The team of the icon, or `'neutral'`.
 * @returns The `bg-` class.
 */
function tintFill(tint: TeamIdentity | 'neutral'): string {
  return tint === 'neutral' ? 'bg-fg-muted' : TEAM_FILL[tint];
}

/**
 * The text class of a tinted fallback shape (the shape is filled with `currentColor`).
 *
 * @param tint - The team of the icon, or `'neutral'`.
 * @returns The `text-` class.
 */
function tintText(tint: TeamIdentity | 'neutral'): string {
  return tint === 'neutral' ? 'text-fg-muted' : TEAM_TEXT[tint];
}

/** The shape of each fallback, in a 24 by 24 box, filled with the text colour of the parent. */
const FALLBACK_SHAPES: Readonly<Record<GameIconFallback, React.JSX.Element>> = {
  circle: <circle cx="12" cy="12" r="10" fill="currentColor" />,
  diamond: <polygon points="12,1 23,12 12,23 1,12" fill="currentColor" />,
  square: <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" />,
};

/**
 * One game icon: the picture of the bucket, or the drawn fallback once the picture has failed.
 *
 * @returns The picture or the drawn shape, both `size` pixels wide and high.
 */
export function GameIcon({ icon, label, size, fallback, decorative = false, tint }: GameIconProps) {
  // The icon whose picture failed: a different icon gets its own try.
  const [failedIcon, setFailedIcon] = useState<GameIconId | null>(null);

  const tinted = tint !== undefined;
  // Some files carry transparent margin: the drawing is enlarged, the outer box is not.
  const contentScale = gameIconContentScale(icon);
  const enlarged = contentScale !== 1;

  // A mask has no load event, so a tinted icon preloads its picture to learn whether it failed.
  useEffect(() => {
    if (!tinted) {
      return;
    }
    const probe = new Image();
    probe.onerror = () => {
      setFailedIcon(icon);
    };
    // A CSS mask is fetched in CORS mode, so the probe is too: it fails exactly when the mask
    // would.
    probe.crossOrigin = 'anonymous';
    probe.src = GAME_ICONS[icon];
    return () => {
      // A stale probe must not report the failure of an icon that is no longer shown.
      probe.onerror = null;
    };
  }, [icon, tinted]);

  if (failedIcon === icon) {
    return (
      <svg
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative ? true : undefined}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={tint === undefined ? 'shrink-0' : `shrink-0 ${tintText(tint)}`}
      >
        {FALLBACK_SHAPES[fallback]}
      </svg>
    );
  }
  if (tint !== undefined) {
    // The picture is the mask and the team colour is the background that shows through it.
    const mask = `url("${GAME_ICONS[icon]}")`;
    // The mask is as large as the scale says and stays centred, so it overflows the box evenly.
    const maskSize = enlarged ? `${String(contentScale * 100)}%` : 'contain';
    return (
      <span
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative ? true : undefined}
        className={`inline-block shrink-0 ${tintFill(tint)}`}
        style={{
          width: size,
          height: size,
          maskImage: mask,
          maskSize,
          maskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskImage: mask,
          WebkitMaskSize: maskSize,
          WebkitMaskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
        }}
      />
    );
  }
  return (
    <img
      src={GAME_ICONS[icon]}
      alt={decorative ? '' : label}
      width={size}
      height={size}
      className="shrink-0 object-contain"
      // The box keeps its size; only the drawing grows, overflowing the box around its centre.
      style={enlarged ? { transform: `scale(${String(contentScale)})` } : undefined}
      onError={() => {
        setFailedIcon(icon);
      }}
    />
  );
}
