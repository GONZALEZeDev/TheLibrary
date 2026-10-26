/**
 * The timeline of a match: what the timeline tab of the match page shows. It is the souls of the
 * tracked player over the match against their lane opponents, the phases, the heroes they killed,
 * the items they bought, and their deaths with who was near them and whether the death was
 * avoidable.
 *
 * It reads the archive of the match (`./archive-reader.service`) and nothing else of the match: it
 * needs no projection, so it asks `./analysis-subject` only whether the match is archived for the
 * linked account (`archivedAccountOf`), like the players tab, and is shown whether or not the
 * analysis has run. Everything in it is read when the tab is asked for, by the core readers of the
 * archive (`../core/analysis/match-context`, `../core/analysis/avoidable-deaths`,
 * `../core/match-detail/tracked-items`), not stored.
 *
 * When the positions of the other players are not in the archive, the detail state of the match
 * (`./match-detail.repository`) tells whether the next synchronisation will download it again with
 * them: the detail queue does so for an archive written before the format was recorded, while the
 * match is within the window it archives (`isDetailEligible`).
 *
 * The hero and item catalogues (`./hero-catalog.service`, `./game-asset.service`) only decorate the
 * timeline: without them the killers and the purchases are told by their ids, and no state says so.
 * They are read last, so a match that cannot be shown downloads nothing for them.
 *
 * Nothing is logged on the normal path. Two kinds of lines are written, never with an account id or
 * a value of the payload or of a catalogue: one at `info` level each time a catalogue cannot be read
 * (once per call, however many catalogues failed), and one warning per match whose timeline cannot
 * be read, with the field path and the issue code of the payload only. What the tab can be told
 * about a match is `TimelineTabView`, in `./match-timeline-view`.
 *
 * @packageDocumentation
 */
import {
  avoidableDeathCount,
  judgeDeaths,
  type JudgedDeaths,
} from '../core/analysis/avoidable-deaths';
import { readableSourceName } from '../core/analysis/damage-breakdown';
import {
  buildMatchContext,
  statAt,
  type MatchContext,
  type PlayerContext,
} from '../core/analysis/match-context';
import { phaseSpans } from '../core/analysis/phases';
import type { AccountId } from '../core/domain/account';
import type { HeroAsset } from '../core/domain/hero';
import type { MatchId } from '../core/domain/match';
import { errorLogContext, isAppError, issueOf, toAppError } from '../core/errors/app-error';
import type { ArchiveEnvelope } from '../core/match-detail/archive-envelope';
import { isDetailEligible } from '../core/match-detail/detail-status';
import { readTrackedItems, type ItemEntry } from '../core/match-detail/tracked-items';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import { archivedAccountOf } from './analysis-subject';
import type { ArchiveReaderService } from './archive-reader.service';
import type { GameAssetService, ItemCatalogue } from './game-asset.service';
import type { HeroCatalogService } from './hero-catalog.service';
import type { MatchDetailRepository } from './match-detail.repository';
import type {
  SoulsPoint,
  TimelineDeath,
  TimelinePositions,
  TimelinePurchase,
  TimelineSouls,
  TimelineTabView,
} from './match-timeline-view';
import { ReportOnce } from './report-once';

/** What {@link MatchTimelineService} needs. */
export interface MatchTimelineServiceDependencies {
  /** The linked account. The service works for it only, which it resolves itself. */
  readonly accountSource: AccountSource;
  /**
   * Where the detail state of the matches is kept: only an archived match can be shown, and the
   * format of its archive tells whether the positions will be downloaded again.
   */
  readonly details: MatchDetailRepository;
  /** Reads the archive of a match. */
  readonly reader: ArchiveReaderService;
  /** The hero catalogue: the names of the killers' heroes. */
  readonly heroes: HeroCatalogService;
  /** The game's catalogues: the item catalogue names the purchases and tells the shop items. */
  readonly assets: GameAssetService;
  /** Structured logger. */
  readonly logger: Logger;
  /** Current time (Unix ms), for the window the detail queue downloads the matches in. */
  readonly now: () => number;
}

/** The scope of the log lines of this service. */
const LOG_SCOPE = 'timeline';

/** What the timeline reads out of the archive of a match, before the catalogues decorate it. */
interface ArchiveTimeline {
  /** The match as the analysis reads it: the length, the souls, the lanes and the kills. */
  readonly context: MatchContext;
  /** The deaths of the tracked player, judged. */
  readonly judged: JudgedDeaths;
  /** The hero each player of the match played, by their slot: the heroes of the killers. */
  readonly heroBySlot: ReadonlyMap<number, number>;
  /** The shop entries of the tracked player, sorted by time. */
  readonly shopEntries: readonly ItemEntry[];
}

/**
 * What the timeline takes from the catalogues. Both only decorate it, so each may be missing: a
 * catalogue that could not be read is `null`.
 */
interface TimelineCatalogues {
  /** The playable heroes by id: their names. */
  readonly heroes: ReadonlyMap<number, HeroAsset> | null;
  /** The items of the game, or `null` when the item catalogue could not be read. */
  readonly items: ItemCatalogue | null;
}

/**
 * Read what the timeline needs out of the archive of a match.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns What the timeline is made of.
 * @throws AppError of kind `invalid_payload` when a reader refuses the archive (the error is the
 *   reader's, unchanged).
 */
function readArchiveTimeline(envelope: ArchiveEnvelope): ArchiveTimeline {
  return {
    context: buildMatchContext(envelope),
    judged: judgeDeaths(envelope),
    // The hero of a killer is read on the players of the payload, whose slot and hero the archive
    // checked when it was written: the scoreboard would read far more than needed.
    heroBySlot: new Map(
      envelope.payload.match_info.players.map((player) => [player.player_slot, player.hero_id]),
    ),
    shopEntries: readTrackedItems(envelope).filter((item) => item.isShopItem),
  };
}

/**
 * The souls lines of the chart.
 *
 * The player's line is their souls at each snapshot that holds them, from `(0, 0)`: every counter
 * is 0 when the match starts, as `statAt` reads it too. Their opponents' line is the mean of the
 * souls of their lane opponents at the same times, so that the two lines can be read point by point.
 *
 * @param context - The match.
 * @returns The lines, the opponents' `null` when the player has no lane opponent or when the souls
 *   of one of them are not known at one of the times (after their last snapshot, or in none).
 */
function soulsOf(context: MatchContext): TimelineSouls {
  const you: SoulsPoint[] = [{ timeS: 0, souls: 0 }];
  for (const snapshot of context.tracked.snapshots) {
    const souls = snapshot.stats.net_worth;
    // A snapshot without the counter is skipped, never read as 0.
    if (souls !== undefined) {
      you.push({ timeS: snapshot.timeS, souls });
    }
  }
  const opponents = context.laneOpponents;
  return {
    you,
    opponents: opponents.length === 0 ? null : meanSoulsOf(opponents, you),
    opponentCount: opponents.length,
  };
}

/**
 * The mean souls of some players at the times of a line.
 *
 * @param players - The players, at least one.
 * @param times - The points whose times the mean is read at.
 * @returns The mean at each time, or `null` as soon as one player's souls are not known at one of
 *   them: a mean of the others would not be the mean of the lane.
 */
function meanSoulsOf(
  players: readonly PlayerContext[],
  times: readonly SoulsPoint[],
): readonly SoulsPoint[] | null {
  const points: SoulsPoint[] = [];
  for (const { timeS } of times) {
    let sum = 0;
    for (const player of players) {
      const souls = statAt(player, 'net_worth', timeS);
      if (souls === null) {
        return null;
      }
      sum += souls;
    }
    points.push({ timeS, souls: sum / players.length });
  }
  return points;
}

/**
 * The deaths of the tracked player as the tab lists them.
 *
 * Slot `0` is the world (troopers, the environment); any other slot is a hero. A killer slot that
 * no player of the match has is an unknown hero, not a reason to hide the timeline: the death keeps
 * its time, who was near and its verdict, which do not depend on the hero.
 *
 * @param read - What the archive gave.
 * @param heroes - The hero catalogue by id, or `null` when it could not be read.
 * @returns The deaths, or `null` when the death detail of the player is incomplete.
 */
function deathsOf(
  read: ArchiveTimeline,
  heroes: ReadonlyMap<number, HeroAsset> | null,
): readonly TimelineDeath[] | null {
  return (
    read.judged.deaths?.map((death): TimelineDeath => {
      const heroId = read.heroBySlot.get(death.killerSlot) ?? null;
      return {
        timeS: death.timeS,
        killer:
          death.killerSlot === 0
            ? { kind: 'world' }
            : {
                kind: 'hero',
                heroId,
                name: heroId === null ? null : (heroes?.get(heroId)?.name ?? null),
              },
        timeToKillS: death.timeToKillS,
        enemiesNear: death.nearby?.enemies ?? null,
        alliesNear: death.nearby?.allies ?? null,
        verdict: death.verdict,
      };
    }) ?? null
  );
}

/**
 * The purchases of the tracked player as the tab places them.
 *
 * The archive tells a shop entry by its `upgrade_id`; the item catalogue, when it can be read,
 * confirms it: an entry the catalogue knows as something else than a shop item (an ability, a
 * weapon) is left out. An item the catalogue does not know is kept, unnamed: the game may have
 * added it after the catalogue was cached.
 *
 * @param entries - The shop entries of the player, sorted by time.
 * @param items - The item catalogue, or `null` when it could not be read.
 * @returns The purchases, sorted by time.
 */
function purchasesOf(
  entries: readonly ItemEntry[],
  items: ItemCatalogue | null,
): readonly TimelinePurchase[] {
  return entries.flatMap((entry): TimelinePurchase[] => {
    const item = items?.byId.get(entry.itemId);
    if (item !== undefined && item.kind !== 'upgrade') {
      return [];
    }
    return [
      {
        timeS: entry.timeS,
        itemId: entry.itemId,
        // The catalogue's name, or its class name made readable for the few entries it has no name
        // for, as the build of the damage tab does.
        name: item === undefined ? null : (item.name ?? readableSourceName(item.className)),
        imageUrl: item?.imageUrl ?? null,
      },
    ];
  });
}

/** Tells the timeline of a match: what the timeline tab of the match page shows. */
export class MatchTimelineService {
  /** What the gate the analysis shares reads to find whether a match is archived. */
  readonly #gateDeps: Pick<MatchTimelineServiceDependencies, 'accountSource' | 'details'>;
  readonly #details: MatchDetailRepository;
  readonly #reader: ArchiveReaderService;
  readonly #heroes: HeroCatalogService;
  readonly #assets: GameAssetService;
  readonly #logger: Logger;
  readonly #now: () => number;

  /**
   * Reports a match whose timeline cannot be read. Such a match stays so until its archive is
   * written again, and the page reads the tab every time it is shown: the problem is reported once,
   * not at every read.
   */
  readonly #reports: ReportOnce;

  /**
   * @param dependencies - See {@link MatchTimelineServiceDependencies}.
   */
  constructor(dependencies: MatchTimelineServiceDependencies) {
    this.#gateDeps = { accountSource: dependencies.accountSource, details: dependencies.details };
    this.#details = dependencies.details;
    this.#reader = dependencies.reader;
    this.#heroes = dependencies.heroes;
    this.#assets = dependencies.assets;
    this.#logger = dependencies.logger;
    this.#now = dependencies.now;
    this.#reports = new ReportOnce(dependencies.logger, LOG_SCOPE);
  }

  /**
   * Read the timeline tab of a match of the linked account, as its archive keeps it. Nothing is
   * projected and nothing is changed; the only requests this can send are the downloads of the hero
   * and item catalogues when they are older than a week (or were never downloaded), and only for a
   * match that can be shown.
   *
   * @param matchId - The match.
   * @returns What the tab shows, see {@link TimelineTabView}. A match that is not archived is
   *   `not_archived`; one whose archive is gone or damaged, or whose timeline cannot be read, is
   *   `unreadable`. Otherwise the timeline, whose killers' names and purchases' names and images are
   *   `null` where the catalogues do not give them.
   * @throws AppError of kind `storage` when the database fails (the account, the detail state), or
   *   when the file of the archive cannot be read or the compressor is broken (neither says anything
   *   about the match). A failure of the catalogues never comes out, of whatever kind and database
   *   failures of their cache included. Any other error of the reading of the archive is a bug and
   *   is not hidden behind a state.
   */
  async getTimelineTab(matchId: MatchId): Promise<TimelineTabView> {
    // Only the archive is needed: no projection, so the tab is there before the analysis has run.
    const accountId = await archivedAccountOf(this.#gateDeps, matchId);
    if (accountId === null) {
      return { kind: 'not_archived' };
    }

    const archive = await this.#reader.readArchive(accountId, matchId);
    if (archive.kind === 'unreadable') {
      // The reader told why; the detail view of the match explains the archive.
      return { kind: 'unreadable' };
    }
    const read = this.#readOrReport(matchId, () => readArchiveTimeline(archive.envelope));
    if (read === null) {
      return { kind: 'unreadable' };
    }
    const positions = await this.#positionsOf(accountId, matchId, read.judged.positionsKnown);

    // The catalogues are read last: a match that cannot be shown downloads nothing for them.
    const catalogues = await this.#readCatalogues(matchId);
    const { context } = read;
    return {
      kind: 'timeline',
      durationS: context.durationS,
      phases: phaseSpans(context.durationS).map(({ phase, startS, endS }) => ({
        phase,
        startS,
        endS,
      })),
      souls: soulsOf(context),
      // The kills of the match are known for all its players or for none of them.
      kills:
        context.kills
          ?.filter((kill) => kill.killerSlot === context.tracked.slot)
          .map((kill) => kill.timeS) ?? null,
      purchases: purchasesOf(read.shopEntries, catalogues.items),
      deaths: deathsOf(read, catalogues.heroes),
      avoidableCount: avoidableDeathCount(read.judged),
      positions,
    };
  }

  /**
   * Tell whether the positions of the other players are known, and when they are not, whether the
   * next synchronisation brings them.
   *
   * The detail queue downloads again, within the window it archives, the archives written before
   * the format was recorded (`archiveFormat` `null`): the ones of the first format, which hold the
   * path of the tracked player only. An archive of the first format whose download failed for good
   * (`1`), or one of the current format whose paths are incomplete (`2`, the API sent no more), is
   * never downloaded again.
   *
   * @param accountId - The linked account.
   * @param matchId - The match.
   * @param positionsKnown - Whether the archive holds the positions of every player.
   * @returns The state of the positions, see {@link TimelinePositions}. The detail state is only
   *   read when the positions are not known; a match no longer `ready` by then (reset in between)
   *   is `missing`, since it is no longer archived for a refresh to apply to.
   * @throws AppError of kind `storage` when the database fails.
   */
  async #positionsOf(
    accountId: AccountId,
    matchId: MatchId,
    positionsKnown: boolean,
  ): Promise<TimelinePositions> {
    if (positionsKnown) {
      return 'known';
    }
    const detail = await this.#details.getDetail(accountId, matchId);
    const refreshScheduled =
      detail?.status === 'ready' &&
      detail.archiveFormat === null &&
      isDetailEligible(detail.match, this.#now());
    return refreshScheduled ? 'missing_refresh_scheduled' : 'missing';
  }

  /**
   * Read the two catalogues the timeline is decorated with: the heroes (the killers' names) and the
   * items (the purchases' names and images, and which entries are shop items). Both come from the
   * cache when it is fresh (and even when it is not, should the download fail); a catalogue is
   * downloaded only when it was never or is no longer cached.
   *
   * Neither is needed to show the timeline, so a catalogue that cannot be read is `null` and never
   * an error, whatever the failure was (offline with nothing cached, a refused request, a spent
   * budget, a pause, the cache itself): the other catalogue is still used.
   *
   * @param matchId - The match the tab is read for, for the log line.
   * @returns The catalogues, each `null` when it could not be read. One line is logged at `info`
   *   level in that case, whatever the number of catalogues that failed.
   */
  async #readCatalogues(matchId: MatchId): Promise<TimelineCatalogues> {
    const failures: unknown[] = [];
    const keepFailure = (error: unknown): null => {
      failures.push(error);
      return null;
    };
    // Both are asked at once: they share the asset budget, and each shares its run among the calls
    // that overlap, so the page asking twice downloads each catalogue once.
    const [heroes, items] = await Promise.all([
      this.#heroes.getHeroAssets().catch(keepFailure),
      this.#assets.getItemCatalogue().catch(keepFailure),
    ]);
    if (failures.length > 0) {
      // The catalogue services logged what a refresh that fell back on the cache could not do; this
      // is the one that has no cache to fall back on. The first failure tells the state of the
      // network as well as all of them would.
      this.#logger.log('info', LOG_SCOPE, 'A catalogue of the game could not be read', {
        ...errorLogContext(toAppError(failures[0])),
        matchId,
      });
    }
    return {
      heroes: heroes === null ? null : new Map(heroes.map((hero) => [hero.id, hero])),
      items,
    };
  }

  /**
   * Read the timeline out of an archive whose payload may not be what is expected.
   *
   * @param matchId - The match.
   * @param read - Reads it out of the decoded archive of the match.
   * @returns What `read` returns, or `null` when the archive lacks what is read or holds it in a
   *   shape that is not expected: that says something about the archive, not about the match, so it
   *   is reported (once, see `#reports`) and the view is `unreadable`. The match is not changed:
   *   the archive passed the checks of the door when it was written.
   * @throws Error when the reading fails for any other reason: that is a bug, which must be seen as
   *   one.
   */
  #readOrReport<Read>(matchId: MatchId, read: () => Read): Read | null {
    try {
      return read();
    } catch (error) {
      if (!isAppError(error) || error.kind !== 'invalid_payload') {
        throw error;
      }
      this.#reports.warn(matchId, 'The timeline of a match could not be read', {
        issue: issueOf(error),
      });
      return null;
    }
  }
}
