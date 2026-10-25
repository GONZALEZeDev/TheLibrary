/**
 * A figure of a row of the review, with the name of its column for assistive technologies: a bare
 * "1.3" or "44%" would not say whether it is the player's figure, the tier's, the gap, the share now
 * or the share before.
 *
 * The rows of the review (`ReviewRow`) and the rows of its damage tab (`ReviewDamage`) both lay their
 * figures out under a header of columns that is for the eye only, so each figure names its column
 * itself, in a text that is not drawn.
 *
 * @packageDocumentation
 */

/** Props of {@link ReviewFigure}. */
export interface ReviewFigureProps {
  /** The name of the column, which a screen reader says before the figure. */
  readonly column: string;
  /** The figure, already written. */
  readonly figure: string;
  /** The classes of the text. */
  readonly className: string;
}

/**
 * A figure of a row, after the name of its column.
 *
 * @returns The line: the name of the column, for assistive technologies only, then the figure.
 */
export function ReviewFigure({ column, figure, className }: ReviewFigureProps) {
  return (
    <p className={className}>
      <span className="sr-only">{column} </span>
      {figure}
    </p>
  );
}
