/**
 * The replay of a match: what the map replay of the timeline tab shows. It is where every player was
 * each second on the minimap picture, when they were dead, which objectives had fallen and when the
 * mid boss was killed and came back.
 *
 * It is the twin of `./match-timeline.service`: it reads the archive of the match
 * (`./archive-reader.service`) and nothing else of the match, so it asks `./analysis-subject` only
 * whether the match is archived for the linked account (`archivedAccountOf`), and is shown whether or
 * not the analysis has run. Everything in it is read when the tab is asked for, by the core readers
 * of the archive (`../core/match-map/match-replay`), not stored.
 *
 * The map and hero catalogues (`./game-asset.service`, `./hero-catalog.service`) only decorate the
 * replay: without the map there is no picture to place anything on (`map` is `null` and so are the
 * positions, and the page says so), and without the heroes the players have no name and no icon. They
 * are read last, so a match that cannot be shown downloads nothing for them.
 *
 * Nothing is logged on the normal path. Two kinds of lines are written, never with an account id or
 * a value of the payload or of a catalogue: one at `info` level each time a catalogue cannot be read
 * (once per call, however many catalogues failed), and one warning per match whose replay cannot be
 * read, with the field path and the issue code of the payload only. What the tab can be told about a
 * match is `ReplayView`, in `./match-replay-view`.
 *
 * @packageDocumentation
 */
import type { MapLayout } from '../core/deadlock-api/map.schema';
import type { HeroAsset } from '../core/domain/hero';
import type { MatchId } from '../core/domain/match';
import { midBossReturns } from '../core/match-map/game-schedule';
import { worldToRelative } from '../core/match-map/map-geometry';
import {
  identifyObjective,
  MAP_OBJECTIVE_IDS,
  MID_BOSS_POSITION,
  objectivePosition,
} from '../core/match-map/map-objectives';
import { readMatchReplay, type MatchReplay } from '../core/match-map/match-replay';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import { archivedAccountOf } from './analysis-subject';
import type { ArchiveReaderService } from './archive-reader.service';
import { readCatalogues, readOrReport } from './archive-tab-reading';
import type { GameAssetService } from './game-asset.service';
import type { HeroCatalogService } from './hero-catalog.service';
import type { MatchDetailRepository } from './match-detail.repository';
import type {
  ReplayMap,
  ReplayView,
  ReplayViewObjective,
  ReplayViewPlayer,
  Side,
} from './match-replay-view';
import { ReportOnce } from './report-once';

/** What {@link MatchReplayService} needs. */
export interface MatchReplayServiceDependencies {
  /** The linked account. The service works for it only, which it resolves itself. */
  readonly accountSource: AccountSource;
  /** Where the detail state of the matches is kept: only an archived match can be replayed. */
  readonly details: MatchDetailRepository;
  /** Reads the archive of a match. */
  readonly reader: ArchiveReaderService;
  /** The hero catalogue: the names and the icons of the heroes. */
  readonly heroes: HeroCatalogService;
  /** The game's catalogues: the map layout gives the picture, the lanes and the objectives' places. */
  readonly assets: GameAssetService;
  /** Structured logger. */
  readonly logger: Logger;
}

/** The scope of the log lines of this service. */
const LOG_SCOPE = 'replay';

/** The two teams of a match, as the API numbers them. */
const TEAMS: readonly number[] = [0, 1];

/**
 * What the replay takes from the catalogues. Both only decorate it, so each may be missing: a
 * catalogue that could not be read is `null`.
 */
interface ReplayCatalogues {
  /** The map layout, or `null` when the map asset could not be read. */
  readonly layout: MapLayout | null;
  /** The playable heroes by id, or `null` when the hero catalogue could not be read. */
  readonly heroes: ReadonlyMap<number, HeroAsset> | null;
}

/**
 * The side of a team, relative to the tracked player.
 *
 * @param team - A team, as the API numbers it.
 * @param trackedTeam - The team of the tracked player.
 * @returns `ally` for the team of the tracked player, `enemy` for any other.
 */
function sideOf(team: number, trackedTeam: number): Side {
  return team === trackedTeam ? 'ally' : 'enemy';
}

/**
 * The map the replay is drawn with.
 *
 * @param layout - The map layout, or `null` when it could not be read.
 * @returns The picture, the lanes and the mid boss pit; `null` without a layout.
 */
function mapOf(layout: MapLayout | null): ReplayMap | null {
  return layout === null
    ? null
    : { imageUrl: layout.imageUrl, lanes: layout.lanes, midBoss: MID_BOSS_POSITION };
}

/**
 * The players of the replay, placed on the picture and decorated with their hero.
 *
 * @param replay - The replay read from the archive.
 * @param catalogues - What the catalogues gave.
 * @returns One entry per player, sorted by slot as the replay is. Without a layout every `positions`
 *   is empty: nothing can be placed on a picture that is not there.
 */
function playersOf(replay: MatchReplay, catalogues: ReplayCatalogues): readonly ReplayViewPlayer[] {
  const { layout, heroes } = catalogues;
  return replay.players.map((player): ReplayViewPlayer => {
    const hero = heroes?.get(player.heroId);
    return {
      slot: player.slot,
      side: sideOf(player.team, replay.trackedTeam),
      isTracked: player.isTracked,
      heroId: player.heroId,
      heroName: hero?.name ?? null,
      // The minimap icon is made for the map; the portrait is the next best, then nothing.
      iconUrl: hero?.minimapImageUrl ?? hero?.imageUrl ?? null,
      hasPath: player.hasPath,
      positions:
        layout === null
          ? []
          : player.positions.map((point) =>
              point === null ? null : worldToRelative(point, layout.radius),
            ),
      deaths: player.deaths,
    };
  });
}

/**
 * Every objective of the map, the fallen ones with the second they fell at.
 *
 * @param replay - The replay read from the archive, which lists the objectives that were destroyed.
 * @param layout - The map layout, or `null` when it could not be read.
 * @returns The 26 objectives: the ones of team 0 then of team 1, each in the order of
 *   {@link MAP_OBJECTIVE_IDS}. An objective the archive does not list stood until the end.
 */
function objectivesOf(
  replay: MatchReplay,
  layout: MapLayout | null,
): readonly ReplayViewObjective[] {
  return TEAMS.flatMap((team) =>
    MAP_OBJECTIVE_IDS.flatMap((teamObjectiveId): ReplayViewObjective[] => {
      const identity = identifyObjective(teamObjectiveId);
      if (identity === null) {
        // Cannot happen: the ids are the ones the map knows. Nothing is made up for a missing one.
        return [];
      }
      const fallen = replay.objectives.find(
        (objective) => objective.team === team && objective.teamObjectiveId === teamObjectiveId,
      );
      return [
        {
          side: sideOf(team, replay.trackedTeam),
          identity,
          position: layout === null ? null : objectivePosition(team, identity, layout),
          destroyedAtS: fallen?.destroyedAtS ?? null,
        },
      ];
    }),
  );
}

/** Tells the replay of a match: what the map replay of the timeline tab shows. */
export class MatchReplayService {
  /** What the gate the analysis shares reads to find whether a match is archived. */
  readonly #gateDeps: Pick<MatchReplayServiceDependencies, 'accountSource' | 'details'>;
  readonly #reader: ArchiveReaderService;
  readonly #heroes: HeroCatalogService;
  readonly #assets: GameAssetService;
  readonly #logger: Logger;

  /**
   * Reports a match whose replay cannot be read. Such a match stays so until its archive is written
   * again, and the page reads the replay every time the tab is shown: the problem is reported once,
   * not at every read.
   */
  readonly #reports: ReportOnce;

  /**
   * @param dependencies - See {@link MatchReplayServiceDependencies}.
   */
  constructor(dependencies: MatchReplayServiceDependencies) {
    this.#gateDeps = { accountSource: dependencies.accountSource, details: dependencies.details };
    this.#reader = dependencies.reader;
    this.#heroes = dependencies.heroes;
    this.#assets = dependencies.assets;
    this.#logger = dependencies.logger;
    this.#reports = new ReportOnce(dependencies.logger, LOG_SCOPE);
  }

  /**
   * Read the replay of a match of the linked account, as its archive keeps it. Nothing is projected
   * and nothing is changed; the only requests this can send are the downloads of the map and hero
   * catalogues when they are older than a week (or were never downloaded), and only for a match that
   * can be shown.
   *
   * @param matchId - The match.
   * @returns What the tab shows, see {@link ReplayView}. A match that is not archived is
   *   `not_archived`; one whose archive is gone or damaged, or whose replay cannot be read, is
   *   `unreadable`. Otherwise the replay, whose `map` is `null` and positions are empty when the map
   *   cannot be read, and whose hero names and icons are `null` when the hero catalogue cannot.
   * @throws AppError of kind `storage` when the database fails (the account, the detail state), or
   *   when the file of the archive cannot be read or the compressor is broken (neither says anything
   *   about the match). A failure of the catalogues never comes out, of whatever kind. Any other
   *   error of the reading of the archive is a bug and is not hidden behind a state.
   */
  async getReplay(matchId: MatchId): Promise<ReplayView> {
    // Only the archive is needed: no projection, so the replay is there before the analysis has run.
    const accountId = await archivedAccountOf(this.#gateDeps, matchId);
    if (accountId === null) {
      return { kind: 'not_archived' };
    }

    const archive = await this.#reader.readArchive(accountId, matchId);
    if (archive.kind === 'unreadable') {
      // The reader told why; the detail view of the match explains the archive.
      return { kind: 'unreadable' };
    }
    const replay = readOrReport(
      this.#reports,
      matchId,
      'The replay of a match could not be read',
      () => readMatchReplay(archive.envelope),
    );
    if (replay === null) {
      return { kind: 'unreadable' };
    }

    // The catalogues are read last: a match that cannot be shown downloads nothing for them.
    const catalogues = await this.#readCatalogues(matchId);
    const killTimesS = replay.midBossKills.map((kill) => kill.timeS);
    return {
      kind: 'replay',
      durationS: replay.durationS,
      coverage: replay.coverage,
      map: mapOf(catalogues.layout),
      players: playersOf(replay, catalogues),
      objectives: objectivesOf(replay, catalogues.layout),
      midBossKills: replay.midBossKills.map((kill) => ({
        timeS: kill.timeS,
        killedBy: sideOf(kill.teamKilled, replay.trackedTeam),
        claimedBy: sideOf(kill.teamClaimed, replay.trackedTeam),
      })),
      // The mid boss that comes back after the match is over never came back.
      midBossReturnsS: midBossReturns(killTimesS).filter((timeS) => timeS <= replay.durationS),
    };
  }

  /**
   * Read the two catalogues the replay is decorated with: the map (the picture, the lanes and the
   * objectives' places) and the heroes (names and icons). Both come from the cache when it is fresh
   * (and even when it is not, should the download fail); a catalogue is downloaded only when it was
   * never or is no longer cached.
   *
   * Neither is needed to show the replay, so a catalogue that cannot be read is `null` and never an
   * error, whatever the failure was: the other catalogue is still used.
   *
   * @param matchId - The match the tab is read for, for the log line.
   * @returns The catalogues, each `null` when it could not be read. One line is logged at `info`
   *   level in that case, whatever the number of catalogues that failed.
   */
  async #readCatalogues(matchId: MatchId): Promise<ReplayCatalogues> {
    const { first: layout, second: heroes } = await readCatalogues(
      this.#logger,
      LOG_SCOPE,
      matchId,
      () => this.#assets.getMapLayout(),
      () => this.#heroes.getHeroAssets(),
    );
    return {
      layout,
      heroes: heroes === null ? null : new Map(heroes.map((hero) => [hero.id, hero])),
    };
  }
}
