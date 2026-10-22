/**
 * Tests of the warnings logged once per problem of a match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { testMatchId } from '../test/test-data';
import { ReportOnce } from './report-once';

/** The scope the tests report under. */
const SCOPE = 'breakdown';

/** Two matches of the tests. */
const FIRST_MATCH = testMatchId(100000001);
const SECOND_MATCH = testMatchId(100000002);

/** The issue of a payload problem, as the readers write it: a path and a code, never a value. */
const ISSUE = 'tracked_player.items.0.upgrade_id: invalid_type';

describe('ReportOnce', () => {
  it('logs a warning with the match and the details, under the scope', () => {
    const logger = new MemoryLogger();
    const reports = new ReportOnce(logger, SCOPE);

    reports.warn(FIRST_MATCH, 'The items of a match could not be read', { issue: ISSUE });

    expect(logger.entries).toEqual([
      {
        level: 'warn',
        scope: SCOPE,
        message: 'The items of a match could not be read',
        context: { matchId: FIRST_MATCH, issue: ISSUE },
      },
    ]);
  });

  it('logs the match alone when there are no details', () => {
    const logger = new MemoryLogger();
    const reports = new ReportOnce(logger, SCOPE);

    reports.warn(FIRST_MATCH, 'Match lengths disagree');

    expect(logger.entries).toMatchObject([{ context: { matchId: FIRST_MATCH } }]);
    expect(Object.keys(logger.entries[0]?.context ?? {})).toEqual(['matchId']);
  });

  it('logs a problem of a match once, however often it is found', () => {
    const logger = new MemoryLogger();
    const reports = new ReportOnce(logger, SCOPE);

    reports.warn(FIRST_MATCH, 'The items of a match could not be read', { issue: ISSUE });
    reports.warn(FIRST_MATCH, 'The items of a match could not be read', { issue: ISSUE });
    // The same problem with other details is still the same problem.
    reports.warn(FIRST_MATCH, 'The items of a match could not be read', { issue: 'other: code' });

    expect(logger.entries).toHaveLength(1);
  });

  it('logs each problem of a match, and a problem of each match', () => {
    const logger = new MemoryLogger();
    const reports = new ReportOnce(logger, SCOPE);

    // Finding one problem of a match must not hide another one.
    reports.warn(FIRST_MATCH, 'The items of a match could not be read', { issue: ISSUE });
    reports.warn(FIRST_MATCH, 'The scoreboard of a match could not be read', { issue: ISSUE });
    reports.warn(SECOND_MATCH, 'The items of a match could not be read', { issue: ISSUE });

    expect(logger.entries.map((entry) => [entry.context.matchId, entry.message])).toEqual([
      [FIRST_MATCH, 'The items of a match could not be read'],
      [FIRST_MATCH, 'The scoreboard of a match could not be read'],
      [SECOND_MATCH, 'The items of a match could not be read'],
    ]);
  });
});
