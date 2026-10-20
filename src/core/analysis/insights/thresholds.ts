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
