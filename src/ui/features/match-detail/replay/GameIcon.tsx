/**
 * A game icon for the HTML parts of the replay: the picture of the asset bucket while it loads,
 * and a drawn shape in its place when it fails, in the very same box so that nothing around it
 * moves. (The map is an SVG and draws its own fallback.)
 *
 * @packageDocumentation
 */

import { useState } from 'react';
import { GAME_ICONS, type GameIconId } from '../../../../core/match-map/game-icons';

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
export function GameIcon({ icon, label, size, fallback, decorative = false }: GameIconProps) {
  // The icon whose picture failed: a different icon gets its own try.
  const [failedIcon, setFailedIcon] = useState<GameIconId | null>(null);

  if (failedIcon === icon) {
    return (
      <svg
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative ? true : undefined}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className="shrink-0"
      >
        {FALLBACK_SHAPES[fallback]}
      </svg>
    );
  }
  return (
    <img
      src={GAME_ICONS[icon]}
      alt={decorative ? '' : label}
      width={size}
      height={size}
      className="shrink-0 object-contain"
      onError={() => {
        setFailedIcon(icon);
      }}
    />
  );
}
