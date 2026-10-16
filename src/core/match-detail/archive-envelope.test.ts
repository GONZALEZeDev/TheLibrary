/**
 * Tests of the archive envelope and of its byte encoding.
 *
 * Every payload here is synthetic: it has the shape of a real one (twelve players that are not
 * ordered by slot, the movement paths, the damage matrix, many fields the app ignores) but none of
 * its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { parseMatchMetadata } from '../deadlock-api/match-metadata.schema';
import type { RawMatchMetadata } from '../deadlock-api/match-metadata.schema';
import { testAccountId } from '../../test/test-data';
import {
  ARCHIVE_FORMAT,
  createArchiveEnvelope,
  decodeArchiveEnvelope,
  encodeArchiveEnvelope,
} from './archive-envelope';
import type { ArchiveEnvelope } from './archive-envelope';

/** The account the archive was pruned for. */
const ACCOUNT = testAccountId(1_000_009);

/** When the detail was fetched (Unix milliseconds). */
const FETCHED_AT = 1_760_000_123_456;

/**
 * A small detail in the shape of the API, validated like the app does.
 *
 * It carries keys the schema does not name (at the top level, in `match_info` and in a player):
 * the archive must give them back as they were stored.
 *
 * @returns The validated detail.
 */
function payload(): RawMatchMetadata {
  return parseMatchMetadata({
    match_info: {
      match_id: 108_501_737,
      start_time: 1_760_000_000,
      duration_s: 2_070,
      game_mode: 1,
      match_mode: 4,
      extra_info: 'a',
      players: [
        { account_id: 1_000_009, player_slot: 9, team: 1, hero_id: 67, items: [{ item_id: 4 }] },
        { account_id: 1_000_002, player_slot: 2, team: 0, hero_id: 12 },
      ],
      match_paths: { version: 1, paths: [{ player_slot: 9, x_pos: [100, 200] }] },
    },
    hero_build_ids: [],
    banned_hero_ids: [3],
  });
}

/**
 * Encode text as the bytes of an archive file, the way the app writes it.
 *
 * @param text - The text of the file.
 * @returns Its UTF-8 bytes.
 */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Encode a value as the JSON text of an archive file, so a test can break one field of it.
 *
 * @param overrides - Fields of the envelope to change (`undefined` removes the field).
 * @returns The bytes of the file.
 */
function envelopeBytes(overrides: Record<string, unknown> = {}): Uint8Array {
  return utf8(
    JSON.stringify({
      archiveFormat: 1,
      prunedForAccountId: 1_000_009,
      fetchedAt: FETCHED_AT,
      payload: payload(),
      ...overrides,
    }),
  );
}

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

/**
 * Everything a log line would hold of an error, as one text.
 *
 * @param error - The error.
 * @returns Its message, its context and its cause, serialised.
 */
function errorText(error: AppError): string {
  return JSON.stringify({ message: error.message, context: error.context, cause: error.cause });
}

describe('createArchiveEnvelope', () => {
  it('wraps a detail with the format, the account and the fetch time', () => {
    const detail = payload();

    const envelope = createArchiveEnvelope(detail, ACCOUNT, FETCHED_AT);

    expect(envelope).toEqual({
      archiveFormat: ARCHIVE_FORMAT,
      prunedForAccountId: ACCOUNT,
      fetchedAt: FETCHED_AT,
      payload: detail,
    });
    expect(ARCHIVE_FORMAT).toBe(1);
  });
});

describe('encodeArchiveEnvelope and decodeArchiveEnvelope', () => {
  it('round-trips an envelope through bytes', () => {
    const envelope = createArchiveEnvelope(payload(), ACCOUNT, FETCHED_AT);

    const bytes = encodeArchiveEnvelope(envelope);
    const decoded = decodeArchiveEnvelope(bytes);

    // Not `instanceof`: under jsdom, `TextEncoder` is Node's and builds its bytes in Node's realm,
    // whose `Uint8Array` is not the test realm's one.
    expect(Object.prototype.toString.call(bytes)).toBe('[object Uint8Array]');
    expect(decoded).toEqual(envelope);
    // The keys the schema does not name come back as they were stored.
    expect(decoded.payload).toHaveProperty('banned_hero_ids', [3]);
    expect(decoded.payload).toHaveProperty(['match_info', 'extra_info'], 'a');
    expect(decoded.payload).toHaveProperty(['match_info', 'players', 0, 'items', 0, 'item_id'], 4);
  });

  it('writes UTF-8 JSON that starts with the envelope fields', () => {
    const envelope = createArchiveEnvelope(payload(), ACCOUNT, FETCHED_AT);

    const text = new TextDecoder().decode(encodeArchiveEnvelope(envelope));

    expect(text.startsWith('{"archiveFormat":1,"prunedForAccountId":1000009,"fetchedAt":')).toBe(
      true,
    );
    expect(JSON.parse(text)).toEqual(envelope);
  });

  it('round-trips text outside ASCII', () => {
    const detail = parseMatchMetadata({
      ...payload(),
      hero_build_ids: [{ name: 'Mélodie ✦ 蝶' }],
    });
    const envelope = createArchiveEnvelope(detail, ACCOUNT, FETCHED_AT);

    expect(decodeArchiveEnvelope(encodeArchiveEnvelope(envelope))).toEqual(envelope);
  });

  it('does not modify the envelope it encodes', () => {
    const envelope = createArchiveEnvelope(payload(), ACCOUNT, FETCHED_AT);
    const before = structuredClone(envelope);

    encodeArchiveEnvelope(envelope);

    expect(envelope).toEqual(before);
  });

  it('refuses an archive of an unknown format', () => {
    const error = catchAppError(() => decodeArchiveEnvelope(envelopeBytes({ archiveFormat: 2 })));

    expect(error.kind).toBe('invalid_payload');
    expect(error.message).toBe('The archive is unreadable');
    expect(error.context.issue).toBe('archive_format');
  });

  it('refuses an archive of an unknown format whatever its other fields hold', () => {
    // A later format may change every other field: the format is checked first.
    const bytes = utf8(JSON.stringify({ archiveFormat: 2, somethingElse: true }));

    const error = catchAppError(() => decodeArchiveEnvelope(bytes));

    expect(error.context.issue).toBe('archive_format');
  });

  it('refuses bytes that are not JSON', () => {
    const error = catchAppError(() => decodeArchiveEnvelope(utf8('this is not json')));

    expect(error.kind).toBe('invalid_payload');
    expect(error.message).toBe('The archive is unreadable');
    expect(error.context.issue).toBe('archive_json');
  });

  it('refuses a truncated archive', () => {
    const bytes = envelopeBytes();

    const error = catchAppError(() => decodeArchiveEnvelope(bytes.slice(0, bytes.length - 40)));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('archive_json');
  });

  it('refuses bytes that are not UTF-8', () => {
    // 0xff can never appear in UTF-8: a lenient decoder would turn it into U+FFFD.
    const error = catchAppError(() => decodeArchiveEnvelope(new Uint8Array([0x7b, 0xff, 0x7d])));

    expect(error.kind).toBe('invalid_payload');
    expect(error.message).toBe('The archive is unreadable');
    expect(error.context.issue).toBe('archive_utf8');
  });

  it('refuses empty bytes', () => {
    const error = catchAppError(() => decodeArchiveEnvelope(new Uint8Array()));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('archive_json');
  });

  it.each([
    ['a number', '12'],
    ['null', 'null'],
    ['an array', '[1]'],
    ['a string', '"archive"'],
  ])('refuses JSON that is %s instead of an envelope', (_name, text) => {
    const error = catchAppError(() => decodeArchiveEnvelope(utf8(text)));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('archive_shape');
  });

  it.each([
    ['missing', undefined],
    ['not an account id', 'x'],
    ['zero', 0],
    ['too large', 2 ** 32],
    ['a decimal', 1.5],
  ])('refuses an archive whose account id is %s', (_name, value) => {
    const error = catchAppError(() =>
      decodeArchiveEnvelope(envelopeBytes({ prunedForAccountId: value })),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('prunedForAccountId: invalid_value');
  });

  it.each([
    ['missing', undefined],
    ['text', '1760000123456'],
    ['negative', -1],
    ['a decimal', 1.5],
    ['beyond the safe integers', 2 ** 53],
  ])('refuses an archive whose fetch time is %s', (_name, value) => {
    const error = catchAppError(() => decodeArchiveEnvelope(envelopeBytes({ fetchedAt: value })));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('fetchedAt: invalid_value');
  });

  it('refuses an archive whose payload is not a match detail', () => {
    const error = catchAppError(() =>
      decodeArchiveEnvelope(envelopeBytes({ payload: { match_info: { match_id: 1 } } })),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(error.message).toBe('The archive is unreadable');
    // The path and the code of the payload problem, never a value.
    expect(error.context.issue).toBe('payload.match_info.start_time: invalid_type');
  });

  it('refuses an archive without a payload', () => {
    const error = catchAppError(() => decodeArchiveEnvelope(envelopeBytes({ payload: undefined })));

    expect(error.kind).toBe('invalid_payload');
    expect(error.context.issue).toBe('payload: invalid_type');
  });

  it('does not check which match the payload describes', () => {
    // The reader only has bytes: the match id belongs to the file name, not to the envelope.
    const envelope: ArchiveEnvelope = createArchiveEnvelope(payload(), ACCOUNT, FETCHED_AT);

    expect(decodeArchiveEnvelope(encodeArchiveEnvelope(envelope)).payload.match_info.match_id).toBe(
      108_501_737,
    );
  });

  it('never puts a value of the archive in the error', () => {
    // A JSON syntax error of the engine quotes a piece of the text: it must not reach the error.
    const bytes = utf8(
      '{"archiveFormat":1,"prunedForAccountId":987654321,"payload":{"secret":S3CR3T',
    );

    const error = catchAppError(() => decodeArchiveEnvelope(bytes));

    expect(error.context.issue).toBe('archive_json');
    expect(error.cause).toBeUndefined();
    expect(errorText(error)).not.toContain('S3CR3T');
    expect(errorText(error)).not.toContain('987654321');
  });

  it('never puts a value of the payload in the error of an invalid payload', () => {
    const error = catchAppError(() =>
      decodeArchiveEnvelope(
        envelopeBytes({ payload: { match_info: { match_id: 'S3CR3T-MATCH' } } }),
      ),
    );

    expect(error.kind).toBe('invalid_payload');
    expect(errorText(error)).not.toContain('S3CR3T-MATCH');
  });
});
