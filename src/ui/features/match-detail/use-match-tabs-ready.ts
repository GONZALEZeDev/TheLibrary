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
 * Some of these reads download (a catalogue a week old, the community data of the day), at most two
 * requests a second for the catalogues (they wait for their turn, see `DeadlockApiService`). The
 * page waits for every one of them, however long they take: the player sees the match only once all
 * its data is there. Each wait has an end: every request has a timeout (`REQUEST_TIMEOUT_MS`), a
 * catalogue waits for its turn a bounded number of times, and a download that fails is an answer.
 *
 * @packageDocumentation
 */
import type { MatchId } from '../../../core/domain/match';
import type { MatchAnalysisView } from '../../../services/analysis-view';
import { useMatchReplay } from './replay/use-match-replay';
import { needsCommunityData, useCommunityRefresh } from './use-match-analysis';
import { useDamageTab, usePlayersTab } from './use-match-breakdown';
import { useTimelineTab } from './use-match-timeline';

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
 * @returns `true` once every tab of the match is read (or failed to be).
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
  return (
    archived &&
    [timeline, replay, damage, players].every(answered) &&
    (!refreshNeeded || answered(refresh))
  );
}
