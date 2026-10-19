/**
 * Tests of the first-issue description of a failed validation.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeFirstIssue } from './first-issue';

/** Validate a value that is known to be invalid and return the error of the failed validation. */
function failureOf(schema: z.ZodType, value: unknown): z.ZodError {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    throw new Error('the value was expected to be invalid');
  }
  return parsed.error;
}

describe('describeFirstIssue', () => {
  it('names the root for an issue on the value itself', () => {
    const error = failureOf(z.object({}), 3);

    expect(describeFirstIssue(error)).toBe('(root): invalid_type');
  });

  it('joins the path of the first issue', () => {
    const error = failureOf(z.object({ a: z.array(z.int()) }), { a: [1, 'x'] });

    expect(describeFirstIssue(error)).toBe('a.1: invalid_type');
  });

  it('describes only the first of several issues', () => {
    const error = failureOf(z.object({ a: z.int(), b: z.int() }), { a: 'x', b: 'y' });

    expect(error.issues).toHaveLength(2);
    expect(describeFirstIssue(error)).toBe('a: invalid_type');
  });

  it('puts the prefix in front of the path', () => {
    const error = failureOf(z.object({ kills: z.int() }), {});

    expect(describeFirstIssue(error, 'tracked_player')).toBe('tracked_player.kills: invalid_type');
  });

  it('names the prefix alone for an issue on the value itself', () => {
    const error = failureOf(z.object({}), 3);

    expect(describeFirstIssue(error, 'match_info')).toBe('match_info: invalid_type');
  });

  it('falls back to the root, or to the prefix, when the error holds no issue', () => {
    const error = new z.ZodError([]);

    expect(describeFirstIssue(error)).toBe('(root): invalid');
    expect(describeFirstIssue(error, 'match_info')).toBe('match_info: invalid');
  });

  it('never quotes the value', () => {
    // Zod can echo the input in an issue message (and a refinement can carry the received value).
    const secret = 'secret-123';
    const wrongType = failureOf(z.object({ name: z.int() }), { name: secret });
    const refined = failureOf(
      z.string().refine(() => false, { message: `got ${secret}` }),
      secret,
    );

    expect(describeFirstIssue(wrongType, 'tracked_player')).not.toContain(secret);
    expect(describeFirstIssue(refined)).toBe('(root): custom');
    expect(describeFirstIssue(refined)).not.toContain(secret);
  });
});
