/**
 * What the match page waits for behind its loading gate, for an archived match: the data of every
 * tab, read and built, so that the player never sees a tab fill in after the gate has opened.
 *
 * The page reads them all at once, in parallel, while the gate shows: the timeline tab and its map
 * replay, the damage and build tab, the players tab, and the comparison of the analysis with the
 * community when it has to be downloaded. The tabs mount later on the same queries and find them
 * read (the queries stay fresh for a moment, see `TAB_STALE_TIME_MS`), so opening any tab of the
 * match then shows it whole at once.
 *
 * A read that fails counts as answered: the tab shows its error, which is content too, and the gate
 * must not stay closed for it. The analysis itself is read by the page (`useMatchAnalysis`), which
 * passes its view here.
 *
 * Some of these reads may download (a catalogue a week old, the community data of the day), and a
 * download may last up to the timeout of a request, several times over. The page waits for them
 * {@link MAX_TABS_WAIT_MS} at most: past that, the gate opens and a tab still loading shows its own
 * loading state, as it does when it is opened alone.
 *
 * @packageDocumentation
 */
import { useEffect, useState } from 'react';
import type { MatchId } from '../../../core/domain/match';
import type { MatchAnalysisView } from '../../../services/analysis-view';
import { useMatchReplay } from './replay/use-match-replay';
import { needsCommunityData, useCommunityRefresh } from './use-match-analysis';
import { useDamageTab, usePlayersTab } from './use-match-breakdown';
import { useTimelineTab } from './use-match-timeline';

/**
 * The longest the page waits for the tabs of a match, in milliseconds, from the moment it knows the
 * match is archived: long enough for the local reads and a usual download, short enough that a
 * network that does not answer never holds the page for the timeout of its requests.
 */
export const MAX_TABS_WAIT_MS = 5_000;

/** The part of a TanStack Query result that says whether a read has ended. */
interface ReadState {
  readonly data: unknown;
  readonly isError: boolean;
}

/**
 * Whether a read has ended, with data or with an error.
 *
 * @param query - The query.
 * @returns `true` once the query holds data or an error.
 */
function answered(query: ReadState): boolean {
  return query.data !== undefined || query.isError;
}

/**
 * Read every tab of an archived match, and tell when they are all read.
 *
 * @param matchId - The match.
 * @param archived - Whether the match is archived: only an archived match has tabs, and nothing is
 *   read for any other.
 * @param analysis - The analysis of the match as the page read it, `undefined` while it is read. The
 *   community data is asked for only once an analysis is there to compare, and only when it is not
 *   fresh, as the analysis tab asks for it.
 * @returns `true` once every tab of the match is read (or failed to be), or once
 *   {@link MAX_TABS_WAIT_MS} has passed since the match was known to be archived.
 */
export function useMatchTabsReady(
  matchId: MatchId,
  archived: boolean,
  analysis: MatchAnalysisView | undefined,
): boolean {
  const options = { enabled: archived };
  const timeline = useTimelineTab(matchId, options);
  const replay = useMatchReplay(matchId, options);
  const damage = useDamageTab(matchId, options);
  const players = usePlayersTab(matchId, options);
  const community = analysis?.kind === 'ready' ? analysis.analysis.community : null;
  const refreshNeeded = archived && community !== null && needsCommunityData(community);
  const refresh = useCommunityRefresh(matchId, refreshNeeded);
  const allRead =
    archived &&
    [timeline, replay, damage, players].every(answered) &&
    (!refreshNeeded || answered(refresh));

  // The match whose wait has run out. Keyed by the match, so that another match waits again.
  const [waitOverFor, setWaitOverFor] = useState<MatchId | null>(null);
  useEffect(() => {
    if (!archived || allRead) {
      return;
    }
    const timer = setTimeout(() => {
      setWaitOverFor(matchId);
    }, MAX_TABS_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [matchId, archived, allRead]);
  return allRead || (archived && waitOverFor === matchId);
}
