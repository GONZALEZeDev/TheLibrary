/**
 * Tests of the helpers the tabs that read the archive of a match share.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { AppError } from '../core/errors/app-error';
import { testMatchId } from '../test/test-data';
import { readCatalogues, readOrReport } from './archive-tab-reading';
import { ReportOnce } from './report-once';

/** The scope the tests log under. */
const SCOPE = 'breakdown';

/** The match the tests read for. */
const MATCH = testMatchId(100000001);

/** The line of a payload that is not what is expected. */
const MESSAGE = 'The items of a match could not be read';

/** The issue of a payload problem, as the readers write it: a path and a code, never a value. */
const ISSUE = 'players.0.items: invalid_type';

/** A reading that finds the payload broken. */
function readInvalidPayload(): never {
  throw new AppError('invalid_payload', 'The archive is not what is expected', {
    context: { issue: ISSUE },
  });
}

describe('readOrReport', () => {
  it('answers what the reading returns', () => {
    const logger = new MemoryLogger();

    const result = readOrReport(new ReportOnce(logger, SCOPE), MATCH, MESSAGE, () => 42);

    expect(result).toBe(42);
    expect(logger.entries).toEqual([]);
  });

  it('reports an invalid payload once and answers null', () => {
    const logger = new MemoryLogger();
    const reports = new ReportOnce(logger, SCOPE);

    // The page reads the tab every time it is shown: the second reading finds the same problem.
    expect(readOrReport(reports, MATCH, MESSAGE, readInvalidPayload)).toBeNull();
    expect(readOrReport(reports, MATCH, MESSAGE, readInvalidPayload)).toBeNull();

    expect(logger.entries).toEqual([
      {
        level: 'warn',
        scope: SCOPE,
        message: MESSAGE,
        context: { matchId: MATCH, issue: ISSUE },
      },
    ]);
  });

  it('rethrows another error', () => {
    const logger = new MemoryLogger();
    const reports = new ReportOnce(logger, SCOPE);
    const bug = new Error('not a payload problem');
    const failure = new AppError('storage', 'The disk failed');

    expect(() =>
      readOrReport(reports, MATCH, MESSAGE, () => {
        throw bug;
      }),
    ).toThrow(bug);
    expect(() =>
      readOrReport(reports, MATCH, MESSAGE, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(logger.entries).toEqual([]);
  });
});

describe('readCatalogues', () => {
  it('reads both catalogues and logs nothing when both can be read', async () => {
    const logger = new MemoryLogger();

    const result = await readCatalogues(
      logger,
      SCOPE,
      MATCH,
      () => Promise.resolve('heroes'),
      () => Promise.resolve(7),
    );

    expect(result).toEqual({ first: 'heroes', second: 7 });
    expect(logger.entries).toEqual([]);
  });

  it('reads both catalogues and logs one line when one fails', async () => {
    const logger = new MemoryLogger();

    const result = await readCatalogues(
      logger,
      SCOPE,
      MATCH,
      () => Promise.resolve('heroes'),
      () => Promise.reject(new AppError('network', 'Offline')),
    );

    // The catalogue that could be read is still given.
    expect(result).toEqual({ first: 'heroes', second: null });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      level: 'info',
      scope: SCOPE,
      message: 'A catalogue of the game could not be read',
      context: { matchId: MATCH, kind: 'network' },
    });
  });

  it('logs one line, with the kind of the first failure, when both fail', async () => {
    const logger = new MemoryLogger();

    const result = await readCatalogues(
      logger,
      SCOPE,
      MATCH,
      () => Promise.reject(new AppError('rate_limited', 'Budget spent')),
      () => Promise.reject(new AppError('network', 'Offline')),
    );

    expect(result).toEqual({ first: null, second: null });
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.context).toMatchObject({ matchId: MATCH, kind: 'rate_limited' });
  });
});
