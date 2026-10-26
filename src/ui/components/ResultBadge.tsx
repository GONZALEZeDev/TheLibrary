/**
 * The small square that tells whether a match was won or lost.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';

/** How big a {@link ResultBadge} is drawn. */
export type ResultBadgeSize = 'small' | 'medium';

/** Props of {@link ResultBadge}. */
export interface ResultBadgeProps {
  /** Whether the match was won. */
  readonly won: boolean;
  /** The size of the square: `small` for a dense strip, `medium` (default) for a table row. */
  readonly size?: ResultBadgeSize;
}

/** The classes every badge shares: a centred square letter. */
const BASE_CLASSES = 'inline-flex shrink-0 items-center justify-center rounded font-semibold';

/** The square of each {@link ResultBadgeSize}, and the size of its letter. */
const SIZE_CLASSES: Record<ResultBadgeSize, string> = {
  small: 'size-6 text-xs',
  medium: 'size-8 text-sm',
};

/**
 * The look of a win and of a loss. The two differ by their shape (a filled square against an
 * outlined one) and not only by their colour, so the result stays readable for a colour-blind
 * person.
 */
const RESULT_CLASSES = {
  win: 'bg-win/20 text-win',
  loss: 'border border-loss text-loss',
} as const;

/**
 * A square with the initial of the result: a filled one for a win, an outlined one for a loss.
 *
 * The letter is for the eyes only; a screen reader gets the full word once, from a hidden text.
 * The badge holds no link: the caller wraps it when it must lead somewhere.
 *
 * @returns The badge element.
 */
export function ResultBadge({ won, size = 'medium' }: ResultBadgeProps) {
  const { t } = useTranslation();
  const classes = [BASE_CLASSES, SIZE_CLASSES[size], RESULT_CLASSES[won ? 'win' : 'loss']].join(
    ' ',
  );

  return (
    <span className={classes}>
      {/* The initial is hidden from assistive technologies: the word below says the same thing. */}
      <span aria-hidden="true">{won ? t('result.winShort') : t('result.lossShort')}</span>
      <span className="sr-only">{won ? t('matches.table.win') : t('matches.table.loss')}</span>
    </span>
  );
}
