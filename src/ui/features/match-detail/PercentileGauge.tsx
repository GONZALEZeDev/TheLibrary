/**
 * The gauge of a place among the community: a bar from 0 to 100 with a mark where a value stands and
 * a tick at 50, the middle of the rank.
 *
 * The gauge is a picture for the eye. For assistive technologies it is an image whose label says the
 * place in words, so that the mark's position is never the only way to know it.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { percentileSentence } from './analysis-format';

/** Props of {@link PercentileGauge}. */
export interface PercentileGaugeProps {
  /** The place among the community, from 1 to 99. A high place is a high value, not a better one. */
  readonly percentile: number;
}

/** The two ends of the bar, as places. */
const BAR_START = 0;
const BAR_END = 100;

/**
 * The gauge of a place among the community.
 *
 * @returns The bar, with its mark and its tick at 50.
 */
export function PercentileGauge({ percentile }: PercentileGaugeProps) {
  const { t } = useTranslation();
  // A place outside the bar would draw the mark outside the box: the data never gives one.
  const position = Math.min(BAR_END, Math.max(BAR_START, percentile));

  return (
    <div
      role="img"
      aria-label={percentileSentence(percentile, t)}
      className="relative h-2 w-full rounded-full border border-border bg-surface-raised"
    >
      <span aria-hidden="true" className="absolute top-[-2px] left-1/2 h-2.5 w-px bg-fg-muted/60" />
      <span
        aria-hidden="true"
        className="absolute -top-1 h-3.5 w-1 -translate-x-1/2 rounded-sm bg-secondary"
        // The one value that no class can hold: where the mark stands.
        style={{ left: `${String(position)}%` }}
      />
    </div>
  );
}
