/**
 * What every reader of an archive shares: how a part of the payload is read with a schema, and the
 * kind of number the API reports for a player.
 *
 * An archive is read part by part, each reader naming only the fields it needs (see
 * `./archive-facts`, `../analysis/match-context`). They all fail the same way: with an
 * `invalid_payload` error that says where the first problem is and what kind of problem it is, never
 * a value, since the payload belongs to players (account ids) and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { describeFirstIssue } from '../errors/first-issue';

/** A count the API reports for a player: a non-negative integer. */
export const archiveCount = z.int().nonnegative();

/**
 * Read the fields of a part of the payload with a schema.
 *
 * @param schema - The schema of the fields to read.
 * @param value - The part of the payload.
 * @param name - What the part is, the start of the path of a problem.
 * @returns The validated fields.
 * @throws AppError of kind `invalid_payload` and message `The archive is unreadable`, whose context
 *   `issue` is `<name>.<path>: <code>` of the first problem (`<name>: <code>` when it is on the
 *   part itself). Zod's message is not used: it can echo a part of the input.
 */
export function readArchiveFields<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  name: string,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new AppError('invalid_payload', 'The archive is unreadable', {
    context: { issue: describeFirstIssue(parsed.error, name) },
  });
}
