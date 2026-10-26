/**
 * The deaths and resistance tab of the review: the player's deaths in each phase of the match, then
 * when they buy the twelve resistance items and how many deaths come before the first one. Going into
 * fights too early shows in both places, as early and mid deaths and as resistance bought late.
 *
 * Each part is a section with its title, and lists its points with the list of rows of the review
 * (`ReviewRowList`) in the order the review gives them: the tab never sorts, filters or cuts them, so
 * that every point the review makes is here.
 *
 * - **The deaths** are one list of the three phases, in the order of the match, under a sentence that
 *   says where the tier's deaths come from: the counters of its matches, which can differ by one per
 *   match from the death details the player's deaths are read from.
 * - **The avoidable deaths** are one row, under a caption that says what counts as one and that the
 *   row has no figure of the community. The matches the row does not count have no positions of the
 *   players, and a line says how many were left out. Under it, the matches that had avoidable deaths
 *   link to the timeline of the match, where those deaths are marked.
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
import { Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Review } from '../../../services/review-view';
import { formatMediumDateTime } from '../../format/date';
import { REVIEW_LINK, REVIEW_SECTION_TITLE } from './review-layout';
import { ReviewRowList } from './ReviewRowList';

/** Props of {@link ReviewDeaths}. */
export interface ReviewDeathsProps {
  /**
   * The deaths of each phase, the avoidable deaths, and the resistance items with the deaths before
   * the first one.
   */
  readonly deaths: Review['deaths'];
  /**
   * How many matches the review covers (`Review['recent'].count`). The avoidable deaths are counted
   * over the matches that have the positions of the players, so the matches the row does not count
   * are the ones left out for lack of them.
   */
  readonly recentCount: number;
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
 * The list of the matches that had avoidable deaths, each one a link to the timeline of the match.
 *
 * @param avoidable - The avoidable deaths row: its matches are the ones that have the positions of
 *   the players, most recent first, with their number of avoidable deaths.
 * @param labelId - The id of the element that names the list.
 * @param t - Translation function.
 * @param language - The language of the interface.
 * @returns The title of the list and the list, or `null` when no match had an avoidable death.
 */
function renderAvoidableMatches(
  avoidable: Review['deaths']['avoidable'],
  labelId: string,
  t: TFunction,
  language: string,
) {
  const withDeaths = avoidable.matches.filter((match) => match.value >= 1);
  if (withDeaths.length === 0) {
    return null;
  }
  // The date and the time of the match: two matches of one day with as many avoidable deaths would
  // otherwise be two links of the same name.
  return (
    <div className="space-y-1">
      <p id={labelId} className="text-sm font-medium">
        {t('review.deaths.avoidableMatches')}
      </p>
      <ul aria-labelledby={labelId} className="space-y-1 text-sm">
        {withDeaths.map((match) => (
          <li key={match.matchId}>
            {/* No `replace`: the link leaves the review, and going back returns to it. */}
            <Link
              to="/matches/$matchId"
              params={{ matchId: match.matchId }}
              search={{ tab: 'timeline' }}
              className={REVIEW_LINK}
            >
              {t('review.deaths.avoidableLink', {
                date: formatMediumDateTime(match.startTime, language),
                count: match.value,
              })}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The deaths and resistance of the review.
 *
 * @returns The deaths of each phase, then the avoidable deaths, then the resistance items, stacked.
 */
export function ReviewDeaths({ deaths, recentCount }: ReviewDeathsProps) {
  const { t, i18n } = useTranslation();
  const idPrefix = useId();
  const phasesId = `${idPrefix}-phases`;
  const avoidableId = `${idPrefix}-avoidable`;
  const avoidableMatchesId = `${idPrefix}-avoidable-matches`;
  const resistanceId = `${idPrefix}-resistance`;
  // The matches the row does not count have no positions of the players in their archive.
  const leftOut = recentCount - deaths.avoidable.count;

  return (
    <div className="space-y-6">
      <section aria-labelledby={phasesId} className="space-y-2">
        <h2 id={phasesId} className={REVIEW_SECTION_TITLE}>
          {t('review.deaths.title')}
        </h2>
        <p className="text-sm text-fg-muted">{t('review.deaths.tierCaveat')}</p>
        <ReviewRowList rows={deaths.phases} />
      </section>
      <section aria-labelledby={avoidableId} className="space-y-2">
        <h2 id={avoidableId} className={REVIEW_SECTION_TITLE}>
          {t('review.deaths.avoidable')}
        </h2>
        <p className="text-sm text-fg-muted">{t('review.deaths.avoidableCaption')}</p>
        <ReviewRowList rows={[deaths.avoidable]} />
        {leftOut > 0 && (
          <p className="text-sm text-fg-muted">
            {t('review.deaths.noPositions', { count: leftOut })}
          </p>
        )}
        {renderAvoidableMatches(deaths.avoidable, avoidableMatchesId, t, i18n.language)}
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
