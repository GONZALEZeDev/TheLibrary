/**
 * The one-line description of a failed validation that may safely reach an error or a log.
 *
 * The payloads the app validates (match details, archives, Steam profiles, community data) belong
 * to players, and Zod's messages can echo parts of the input. Every reader therefore reports the
 * same thing and nothing more: where the first problem is, and which kind of problem it is.
 *
 * @packageDocumentation
 */
import type { z } from 'zod';

/** The path reported for an issue on the validated value itself, when there is no prefix either. */
const ROOT_PATH = '(root)';

/**
 * Describe the first problem of a failed validation as `<path>: <code>`, e.g.
 * `match_info.players.0.player_slot: invalid_type`.
 *
 * Only the path and the issue code are used, never Zod's message and never a value of the input, so
 * the result can go in the context of an `AppError` (and so in the logs) as it is.
 *
 * @param error - The validation error.
 * @param prefix - What the validated value is, put in front of the path (e.g. `tracked_player`);
 *   leave it out when the value is the whole payload.
 * @returns The path and code of the first issue. `(root)` stands for an issue on the value itself
 *   when there is no prefix, and `invalid` replaces the code if the error holds no issue at all.
 */
export function describeFirstIssue(error: z.ZodError, prefix?: string): string {
  const [issue] = error.issues;
  const path = [...(prefix === undefined ? [] : [prefix]), ...(issue?.path ?? []).map(String)];
  const location = path.length === 0 ? ROOT_PATH : path.join('.');
  return `${location}: ${issue?.code ?? 'invalid'}`;
}
