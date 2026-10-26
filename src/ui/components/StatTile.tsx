/**
 * A tile with one figure and its label, for a grid of numbers.
 *
 * @packageDocumentation
 */
import { PANEL_CLASSES } from './Panel';

/** Props of {@link StatTile}. */
export interface StatTileProps {
  /** What the figure counts, already translated. */
  readonly label: string;
  /** The figure, already formatted. */
  readonly value: string;
}

/**
 * A panel-looking tile with a label and its figure.
 *
 * It renders a term and its value in one box, so the caller puts it inside its own `<dl>`.
 *
 * @returns The tile element.
 */
export function StatTile({ label, value }: StatTileProps) {
  return (
    <div className={`${PANEL_CLASSES.base} ${PANEL_CLASSES.padding.normal}`}>
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
