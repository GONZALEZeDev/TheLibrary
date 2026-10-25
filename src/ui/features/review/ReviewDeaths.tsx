/**
 * The deaths and resistance tab of the review: the player's deaths in each phase of the match, then
 * when they buy the twelve resistance items and how many deaths come before the first one. Going into
 * fights too early shows in both places, as early and mid deaths and as resistance bought late.
 *
 * Each part is a section with its title, and lists its points with the list of rows of the review
 * (`ReviewRowList`) in the order the review gives them: the tab never sorts, filters or cuts them, so
 * that every point the review makes is here.
 *
 * - **The deaths** are one list of the three phases, in the order of the match.
 * - **The resistance** is two lists. The first holds the points about the twelve items as a whole: the
 *   minute of the first resistance item, whichever it is, and the deaths before it. The second holds
 *   the twelve items in the order of their list, two rows for each: the minute the player buys it,
 *   then how often they buy it. Each row names its item and says which of the two it is ("Metal Skin ·
 *   Bought at", "Metal Skin · Bought"), and shows the picture of the item before its name (the list
 *   of rows does so for any row about an item), so that the item is known at a glance. One list for
 *   all the items rather than one for each keeps a single header of columns over all the figures,
 *   which line up from the first item to the last.
 *
 * The item catalogue gives the names and the pictures. When it cannot be read, the review has no item
 * to name and the resistance section says so in a sentence instead of its lists (the deaths of the
 * phases do not need it). An item the catalogue does not know is still listed, by its class name, with
 * a neutral square where its picture would be. The page around the tab handles every other state (no
 * account, no match, a review being read): this component only renders rows.
 *
 * The headings: the page title is the `h1` of the page, the tab panel is named by its tab, and each
 * section is an `h2` that names it, with the look of the sections of the review.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Review } from '../../../services/review-view';
import { REVIEW_SECTION_TITLE } from './review-layout';
import { ReviewRowList } from './ReviewRowList';

/** Props of {@link ReviewDeaths}. */
export interface ReviewDeathsProps {
  /** The deaths of each phase, and the resistance items with the deaths before the first one. */
  readonly deaths: Review['deaths'];
}

/**
 * The content of the resistance section.
 *
 * @param resistance - The resistance part of the review: its content, or the reason it has none.
 * @param t - Translation function.
 * @returns The two lists: the points about the items as a whole, then the minute row and the rate row
 *   of each item in the order of the list (the list shows the picture of each item); or the sentence
 *   that says the item names are unavailable.
 */
function renderResistance(resistance: Review['deaths']['resistance'], t: TFunction) {
  if (resistance.kind === 'catalogue_unavailable') {
    return <p className="text-sm text-fg-muted">{t('review.catalogueUnavailable')}</p>;
  }
  const { firstMinute, deathsBefore, items } = resistance.value;
  return (
    <>
      <ReviewRowList rows={[firstMinute, deathsBefore]} />
      <ReviewRowList rows={items.flatMap(({ minute, rate }) => [minute, rate])} />
    </>
  );
}

/**
 * The deaths and resistance of the review.
 *
 * @returns The deaths of each phase, then the resistance items, stacked.
 */
export function ReviewDeaths({ deaths }: ReviewDeathsProps) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const phasesId = `${idPrefix}-phases`;
  const resistanceId = `${idPrefix}-resistance`;

  return (
    <div className="space-y-6">
      <section aria-labelledby={phasesId} className="space-y-2">
        <h2 id={phasesId} className={REVIEW_SECTION_TITLE}>
          {t('review.deaths.title')}
        </h2>
        <ReviewRowList rows={deaths.phases} />
      </section>
      <section aria-labelledby={resistanceId} className="space-y-2">
        <h2 id={resistanceId} className={REVIEW_SECTION_TITLE}>
          {t('review.deaths.resistanceTitle')}
        </h2>
        {renderResistance(deaths.resistance, t)}
      </section>
    </div>
  );
}
