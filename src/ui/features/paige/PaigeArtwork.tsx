/**
 * Paige's artwork on her page: the deadlock.wiki render, in the right part of the page on its full
 * height, its left and bottom edges faded into the backdrop.
 *
 * The render is not part of the app: it is loaded from deadlock.wiki at its fixed address (never
 * one a download gives), in the size the page needs. When it cannot be loaded, the bust of the
 * hero card from deadlock-api takes its place, framed and faded the same way; when that fails too,
 * the page shows no artwork rather than a broken image.
 *
 * The picture keeps its proportions: it covers a box of 62 % of the page's width on its full
 * height, and the part that does not fit is cropped, mostly from its right side (the books), so
 * that Paige stays in view beside the stat panels at any window size.
 *
 * @packageDocumentation
 */
import { useState, type CSSProperties } from 'react';

/** The render at 1024 pixels wide, the size most windows need. */
export const WIKI_ARTWORK_1024 =
  'https://cdn.deadlock.wiki/thumb/Paige_Render.png/1024px-Paige_Render.png';

/** The render at its own size, 1608 pixels wide, for tall windows. */
export const WIKI_ARTWORK_ORIGINAL = 'https://cdn.deadlock.wiki/Paige_Render.png';

/**
 * The fades of the left and bottom edges, and the framing: the picture covers its box (the right
 * part of the page, on its full height) without being stretched, cropped from its right side first
 * so that Paige stays in view.
 */
const ARTWORK_STYLE: CSSProperties = {
  objectFit: 'cover',
  objectPosition: '15% top',
  maskImage:
    'linear-gradient(90deg, transparent 0%, black 30%), linear-gradient(0deg, transparent 0%, black 22%)',
  maskComposite: 'intersect',
  WebkitMaskImage:
    'linear-gradient(90deg, transparent 0%, black 30%), linear-gradient(0deg, transparent 0%, black 22%)',
  WebkitMaskComposite: 'source-in',
};

/** Props of {@link PaigeArtwork}. */
export interface PaigeArtworkProps {
  /** The bust of the hero card, shown when the render cannot be loaded. */
  readonly fallbackUrl: string | null;
}

/**
 * The artwork, or its fallback.
 *
 * @returns The picture, decorative; or nothing when neither can be loaded.
 */
export function PaigeArtwork({ fallbackUrl }: PaigeArtworkProps) {
  // Which picture is shown: the render, the bust, or none once both failed.
  const [source, setSource] = useState<'wiki' | 'fallback' | 'none'>('wiki');
  const className = 'pointer-events-none absolute inset-y-0 right-0 h-full w-[62%]';
  if (source === 'wiki') {
    return (
      <img
        src={WIKI_ARTWORK_1024}
        srcSet={`${WIKI_ARTWORK_1024} 1024w, ${WIKI_ARTWORK_ORIGINAL} 1608w`}
        sizes="60vw"
        alt=""
        className={className}
        style={ARTWORK_STYLE}
        onError={() => {
          setSource(fallbackUrl === null ? 'none' : 'fallback');
        }}
      />
    );
  }
  if (source === 'fallback' && fallbackUrl !== null) {
    return (
      <img
        src={fallbackUrl}
        alt=""
        className={className}
        style={ARTWORK_STYLE}
        onError={() => {
          setSource('none');
        }}
      />
    );
  }
  return null;
}
