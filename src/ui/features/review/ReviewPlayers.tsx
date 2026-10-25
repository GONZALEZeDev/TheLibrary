/**
 * The players tab of the review: where the player stands among the 12 players of their matches. For
 * each of five figures of the scoreboard (souls, damage to heroes, damage to objectives, healing and
 * barriers, last hits) it gives the player's mean place over the last matches, then how often they
 * were in Valve's top three of a match, and their average place in it when they were.
 *
 * It is one section with its title, and one list of rows of the review (`ReviewRowList`): the five
 * places in the order the review gives them, then the two rows about Valve's top three. The tab never
 * sorts, filters or cuts them. The rows are the same as on every other tab, so the places carry the
 * same columns (the player's figure and the number of matches it counts, the progress since the
 * matches before); the tier above has no figure for a place among the players, and its column says
 * so with a dash. The page around the tab handles every state (no account, no match, a review being
 * read): this component only renders rows.
 *
 * The headings: the page title is the `h1` of the page, the tab panel is named by its tab, and the
 * section is an `h2` that names it, with the look of the sections of the review.
 *
 * @packageDocumentation
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Review } from '../../../services/review-view';
import { REVIEW_SECTION_TITLE } from './review-layout';
import { ReviewRowList } from './ReviewRowList';

/** Props of {@link ReviewPlayers}. */
export interface ReviewPlayersProps {
  /** The places among the players, and the rows about Valve's top three. */
  readonly players: Review['players'];
}

/**
 * The players of the review.
 *
 * @returns The section: its title, then the list of the five places, the top three and the average
 *   place in it.
 */
export function ReviewPlayers({ players }: ReviewPlayersProps) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <h2 id={titleId} className={REVIEW_SECTION_TITLE}>
        {t('review.players.title')}
      </h2>
      <ReviewRowList rows={[...players.places, players.topThree, players.topThreePlace]} />
    </section>
  );
}
