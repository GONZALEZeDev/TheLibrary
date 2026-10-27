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
 * Besides the history itself, the repository answers four questions about whole accounts and
 * heroes: the latest normal-mode matches of a hero (the dashboard), the whole history under a
 * filter (the match list), which accounts have matches, and the deletion of every match of one
 * account (an unlink). The database does the selecting and the deleting; the rules that turn
 * matches into figures stay in `core`.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { parseAccountId, type AccountId } from '../core/domain/account';
import type { HeroId } from '../core/domain/hero';
import { matchIdSchema, type MatchId, type MatchSummary } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import {
  ARCHIVED_GAME_MODE,
  ARCHIVED_MATCH_MODES,
  DETAIL_STATUSES,
  type DetailStatus,
} from '../core/match-detail/detail-status';
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
  // A stored id that the shared rule of the match id rejects makes the whole row invalid, like any
  // other bad column.
  match_id: matchIdSchema,
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

/**
 * Schema of a row `listAccountIds` reads. It only tells a number from anything else: whether the
 * number is a Steam account id is `parseAccountId`'s to say, row by row, so that one damaged row
 * is skipped instead of failing the whole list.
 */
const accountRowSchema = z.object({ account_id: z.int() });

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
   * One match of a player, by its id.
   *
   * It reads the same columns as {@link MatchesRepository.listHistory} and validates the row the
   * same way, so a match is the same whether the list or this call gives it.
   *
   * @param accountId - The player.
   * @param matchId - The match.
   * @returns The match with where its detail stands, or `null` when the player has no such match
   *   (an unknown id, or the match of another player).
   * @throws AppError of kind `storage` when the database fails or holds an invalid row (a match id
   *   or a detail status the app does not know included).
   */
  async get(accountId: AccountId, matchId: MatchId): Promise<StoredMatch | null> {
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT ${LIST_COLUMNS.join(', ')}
           FROM matches WHERE account_id = $1 AND match_id = $2`,
          [accountId, matchId],
        ),
      'Could not read the match',
    );
    // The pair (account, match) is the primary key of the table: there is one row at most.
    const [row] = rows;
    return row === undefined ? null : parseStoredMatch(row, accountId);
  }

  /**
   * Delete every stored match of a player, with the state of their detail queue (it lives in the
   * same rows). The archive files on disk are not touched here.
   *
   * @param accountId - The player.
   * @returns The number of matches deleted; 0 when the player has none (an unlink that is retried).
   * @throws AppError of kind `storage` when the database fails.
   */
  async deleteAccount(accountId: AccountId): Promise<number> {
    return this.#run(
      () => this.#database.execute('DELETE FROM matches WHERE account_id = $1', [accountId]),
      'Could not delete the matches of the account',
    );
  }

  /**
   * The accounts that have matches in the database, whether or not one of them is the linked
   * account: the startup sweep deletes the matches of every account but the linked one.
   *
   * A stored account id that is no Steam account id (a damaged database can hold one: the table
   * does not check the column) is left out instead of failing the list, and is never handed out as
   * an account to delete.
   *
   * @returns Each account id once, lowest first.
   * @throws AppError of kind `storage` when the database fails.
   */
  async listAccountIds(): Promise<AccountId[]> {
    const rows = await this.#run(
      () => this.#database.select('SELECT DISTINCT account_id FROM matches ORDER BY account_id'),
      'Could not list the accounts',
    );
    const accountIds: AccountId[] = [];
    for (const row of rows) {
      const parsed = accountRowSchema.safeParse(row);
      const accountId = parsed.success ? parseAccountId(parsed.data.account_id) : null;
      if (accountId !== null) {
        accountIds.push(accountId);
      }
    }
    return accountIds;
  }

  /**
   * The latest normal-mode matches a hero played, most recent first.
   *
   * Only the normal-mode matches count: the normal game ({@link ARCHIVED_GAME_MODE}) in unranked or
   * ranked mode ({@link ARCHIVED_MATCH_MODES}). Street Brawl and private lobbies say nothing about
   * how a hero plays the real game, the same rule the detail archive follows. Two matches that
   * started the same second keep a fixed order (the higher match id first), so the list never
   * shuffles between two reads.
   *
   * @param accountId - The player.
   * @param heroId - The hero.
   * @param limit - Maximum number of matches.
   * @returns The matches, each with where its detail stands; empty when the player has none.
   * @throws AppError of kind `storage` when the database fails or holds an invalid row (a match id
   *   or a detail status the app does not know included).
   */
  async listLatest(accountId: AccountId, heroId: HeroId, limit: number): Promise<StoredMatch[]> {
    const fixedParams: SqlValue[] = [accountId, heroId, ARCHIVED_GAME_MODE];
    // One placeholder for each archived match mode, numbered after the three values above.
    const modePlaceholders = ARCHIVED_MATCH_MODES.map(
      (_, index) => `$${String(fixedParams.length + index + 1)}`,
    );
    // The limit is bound last, after the modes, because the placeholders are numbered as read.
    const limitPlaceholder = `$${String(fixedParams.length + ARCHIVED_MATCH_MODES.length + 1)}`;
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT ${LIST_COLUMNS.join(', ')}
           FROM matches
           WHERE account_id = $1 AND hero_id = $2
             AND game_mode = $3 AND match_mode IN (${modePlaceholders.join(', ')})
           ORDER BY start_time DESC, match_id DESC LIMIT ${limitPlaceholder}`,
          [...fixedParams, ...ARCHIVED_MATCH_MODES, limit],
        ),
      'Could not read the latest matches',
    );
    return rows.map((row) => parseStoredMatch(row, accountId));
  }

  /**
   * The whole history of a player under a filter, most recent first.
   *
   * Unlike {@link MatchesRepository.listLatest}, every match counts, whatever its mode: Street
   * Brawl and private lobbies are part of what the player played. There is no limit: the screen
   * windows the rows it draws. Two matches that started the same second keep a fixed order (the
   * higher match id first), so the list never shuffles between two reads.
   *
   * @param accountId - The player.
   * @param filter - What to keep.
   * @param filter.heroId - The hero whose matches are kept; `null` for every hero.
   * @param filter.won - `true` for the wins only, `false` for the losses only; `null` for both.
   * @returns The matches, each with where its detail stands; empty when none fits.
   * @throws AppError of kind `storage` when the database fails or holds an invalid row (a match id
   *   or a detail status the app does not know included).
   */
  async listHistory(
    accountId: AccountId,
    filter: { readonly heroId: HeroId | null; readonly won: boolean | null },
  ): Promise<StoredMatch[]> {
    const params: SqlValue[] = [accountId];
    // One condition for each filter in use; its value is bound right after the ones before it, so
    // the placeholders are numbered in order of appearance.
    const conditions = ['account_id = $1'];
    if (filter.heroId !== null) {
      params.push(filter.heroId);
      conditions.push(`hero_id = $${String(params.length)}`);
    }
    if (filter.won !== null) {
      // SQLite has no boolean type: the column holds 1 or 0.
      params.push(filter.won ? 1 : 0);
      conditions.push(`won = $${String(params.length)}`);
    }
    const rows = await this.#run(
      () =>
        this.#database.select(
          `SELECT ${LIST_COLUMNS.join(', ')}
           FROM matches WHERE ${conditions.join(' AND ')}
           ORDER BY start_time DESC, match_id DESC`,
          params,
        ),
      'Could not read the match history',
    );
    return rows.map((row) => parseStoredMatch(row, accountId));
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
 * Validate a row read with {@link LIST_COLUMNS} and turn it into a stored match.
 *
 * @param row - The row, as the database gave it.
 * @param accountId - The player the row was read for.
 * @returns The stored match.
 * @throws AppError of kind `storage` when the row is invalid. The error names the first problem
 *   found, never the value that caused it.
 */
function parseStoredMatch(row: unknown, accountId: AccountId): StoredMatch {
  const parsed = matchRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new AppError('storage', 'A stored match is invalid', {
      context: { issue: parsed.error.issues[0]?.message ?? 'unknown' },
    });
  }
  return toStoredMatch(parsed.data, accountId);
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
