/**
 * What the tabs of the match page that read the archive of a match share: reading a part of the
 * archive whose payload may not be what is expected, and reading the two catalogues of the game that
 * decorate a tab. Both log what they cannot read and never a value of the payload or of a catalogue.
 *
 * @packageDocumentation
 */
import type { MatchId } from '../core/domain/match';
import { errorLogContext, isAppError, issueOf, toAppError } from '../core/errors/app-error';
import type { Logger } from '../ports/logger.port';
import type { ReportOnce } from './report-once';

/** The two catalogues read together by {@link readCatalogues}, each `null` when it could not be read. */
export interface ReadCatalogues<First, Second> {
  /** What the first reading gave, or `null` when it failed. */
  readonly first: First | null;
  /** What the second reading gave, or `null` when it failed. */
  readonly second: Second | null;
}

/**
 * Read something out of an archive whose payload may not be what is expected: the build, the
 * scoreboard or the timeline.
 *
 * @param reports - Where a payload problem is reported, once per match and message.
 * @param matchId - The match.
 * @param message - The line to log when the payload is not what is expected: what could not be read.
 * @param read - Reads it out of the decoded archive of the match.
 * @returns What `read` returns, or `null` when the archive lacks what is read or holds it in a shape
 *   that is not expected: that says something about the archive, not about the match, so it is
 *   reported (once, see {@link ReportOnce}) and the view is `unreadable`. The match is not changed:
 *   the archive passed the checks of the door when it was written.
 * @throws Error when the reading fails for any other reason: that is a bug, which must be seen as
 *   one.
 */
export function readOrReport<Read>(
  reports: ReportOnce,
  matchId: MatchId,
  message: string,
  read: () => Read,
): Read | null {
  try {
    return read();
  } catch (error) {
    if (!isAppError(error) || error.kind !== 'invalid_payload') {
      throw error;
    }
    reports.warn(matchId, message, { issue: issueOf(error) });
    return null;
  }
}

/**
 * Read two catalogues of the game at once, each from the cache when it is fresh (and even when it
 * is not, should the download fail), and keep going with the one that could be read when the other
 * cannot: whatever the failure was (offline with nothing cached, a refused request, a spent budget,
 * a pause, the cache itself), it is a catalogue that cannot be had, never an error.
 *
 * The catalogue services logged what a refresh that fell back on the cache could not do; the line
 * of this one is for a catalogue that has no cache to fall back on.
 *
 * @param logger - Where the line goes.
 * @param scope - The scope of the line: the one of the service that reads.
 * @param matchId - The match the tab is read for, for the line.
 * @param first - Reads the first catalogue.
 * @param second - Reads the second catalogue.
 * @returns The two catalogues, each `null` when it could not be read. One line is logged at `info`
 *   level in that case, whatever the number of catalogues that failed: the first failure tells the
 *   state of the network as well as all of them would.
 */
export async function readCatalogues<First, Second>(
  logger: Logger,
  scope: string,
  matchId: MatchId,
  first: () => Promise<First>,
  second: () => Promise<Second>,
): Promise<ReadCatalogues<First, Second>> {
  const failures: unknown[] = [];
  const keepFailure = (error: unknown): null => {
    failures.push(error);
    return null;
  };
  // Both are asked at once: they share the asset budget, and each shares its run among the calls
  // that overlap, so the page asking twice downloads each catalogue once.
  const [firstRead, secondRead] = await Promise.all([
    first().catch(keepFailure),
    second().catch(keepFailure),
  ]);
  if (failures.length > 0) {
    logger.log('info', scope, 'A catalogue of the game could not be read', {
      ...errorLogContext(toAppError(failures[0])),
      matchId,
    });
  }
  return { first: firstRead, second: secondRead };
}
