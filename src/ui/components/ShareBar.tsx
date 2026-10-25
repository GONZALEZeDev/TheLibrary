/**
 * The bar of a share: a rounded track with a fill as long as the share, and, when asked, a mark on
 * the track where a second share stands (the share a player usually has, say). The damage table of
 * the match page and the damage tab of the review draw their shares with it.
 *
 * The bar is a picture for the eye and nothing else: it is hidden from assistive technologies and
 * holds no text, because the figure of the share is always written beside it. It is made to stand
 * under that figure, so it carries the space above it.
 *
 * Both shares are held inside the track, since a fill or a mark drawn outside its box would break
 * the layout of the row: the data never gives a share outside 0 to 1, but the bar does not rely on
 * it. A length and a position are the one thing no class can hold, so they are set with `style`.
 *
 * @packageDocumentation
 */

/** Props of {@link ShareBar}. */
export interface ShareBarProps {
  /** The share the fill draws, from 0 to 1. */
  readonly share: number;
  /**
   * Where the mark stands, as a share from 0 to 1, or `null` (or nothing) for a bar with no mark.
   * The mark of a share of 0 is drawn, at the start of the track: only `null` leaves it out.
   */
  readonly mark?: number | null;
}

/** The two ends of the track, as a percentage. */
const BAR_START = 0;
const BAR_END = 100;

/**
 * The position of a share on the track, as a CSS percentage.
 *
 * @param share - The share, from 0 to 1.
 * @returns The percentage, with one decimal at most. A share outside the track is held to its ends.
 */
function positionOf(share: number): string {
  const percent = Math.min(BAR_END, Math.max(BAR_START, share * BAR_END));
  return `${String(Math.round(percent * 10) / 10)}%`;
}

/**
 * The bar of a share.
 *
 * @returns The track with its fill, and its mark when there is one.
 */
export function ShareBar({ share, mark = null }: ShareBarProps) {
  return (
    <div
      aria-hidden="true"
      className="relative mt-1.5 h-2 w-full rounded-full border border-border bg-surface-raised"
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-accent"
        // The one value that no class can hold: how far the share goes.
        style={{ width: positionOf(share) }}
      />
      {mark !== null && (
        <span
          className="absolute -top-1 h-3.5 w-1 -translate-x-1/2 rounded-sm bg-secondary"
          // The one value that no class can hold: where the mark stands.
          style={{ left: positionOf(mark) }}
        />
      )}
    </div>
  );
}
