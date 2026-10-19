/**
 * The souls-at-10:00 metric: the souls the tracked player owned ten minutes into the match, the
 * laning phase's measure of how well they farmed.
 *
 * @packageDocumentation
 */
import { statAt } from '../match-context';
import type { MatchContext } from '../match-context';
import type { MetricDefinition } from '../metric';

/**
 * The time the souls are read at, in seconds since the start of the match: the end of the early
 * phase, 10:00.
 */
export const SOULS_AT_S = 600;

/** The minutes from the start of the match to {@link SOULS_AT_S}: the span of the early rate. */
const SOULS_AT_MINUTES = SOULS_AT_S / 60;

/**
 * The souls of the tracked player at 10:00.
 *
 * @param context - The match.
 * @returns The souls at 10:00, interpolated between the snapshots that surround it, or `null` when
 *   the match ends before 10:00 (it has no 10:00), or when the snapshots do not reach 10:00 or hold
 *   no souls.
 */
function soulsAt10Min(context: MatchContext): number | null {
  // The length of the match decides, not the snapshots: a match that ends before 10:00 has no
  // 10:00, whatever a snapshot past its end would say.
  if (context.durationS < SOULS_AT_S) {
    return null;
  }
  return statAt(context.tracked, 'net_worth', SOULS_AT_S);
}

/**
 * The souls at 10:00: the `net_worth` counter of the tracked player, interpolated between the
 * snapshots that surround 10:00 (a snapshot is not taken at every second), the point (0, 0) of the
 * start of the match being implied.
 *
 * The community has no benchmark of the souls at 10:00, only the average souls at each time of the
 * match (its curve). The metric is therefore compared on the early span of that curve: `rate` gives
 * the player's souls per minute over the first ten minutes, the same span the community's average is
 * read on. Comparing the same span on both sides is what keeps a long match from looking better than
 * the average.
 *
 * The value and the rate are `null` when the match ends before 10:00 (a short match has no laning
 * phase to rate), and when the snapshots do not reach 10:00: the souls are never extrapolated, and
 * an unknown value is never replaced by `0`.
 */
export const soulsAt10MinMetric: MetricDefinition = {
  key: 'souls_at_10min',
  family: 'laning',
  unit: 'amount',
  better: 'higher',
  group: 'souls',
  display: 'relative',
  personal: 'as_is',
  integer: false,
  community: {
    kind: 'curve',
    stat: 'net_worth',
    phase: 'early',
    rate: (context) => {
      const souls = soulsAt10Min(context);
      return souls === null ? null : souls / SOULS_AT_MINUTES;
    },
  },
  compute: soulsAt10Min,
};
