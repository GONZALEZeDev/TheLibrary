/**
 * Tests of what the readers of an archive share: reading a part of the payload with a schema, and
 * the count the API reports for a player.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { archiveCount, readArchiveFields } from './archive-fields';

/** A value that must never reach an error: it stands for an account id of the payload. */
const SECRET = 'S3CR3T';

/**
 * Run a call that must fail with an {@link AppError} and return that error.
 *
 * @param action - The call under test.
 * @returns The error it threw.
 */
function catchAppError(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  return expect.unreachable('the call should have thrown');
}

describe('archiveCount', () => {
  it('accepts a non-negative integer', () => {
    expect(archiveCount.parse(0)).toBe(0);
    expect(archiveCount.parse(41_250)).toBe(41_250);
  });

  it.each([-1, 1.5, '3', null, undefined])('refuses %s', (value) => {
    expect(archiveCount.safeParse(value).success).toBe(false);
  });
});

describe('readArchiveFields', () => {
  const schema = z.looseObject({ kills: archiveCount, team: z.object({ id: z.int() }).optional() });

  it('returns the fields of a part that matches the schema, the other fields kept', () => {
    expect(readArchiveFields(schema, { kills: 3, other: 'kept' }, 'player')).toEqual({
      kills: 3,
      other: 'kept',
    });
  });

  it('returns what the schema outputs', () => {
    const readCount = readArchiveFields(z.int().transform(String), 4, 'count');

    expect(readCount).toBe('4');
  });

  it('names the part and the path of the first problem, with its code', () => {
    const error = catchAppError(() => readArchiveFields(schema, { kills: SECRET }, 'players.3'));

    expect(error.kind).toBe('invalid_payload');
    expect(error.message).toBe('The archive is unreadable');
    expect(error.context.issue).toBe('players.3.kills: invalid_type');
  });

  it('names a problem deep in the part by its whole path', () => {
    const error = catchAppError(() =>
      readArchiveFields(schema, { kills: 1, team: { id: SECRET } }, 'players.3'),
    );

    expect(error.context.issue).toBe('players.3.team.id: invalid_type');
  });

  it('names a problem on the part itself by its name alone', () => {
    const error = catchAppError(() => readArchiveFields(schema, SECRET, 'tracked_player'));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('tracked_player: invalid_type');
  });

  it('never puts a value of the payload in the error', () => {
    const error = catchAppError(() =>
      readArchiveFields(schema, { kills: SECRET, account_id: 1_000_001 }, 'players.3'),
    );

    const text = JSON.stringify({ message: error.message, context: error.context });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('1000001');
  });
});
