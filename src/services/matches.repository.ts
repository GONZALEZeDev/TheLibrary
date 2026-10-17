/**
 * Storage of the match history in the `matches` table.
 *
 * Writes are idempotent upserts: synchronising the same history twice keeps the same matches (only
 * their `synced_at` time moves), and a synchronisation interrupted halfway is simply redone. Every
 * row read back is validated, so a damaged database is reported as an error instead of reaching
 * the screens.
 *
 * The same rows also carry the state of the detail queue (`detail_status`), which this repository
 * only reads: the history never writes it, so a match that is already archived stays archived.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { AccountId } from '../core/domain/account';
import { parseMatchId, type MatchId, type MatchSummary } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import { DETAIL_STATUSES, type DetailStatus } from '../core/match-detail/detail-status';
import type { Database, SqlValue } from '../ports/database.port';

/**
 * A stored match: its summary, and where its detail stands in the detail queue.
 *
 * It extends {@link MatchSummary} instead of wrapping it: the summary is what deadlock-api gives
 * and what `upsertMany` writes, so it stays unchanged, and code that only reads the summary fields
 * works with a stored match as it does with a summary.
 */
export interface StoredMatch extends MatchSummary {
  /** Where the detail of the match stands; `pending` until the queue has tried it. */
  readonly detailStatus: DetailStatus;
}

/** Columns written for each match, in the order of {@link toParams}. */
const COLUMNS = [
  'account_id',
  'match_id',
  'hero_id',
  'start_time',
  'duration_s',
  'game_mode',
  'match_mode',
  'won',
  'kills',
  'deaths',
  'assists',
  'net_worth',
  'last_hits',
  'denies',
  'rank_delta',
  'synced_at',
] as const;

/**
 * Matches written per statement. 50 rows of 16 columns make 800 parameters, far below SQLite's
 * limit (32,766), while a history of a few hundred matches still takes only a few statements.
 */
const BATCH_SIZE = 50;

/**
 * Columns read for the match list: every written column but `synced_at` (nothing shows it), and the
 * detail status, so one query gives each match with where its detail stands.
 */
const LIST_COLUMNS = [...COLUMNS.filter((column) => column !== 'synced_at'), 'detail_status'];

/** Schema of a row read for the match list. */
const matchRowSchema = z.object({
  account_id: z.int(),
  // A stored id that `parseMatchId` rejects makes the whole row invalid, like any other bad column;
  // the type guard gives the parsed field the `MatchId` brand without a cast.
  match_id: z.int().refine((value): value is MatchId => parseMatchId(value) !== null, {
    message: 'Invalid match id',
  }),
  hero_id: z.int(),
  start_time: z.int(),
  duration_s: z.int(),
  game_mode: z.int(),
  match_mode: z.int(),
  won: z.union([z.literal(0), z.literal(1)]),
  kills: z.int(),
  deaths: z.int(),
  assists: z.int(),
  net_worth: z.int(),
  last_hits: z.int(),
  denies: z.int(),
  rank_delta: z.int().nullable(),
  // Checked against the known statuses (the migration's CHECK keeps others out of the table, but a
  // damaged database is the case this validation is for): a corrupt value is an error, never
  // coerced to a status.
  detail_status: z.enum(DETAIL_STATUSES),
});

/** Reads and writes the `matches` table. */
export class MatchesRepository {
  readonly #database: Database;
  readonly #now: () => number;

  /**
   * @param database - The app database.
   * @param now - Current time (Unix ms), written as `synced_at`.
   */
  constructor(database: Database, now: () => number = Date.now) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * Insert matches, or update them when they are already stored.
   *
   * @param matches - The matches to save.
   * @throws AppError of kind `storage` when the database fails.
   */
  async upsertMany(matches: readonly MatchSummary[]): Promise<void> {
    const syncedAt = this.#now();
    for (let start = 0; start < matches.length; start += BATCH_SIZE) {
      const batch = matches.slice(start, start + BATCH_SIZE);
      // One `($1, …, $16)` group per match: parameters numbered in order of appearance.
      const groups = batch.map((_, row) => {
        const first = row * COLUMNS.length;
        return `(${COLUMNS.map((__, column) => `$${String(first + column + 1)}`).join(', ')})`;
      });
      const updates = COLUMNS.filter((column) => column !== 'account_id' && column !== 'match_id')
        .map((column) => `${column} = excluded.${column}`)
        .join(', ');
      await this.#run(
        () =>
          this.#database.execute(
            `INSERT INTO matches (${COLUMNS.join(', ')}) VALUES ${groups.join(', ')}
             ON CONFLICT (account_id, match_id) DO UPDATE SET ${updates}`,
            batch.flatMap((match) => toParams(match, syncedAt)),
          ),
        'Could not save the matches',
      );
    }
  }

  /**
   * Count the stored matches of a player.
   *
   * @param accountId - The player.
   * @returns The number of matches.
   * @throws AppError of kind `storage` when the database fails or returns an unexpected row.
   */
  async count(accountId: AccountId): Promise<number> {
    const rows = await this.#run(
      () =>
        this.#database.select('SELECT COUNT(*) AS total FROM matches WHERE account_id = $1', [
          accountId,
        ]),
      'Could not count the matches',
    );
    const parsed = z.object({ total: z.int().nonnegative() }).safeParse(rows[0]);
    if (!parsed.success) {
      throw new AppError('storage', 'Unexpected result while counting the matches');
    }
    return parsed.data.total;
  }

  /**
   * The most recent matches of a player, most recent first.
   *
   * @param accountId - The player.
   * @param limit - Maximum number of matches.
   * @returns The matches, each with where its detail stands.
   * @throws AppError of kind `storage` when the database fails or holds an invalid row (a match id
   *   or a detail status the app does not know included).
   */
  async listRecent(accountId: AccountId, limit: number): Promise<StoredMatch[]> {
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT ${LIST_COLUMNS.join(', ')}
           FROM matches WHERE account_id = $1
           ORDER BY start_time DESC, match_id DESC LIMIT $2`,
          [accountId, limit],
        ),
      'Could not read the matches',
    );
    return rows.map((row) => {
      const parsed = matchRowSchema.safeParse(row);
      if (!parsed.success) {
        throw new AppError('storage', 'A stored match is invalid', {
          context: { issue: parsed.error.issues[0]?.message ?? 'unknown' },
        });
      }
      return toStoredMatch(parsed.data, accountId);
    });
  }

  /**
   * Run a database call and wrap its failure in an `AppError` of kind `storage`.
   *
   * @param call - The database call.
   * @param message - Description of the operation, for the logs.
   * @returns The result of the call.
   */
  async #run<T>(call: () => Promise<T>, message: string): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw new AppError('storage', message, { cause: error });
    }
  }
}

/**
 * The parameters of one match, in the order of {@link COLUMNS}.
 *
 * @param match - The match.
 * @param syncedAt - Time of the synchronisation (Unix ms).
 * @returns The values to bind.
 */
function toParams(match: MatchSummary, syncedAt: number): SqlValue[] {
  return [
    match.accountId,
    match.matchId,
    match.heroId,
    match.startTime,
    match.durationS,
    match.gameMode,
    match.matchMode,
    // SQLite has no boolean type, and the desktop driver would bind `true` as the text 'true'.
    match.won ? 1 : 0,
    match.kills,
    match.deaths,
    match.assists,
    match.netWorth,
    match.lastHits,
    match.denies,
    match.rankDelta,
    syncedAt,
  ];
}

/**
 * Turn a validated row into a stored match.
 *
 * @param row - The row.
 * @param accountId - The player the row was read for.
 * @returns The match summary, with the detail status of the row.
 */
function toStoredMatch(row: z.infer<typeof matchRowSchema>, accountId: AccountId): StoredMatch {
  return {
    accountId,
    matchId: row.match_id,
    heroId: row.hero_id,
    startTime: row.start_time,
    durationS: row.duration_s,
    gameMode: row.game_mode,
    matchMode: row.match_mode,
    won: row.won === 1,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    netWorth: row.net_worth,
    lastHits: row.last_hits,
    denies: row.denies,
    rankDelta: row.rank_delta,
    detailStatus: row.detail_status,
  };
}
