/**
 * The rows of the players tab of the review: the place the player took among the players of each of
 * the last matches on each figure of the scoreboard, how often they were in Valve's top three, and
 * their place in it when they were.
 *
 * All are read from values the projection stored for the match (`scoreboard_place.<figure>` and
 * `valve_rank`, see `../core/analysis/review/review-values`), so no archive is opened here. None has
 * a figure for the tier above, so no row has a comparison with it, and a match is weak or strong for
 * a place and for the top three by a fixed rule (`markOfPlace`, `markOfValveRank`). The rows sum the
 * matches up around the **mean** (`./review-row`): the mean place is the player's average place, and
 * the mean of ones and zeros is the share of the matches they were in the top three.
 *
 * - **A place** is taken as stored. The rule is stated on the places themselves (10th to 12th is
 *   weak, 1st to 3rd is strong), so the number of players that have the figure
 *   (`scoreboard_place_of.<figure>`, stored beside the place) is not read: a scoreboard with fewer
 *   than twelve of them has fewer places to give, and is judged by the same ones. A match with no
 *   place for a figure (no scoreboard, or no figure for the player) is left out, never taken for a
 *   place.
 * - **The top three** is one in a match where the player has a rank of Valve's top three
 *   (`isInValveTopThree`), zero in a match that has a top three without them, and no value in a
 *   match that has none. The mark reads the stored rank, not the one or the zero: the top three is
 *   strong, and missing it says nothing.
 * - **The place in the top three** is the stored rank, in the matches where the player is in the top
 *   three only: outside it there is no place, not a place of 0. It is marked in no match, as getting
 *   into the top three is what the row above judges.
 *
 * Nothing here reads a database, a file or the network, and nothing is logged.
 *
 * @packageDocumentation
 */
import {
  isInValveTopThree,
  markOfPlace,
  markOfValveRank,
} from '../core/analysis/review/review-rules';
import { VALVE_RANK_KEY, scoreboardPlaceKey } from '../core/analysis/review/review-values';
import { SCOREBOARD_PLACE_STATS, type PlaceStat } from '../core/match-detail/scoreboard';
import type { RecentMatch } from './metrics.repository';
import { UNJUDGED, pointMatchesOf, pointRowOf, type ReviewPoint } from './review-row';
import type { ReviewMatch, ReviewPlayers } from './review-view';

/** A point of the tab, on last matches that carry their tier data (which no point here reads). */
type PlayerPoint = ReviewPoint<ReviewMatch>;

/**
 * The rank of the player in Valve's top three of a match, as stored.
 *
 * @param match - The match.
 * @returns The rank (1 to 3 in the top three, 0 outside it), or `null` when the match has no top
 *   three.
 */
function valveRankOf(match: RecentMatch): number | null {
  return match.values.get(VALVE_RANK_KEY) ?? null;
}

/**
 * The point of the place among the players on a figure of the scoreboard.
 *
 * @param stat - The figure.
 * @returns The point: the stored place, judged by `markOfPlace`.
 */
function placePoint(stat: PlaceStat): PlayerPoint {
  const key = scoreboardPlaceKey(stat);
  return {
    subject: { kind: 'place', stat },
    unit: 'place',
    better: 'lower',
    display: 'absolute',
    center: 'mean',
    valueIn: ({ match }) => match.values.get(key) ?? null,
    judge: (_reviewMatch, place) => ({ ...UNJUDGED, mark: markOfPlace(place), marked: true }),
  };
}

/**
 * The point of Valve's top three: one in the top three and zero outside it, judged by
 * `markOfValveRank` on the stored rank.
 */
const TOP_THREE_POINT: PlayerPoint = {
  subject: { kind: 'valve_top_three' },
  unit: 'rate',
  better: 'higher',
  display: 'absolute',
  center: 'mean',
  valueIn: ({ match }) => {
    const rank = valveRankOf(match);
    if (rank === null) {
      return null;
    }
    return isInValveTopThree(rank) ? 1 : 0;
  },
  // The point has a value only where the rank is stored, so the rank is there.
  judge: ({ match }) => ({
    ...UNJUDGED,
    mark: markOfValveRank(valveRankOf(match) ?? 0),
    marked: true,
  }),
};

/**
 * The point of the place in Valve's top three: the stored rank in a match where the player is in the
 * top three, and no value in any other, which has no place in it. No rule judges it.
 */
const TOP_THREE_PLACE_POINT: PlayerPoint = {
  subject: { kind: 'valve_top_three_place' },
  // A place in the top three is out of three, not out of twelve like a place on the scoreboard.
  unit: 'top_three_place',
  better: 'lower',
  display: 'absolute',
  center: 'mean',
  valueIn: ({ match }) => {
    const rank = valveRankOf(match);
    return rank !== null && isInValveTopThree(rank) ? rank : null;
  },
  judge: () => UNJUDGED,
};

/**
 * Build the players tab of the review.
 *
 * @param recent - The last matches, most recent first.
 * @param before - The matches before them, which the progress compares with.
 * @returns A row for each figure of the scoreboard, in the order the scoreboard declares them, the
 *   row of Valve's top three and the row of the place in it. A point no match has a value for still
 *   has its row, and says nothing.
 */
export function playerRowsOf(
  recent: readonly ReviewMatch[],
  before: readonly RecentMatch[],
): ReviewPlayers {
  const earlier = pointMatchesOf(before);
  return {
    places: SCOREBOARD_PLACE_STATS.map((stat) => pointRowOf(placePoint(stat), recent, earlier)),
    topThree: pointRowOf(TOP_THREE_POINT, recent, earlier),
    topThreePlace: pointRowOf(TOP_THREE_PLACE_POINT, recent, earlier),
  };
}
