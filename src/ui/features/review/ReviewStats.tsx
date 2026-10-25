/**
 * The stats tab of the review: the 24 metrics of the match page over the player's last matches, the
 * 13 metrics of the whole match by family (combat, survival, farm, support, objectives, laning) as the
 * match page groups them, then the 11 metrics of a phase.
 *
 * Each family is a section titled as it is on the match page, and the phase metrics are a section
 * titled as the phase table is. A section lists its metrics with the list of rows of the review
 * (`ReviewRowList`) in the order the review gives them, which is the order of the registry of the
 * metrics: the tab never sorts, filters or cuts them. A section with no row is left out, as the phase
 * table is for a match that reached no phase. The page around the tab handles every state (no
 * account, no match, a review being read): this component only renders rows.
 *
 * The sections are stacked, unlike the families of the match page, which flow in two columns on a
 * wide window: a row needs most of the width of the tab for its figures, which two columns would not
 * leave it.
 *
 * The headings: the page title is the `h1` of the page, the tab panel is named by its tab, and each
 * family and the phases are an `h2` that names their section, with the look of the families of the
 * match page.
 *
 * @packageDocumentation
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Review, ReviewRow as ReviewRowData } from '../../../services/review-view';
import { ReviewRowList } from './ReviewRowList';

/** Props of {@link ReviewStats}. */
export interface ReviewStatsProps {
  /** The metrics of the match by family, then the metrics of a phase. */
  readonly stats: Review['stats'];
}

/**
 * One section of the tab: a family of metrics, or the metrics of a phase.
 *
 * @param title - The title of the section.
 * @param rows - The metrics of the section, in the order to show them.
 * @param headingId - The id of the heading, which names the section.
 * @returns The section: its title, then its rows; nothing when it has no row, since a title over an
 *   empty list says nothing.
 */
function renderSection(title: string, rows: readonly ReviewRowData[], headingId: string) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <section key={headingId} aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="mb-1.5 ml-0.5 text-xs font-medium tracking-wide text-fg-muted uppercase"
      >
        {title}
      </h2>
      <ReviewRowList rows={rows} />
    </section>
  );
}

/**
 * The stats of the review.
 *
 * @returns The families, then the phase metrics, stacked.
 */
export function ReviewStats({ stats }: ReviewStatsProps) {
  const { t } = useTranslation();
  const idPrefix = useId();

  return (
    <div className="space-y-4">
      {stats.families.map(({ family, rows }) =>
        renderSection(t(`analysis.family.${family}`), rows, `${idPrefix}-${family}`),
      )}
      {renderSection(t('analysis.phaseTable.title'), stats.phases, `${idPrefix}-phases`)}
    </div>
  );
}
