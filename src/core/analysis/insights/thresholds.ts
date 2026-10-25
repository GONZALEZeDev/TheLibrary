/**
 * The thresholds of the match analysis: how the two references weigh in a score, what counts as a
 * strength or a weakness, how much history a personal comparison needs, and how small a phase or a
 * cohort may be before the app stops comparing against it.
 *
 * They are all here, apart from the code that uses them, so that tuning the analysis is a change of
 * one number in one place. Nothing here is computed: each value is a decision, and the line above it
 * says why it has the value it has.
 *
 * Most of them act when a match is shown, on the values already stored, and take effect at once.
 * One does not: {@link MIN_PHASE_MINUTES} decides which phase metrics and which community stretches
 * are projected and stored with each match. So do, elsewhere, the duration windows and the 720 s
 * guaranteed end of the shortest one (`../cohort`) and the phase starts (`../phases`). Changing any
 * of these leaves the stored values computed under the old rule while the view reads them with the
 * new one: it needs a bump of `PROJECTION_VERSION` (`../registry`), so that every match is projected
 * again.
 *
 * The thresholds of the review of the player's last matches are at the end of the file. Most of
 * them act when the review is shown, on the values already stored: changing one takes effect at
 * once and needs no new projection. Two do not: {@link NEARBY_DISTANCE} and
 * {@link AVOIDABLE_MIN_ENEMIES} decide which deaths of the tracked player are avoidable, and the
 * count of those deaths is projected and stored with each match. Changing either needs a bump of
 * `PROJECTION_VERSION` too.
 *
 * @packageDocumentation
 */

/**
 * The weight of the community reference (the player's placement among the players of their rank) in
 * the score of a metric, when the personal reference is there too.
 *
 * The community cohort holds thousands of matches while the personal one holds at most
 * {@link PERSONAL_WINDOW}, so the community placement is the sturdier of the two and weighs more.
 * With {@link PERSONAL_WEIGHT} it makes 1, so a score stays in the range of its two parts.
 */
export const COMMUNITY_WEIGHT = 0.6;

/**
 * The weight of the personal reference (how this match differs from the player's habits) in the
 * score of a metric, when the community reference is there too.
 *
 * It is the complement of {@link COMMUNITY_WEIGHT}: the habits count, but they are a small sample of
 * one player and only a hint of what is good.
 */
export const PERSONAL_WEIGHT = 0.4;

/**
 * The community percentile from which a metric is a strength: the player is in the best 30% of their
 * cohort for it (the percentile is already turned so that higher always means better).
 */
export const STRENGTH_PERCENTILE = 70;

/**
 * The community percentile up to which a metric is a weakness: the player is in the worst 30% of
 * their cohort for it. It mirrors {@link STRENGTH_PERCENTILE} around the median (100 − 70).
 */
export const WEAKNESS_PERCENTILE = 30;

/**
 * The robust z-score (against the player's habits) from which a metric is a strength, and, negated,
 * up to which it is a weakness: one robust standard deviation off the usual is a difference larger
 * than the player's normal spread, which is what makes it worth showing.
 */
export const STRONG_Z = 1;

/**
 * The factor that makes the median absolute deviation comparable to a standard deviation for a
 * normal distribution (1 / Φ⁻¹(3/4)). The robust z-score divides by `MAD_SCALE × MAD`, so that
 * {@link STRONG_Z} and {@link CURVE_ABOVE_Z} read as "standard deviations" in both references.
 */
export const MAD_SCALE = 1.4826;

/**
 * The robust z-score that gives the personal part of a score its extreme value (±1): the personal
 * score is `z / PERSONAL_Z_DIVISOR` clamped to [−1, 1], so two standard deviations off the habits
 * weigh as much as the very top or bottom of the community placement.
 */
export const PERSONAL_Z_DIVISOR = 2;

/**
 * How many of the player's most recent earlier matches make their habits. Twenty matches are enough
 * for a stable median and deviation, and recent enough for the habits to follow the player's current
 * form rather than their whole history.
 */
export const PERSONAL_WINDOW = 20;

/**
 * The fewest earlier matches a personal comparison needs. Below five values, a median and a
 * deviation say more about the luck of the draw than about the player, so the comparison is left
 * out and the other reference is used alone.
 */
export const MIN_PERSONAL_MATCHES = 5;

/**
 * How many earlier matches are read to find the habits of the player: five times
 * {@link PERSONAL_WINDOW}. The habits of a metric are its {@link PERSONAL_WINDOW} most recent known
 * values, and a metric is often unknown (the late game of a short match, the lane of a player the
 * archive gives none), so reading only the last 20 matches would leave such a metric with too few
 * values to compare with. The same goes for a damage source: an item bought one match in four, or an
 * ability the player seldom uses, only appears in some of the matches.
 */
export const PREVIOUS_LOOKUP = 5 * PERSONAL_WINDOW;

/**
 * The smallest difference between a damage source's share and its usual share, as a share (0.05 is
 * 5 points), that counts as using the source more or less than usual. Five points of damage share is
 * a difference the player can act on without it being noise.
 *
 * It applies whatever the habit is:
 * - when the habit varies, the share must be {@link STRONG_Z} robust deviations away from the usual
 *   one **and** at least this far from it: a source that always deals 3 % has a tiny spread, and
 *   3.5 % would be many deviations away from a difference of half a point;
 * - when the habit does not vary at all (a median absolute deviation of 0), the robust z-score is
 *   undefined and this gap alone decides.
 */
export const DAMAGE_SHARE_MIN_GAP = 0.05;

/**
 * The shortest phase, in minutes, that is compared with a reference. A shorter one (the late phase
 * of a match that ends at 26:00, say) is shown with its totals but is too noisy to score.
 *
 * It changes the projected values: a change of it needs a bump of `PROJECTION_VERSION` (see the
 * header of this file).
 */
export const MIN_PHASE_MINUTES = 3;

/**
 * The fewest matches a community cohort needs for its percentiles to be trusted (the first and the
 * last of them, p1 and p99, would otherwise rest on two matches each). The bar stays low because
 * the cohorts are narrow: a tier and a five-minute duration window hold a few thousand matches in
 * the middle ranks but far fewer at the top, and an exact badge in a window holds only a few
 * hundred, fewer than 100 at Eternus. A higher bar would send most high-rank players to the
 * all-ranks cohort.
 */
export const MIN_COHORT_MATCHES = 200;

/**
 * The length, in seconds, under which a match is a short one (15 minutes). Such a match ended well
 * before a typical one (a stomp, or a game that was given up), so its figures say little about how
 * the player plays and the analysis marks it as low confidence.
 */
export const SHORT_MATCH_S = 900;

/**
 * The curve z-score from which the value at a time of the match is labelled "above" the average of
 * the community (and, negated, "below"): half a standard deviation, the smallest difference that is
 * more than the noise of a single match.
 */
export const CURVE_ABOVE_Z = 0.5;

/**
 * The curve z-score from which the value at a time of the match is labelled "well above" the
 * average of the community (and, negated, "well below"): a full standard deviation, which only about
 * one match in six reaches.
 */
export const CURVE_WELL_Z = 1;

/**
 * How many strengths, and how many weaknesses, the summary of a match shows. Three of each keep the
 * summary readable at a glance; the full list is in the metrics below it.
 */
export const INSIGHTS_PER_SIDE = 3;

// The thresholds of the review. They act when the review is shown, not at projection (see the
// header of this file): the stored values do not depend on them, but for NEARBY_DISTANCE and
// AVOIDABLE_MIN_ENEMIES, which decide the stored count of avoidable deaths.

/**
 * How many of the player's most recent analysed matches the review covers, and how many it compares
 * them with: the progress sets the last {@link REVIEW_MATCHES} against the same number before them,
 * so the listing reads twice as many matches.
 *
 * Twenty matches give a figure that does not swing with one game, and are recent enough to follow
 * the player's current form: the same reasoning as {@link PERSONAL_WINDOW}, of which it has the
 * size. A window with fewer than {@link MIN_PERSONAL_MATCHES} values shows no figure.
 */
export const REVIEW_MATCHES = 20;

/**
 * The number of deaths before the first resistance item from which a match is weak for that point:
 * three or more deaths before it is a pattern to work on. No death at all before it is clean (the
 * strong end of the point), and one or two is neither. The count runs up to the first resistance
 * item, whenever it is bought.
 */
export const DEATHS_BEFORE_RESISTANCE_WEAK = 3;

/**
 * The place among the twelve players of the match, on a figure of the scoreboard, from which the
 * match is weak for that point: 10th to 12th, the last quarter of the players (three of twelve). It
 * mirrors {@link PLACE_STRONG_UP_TO}.
 */
export const PLACE_WEAK_FROM = 10;

/**
 * The place among the twelve players of the match, on a figure of the scoreboard, up to which the
 * match is strong for that point: 1st to 3rd, the first quarter of the players (three of twelve).
 * It mirrors {@link PLACE_WEAK_FROM}, so that a place in the middle six is neither.
 */
export const PLACE_STRONG_UP_TO = 3;

/**
 * The gap in souls, at 10 minutes, between the player and their lane opponent from which the lane
 * counts as clearly won or lost; below it, the lane counts as even. The value is set by hand: no
 * community figure tells what an ordinary lane gap is, so the lane cannot be placed among the
 * players of a tier like the other points, and this gap alone decides.
 */
export const LANE_SOULS_CLEAR_GAP = 500;

/**
 * The share of the matches that have a mark from which a point is listed in the summary of the
 * review, as a weakness or as a strength: a quarter (5 of 20). A point flagged in fewer matches
 * than that is more likely an accident of a few games than a habit, and it stays in its own tab.
 * It is a share and not a count, so it holds when the review covers fewer than
 * {@link REVIEW_MATCHES} matches. A point also needs {@link MIN_PERSONAL_MATCHES} matches with a
 * mark before it is listed at all (`flaggedSide`): one or two matches are not a habit.
 */
export const REVIEW_MIN_FLAGGED_SHARE = 0.25;

/**
 * The number of standard errors that the change of a figure, between the matches before and the
 * last ones, must exceed to count as progress (or as the opposite); a smaller change is stable.
 * The standard error is the one of the difference between the centres of the two windows,
 * `√(s²_now / n_now + s²_before / n_before)`. The number is 1 like {@link STRONG_Z}, but it is not
 * measured the same way: that one counts spreads of the matches around the player's habits, this
 * one counts standard errors of a difference, which shrink as the windows hold more matches. At 1,
 * a change that the spread of the matches alone does not explain is shown, and no higher bar is
 * set since the review has few matches to tell with.
 */
export const PROGRESS_MIN_Z = 1;

/**
 * The distance, in world units, within which another player counts as near the tracked player when
 * they died. It is measured on the map (2D) from where they died, and a player exactly at it is
 * near. On the matches it was measured on, nearly every killer (98 %) is within it of their victim,
 * so it takes in the fight around the death; and about a third of the deaths (32 %) come out
 * avoidable, a share that leaves the player something to work on without blaming every death.
 *
 * It changes a projected value, the count of avoidable deaths: a change of it needs a bump of
 * `PROJECTION_VERSION` (see the header of this file).
 */
export const NEARBY_DISTANCE = 1500;

/**
 * The fewest enemies near the tracked player, the killer always among them, from which a death with
 * no ally near is avoidable: alone against two heroes or more is a fight the player should not have
 * been in, while one against one is an even duel that can go either way.
 *
 * It changes a projected value, the count of avoidable deaths: a change of it needs a bump of
 * `PROJECTION_VERSION` (see the header of this file).
 */
export const AVOIDABLE_MIN_ENEMIES = 2;

/**
 * The number of avoidable deaths in a match from which the match is weak for that point: two deaths
 * caught alone in one match is a pattern, while one can be bad luck. No avoidable death at all is
 * clean (the strong end of the point), and one is neither.
 *
 * It acts when the review is shown, on the stored count, so it takes effect at once: no bump of
 * `PROJECTION_VERSION` is needed.
 */
export const AVOIDABLE_DEATHS_WEAK = 2;
