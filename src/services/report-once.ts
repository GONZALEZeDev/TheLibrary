/**
 * Warnings about a match that are logged once per problem.
 *
 * A match whose archive cannot be read the way a view expects stays so until its archive is written
 * again (or the match projected again), and the match page reads its views every time it is shown:
 * a problem is reported once, not at every read. What is remembered only grows with the problems
 * found, so it is bounded by the number of broken archives.
 *
 * @packageDocumentation
 */
import type { MatchId } from '../core/domain/match';
import type { LogContext, Logger } from '../ports/logger.port';

/**
 * Logs a warning about a match once per problem. A problem is the match and the message of the
 * line: two problems of one match are two reports, since finding one must not hide the other.
 */
export class ReportOnce {
  readonly #logger: Logger;
  readonly #scope: string;
  /** The problems already reported, each as `<match id> <message>`. */
  readonly #reported = new Set<string>();

  /**
   * @param logger - Where the lines go.
   * @param scope - The scope of the lines: the one of the service that reports.
   */
  constructor(logger: Logger, scope: string) {
    this.#logger = logger;
    this.#scope = scope;
  }

  /**
   * Log a warning about a match, unless that problem of that match was already reported. A line
   * holds the match and what the caller adds, which is a field path and an issue code at most: never
   * a value of the payload.
   *
   * @param matchId - The match.
   * @param message - What is wrong with the match. It also tells the problem from another of the
   *   same match.
   * @param details - Context besides the match: the path and the issue code of a payload problem.
   *   None by default.
   */
  warn(matchId: MatchId, message: string, details: LogContext = {}): void {
    const problem = `${String(matchId)} ${message}`;
    if (this.#reported.has(problem)) {
      return;
    }
    this.#reported.add(problem);
    this.#logger.log('warn', this.#scope, message, { matchId, ...details });
  }
}
