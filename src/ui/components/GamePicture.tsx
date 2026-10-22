/**
 * The picture of a thing of the game (a hero, a rank, a damage source, an item), shown beside its
 * name.
 *
 * The pictures live on a remote bucket and the catalogues that hold their addresses are cached for
 * days, while the app is meant to work offline: a picture that cannot be loaded is the normal case,
 * not an accident. The component therefore never leaves the browser's broken-image icon on screen. A
 * picture that is missing from the catalogue and one that fails to load are the same to it, and are
 * replaced by the caller's choice: a neutral square of the same size, where the pictures of a list
 * line up the names beside them, or nothing, where a name stands alone.
 *
 * The picture is decorative: the name of the thing is always written beside it.
 *
 * @packageDocumentation
 */
import { useState } from 'react';

/** The two sizes of a picture of the game: beside one line of text, or beside two. */
export type GamePictureSize = 'small' | 'medium';

/** Props of {@link GamePicture}. */
export interface GamePictureProps {
  /** The picture on the asset bucket, or `null` when the catalogue gives none. */
  readonly src: string | null;
  /**
   * `small` (24 px): the header, the players tables. `medium` (32 px): a damage source, an item of
   * the build.
   */
  readonly size: GamePictureSize;
  /** How the picture fills its square: `cover` for a hero portrait, `contain` for an icon or a badge. */
  readonly fit: 'cover' | 'contain';
  /**
   * What stands in place of a picture that is missing or fails to load: `square`, a neutral square of
   * the same size, where the pictures of a list line up the names beside them; `none`, nothing, where
   * a name stands alone.
   */
  readonly fallback: 'square' | 'none';
}

/**
 * The size of each picture: in pixels, for the `width` and `height` attributes that give the browser
 * the box before the file arrives; and as the class that fixes the same size in CSS, as Tailwind's base
 * styles set `height: auto`. Each class is a complete literal for Tailwind.
 */
const SIZES = {
  small: { pixels: 24, box: 'size-6' },
  medium: { pixels: 32, box: 'size-8' },
} as const satisfies Record<GamePictureSize, { readonly pixels: number; readonly box: string }>;

/** The classes of each fit. Each is a complete literal for Tailwind. */
const FIT_CLASSES = {
  cover: 'object-cover',
  contain: 'object-contain',
} as const satisfies Record<GamePictureProps['fit'], string>;

/**
 * A picture of the game, with what stands in its place when it is missing or cannot be loaded.
 *
 * @returns The picture; or, when `src` is `null` or the address failed to load, the neutral square
 *   (`fallback: 'square'`) or nothing (`fallback: 'none'`).
 */
export function GamePicture({ src, size, fit, fallback }: GamePictureProps) {
  // The address that failed. It is the address and not a flag that is remembered: a catalogue that is
  // downloaded again may give another address, which is then tried without the component remounting.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const { pixels, box } = SIZES[size];

  if (src === null || src === failedSrc) {
    return fallback === 'square' ? (
      <span
        aria-hidden="true"
        className={`${box} shrink-0 rounded-sm border border-border bg-surface-raised`}
      />
    ) : null;
  }
  return (
    <img
      src={src}
      // Decorative: the name is written beside it.
      alt=""
      width={pixels}
      height={pixels}
      onError={() => {
        setFailedSrc(src);
      }}
      className={`${box} shrink-0 rounded-sm ${FIT_CLASSES[fit]}`}
    />
  );
}
