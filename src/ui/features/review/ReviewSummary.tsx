/**
 * The summary tab of the review: the points of the player's last matches that were weak or strong in
 * a meaningful share of them, the weaknesses ("to work on") first and the strengths after.
 *
 * Each section lists its points with the list of rows of the review (`ReviewRowList`), in the order
 * the review gives them (the most often flagged first): the tab never sorts, filters or cuts them, so
 * that every point the review flags is here. A section where nothing recurs says so in a sentence,
 * with no header of columns over an empty list.
 *
 * The two sections are always stacked: a row needs most of the width of the tab for its figures,
 * which two columns would not leave it. The points come from every other tab (a metric, the deaths
 * of a phase, a place among the players, a resistance item…), and a resistance item shows its
 * picture before its name, so that the item is known at a glance. The name of each point is a link to
 * the tab it comes from, which sets it among the points of its kind. The page around the tab handles
 * every state (no account, no match, a review being read): this component only renders rows.
 *
 * The headings: the page title is the `h1` of the page, the tab panel is named by its tab, and each
 * section is an `h2` that names it (the rows are its content).
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Review, ReviewRow as ReviewRowData } from '../../../services/review-view';
import { REVIEW_SECTION_TITLE } from './review-layout';
import { ReviewRowList } from './ReviewRowList';

/** Props of {@link ReviewSummary}. */
export interface ReviewSummaryProps {
  /** The points flagged in a meaningful share of the last matches: the weaknesses and the strengths. */
  readonly summary: Review['summary'];
}

/** The side of the summary a section is about. */
type Side = keyof Review['summary'];

/**
 * The texts of each section: its title, and the sentence that says nothing recurs. The sections are
 * in the order they are shown.
 */
const SECTIONS = [
  {
    side: 'weaknesses',
    title: 'review.summary.weaknesses',
    none: 'review.summary.noWeakness',
  },
  {
    side: 'strengths',
    title: 'review.summary.strengths',
    none: 'review.summary.noStrength',
  },
] as const satisfies readonly {
  readonly side: Side;
  readonly title: string;
  readonly none: string;
}[];

/**
 * One section of the summary.
 *
 * @param section - The texts of the section.
 * @param rows - The points of the section, in the order to show them.
 * @param headingId - The id of the heading, which names the section.
 * @param t - Translation function.
 * @returns The section: its title, then its rows, or the sentence that says nothing recurs.
 */
function renderSection(
  section: (typeof SECTIONS)[number],
  rows: readonly ReviewRowData[],
  headingId: string,
  t: TFunction,
) {
  return (
    <section key={section.side} aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className={REVIEW_SECTION_TITLE}>
        {t(section.title)}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{t(section.none)}</p>
      ) : (
        <ReviewRowList rows={rows} linked />
      )}
    </section>
  );
}

/**
 * The summary of the review.
 *
 * @returns The weaknesses, then the strengths, stacked.
 */
export function ReviewSummary({ summary }: ReviewSummaryProps) {
  const { t } = useTranslation();
  const idPrefix = useId();

  return (
    <div className="space-y-6">
      {SECTIONS.map((section) =>
        renderSection(section, summary[section.side], `${idPrefix}-${section.side}`, t),
      )}
    </div>
  );
}
