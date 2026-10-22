/**
 * The breakdown of a match: the views of the match page that read what the analysis of its metrics
 * (`./analysis.service`) leaves aside. Each view has its own method and its own part of this file.
 * This file reads what the views are made of (the stored projections, the archive of the match and
 * the catalogues) and logs what it cannot read. The views, the states that say why a view has
 * nothing to show and the pure builders that turn what is read into the views are in
 * `./match-breakdown-view`.
 *
 * **The damage and build view** ({@link MatchBreakdownService.getDamageTab}) tells how the player
 * dealt their damage, source by source, compared with their own habits, and what they ended the
 * match with. It is made of four things:
 * - the damage by source, and the other values that tell it (the damage dealt while an item was
 *   owned, the unlock of each ability), are the values the projection stored for the match and for
 *   the earlier ones (`./metrics.repository`, `../core/analysis/damage-sources`);
 * - the loadout of Paige, which tells her weapon, melee and signature abilities from the rest, comes
 *   from the hero catalogue (`./hero-catalog.service`), and the names, slots, tiers and images from
 *   the item catalogue (`./game-asset.service`). Both are kept in the database for a week: the view
 *   sends a request only when one of them is older, through the services that own them;
 * - the final build is the only part read from the archive of the match (`./archive-reader.service`).
 *
 * The shares, the kinds and the habits are computed when the view is asked for
 * (`../core/analysis/damage-breakdown`), not stored. Where a match stands before any of it is read
 * (the states of `DamageTabView`, see `./match-breakdown-view`) is decided by
 * `./analysis-subject`, the gate the analysis shares: the two views of a match tell the same states
 * the same way. Nothing is projected, nothing is downloaded for a match that is not `projected` or
 * whose archive cannot be read, and the view never changes the match.
 *
 * **The players view** ({@link MatchBreakdownService.getPlayersTab}) is the scoreboard of the match:
 * its twelve players by team, with their hero, their rank and their place in Valve's top three, and
 * the places the tracked player takes among them. It reads the archive of the match
 * (`./archive-reader.service`, `../core/match-detail/scoreboard`) and nothing else of the match: it
 * needs no projection, so it asks `./analysis-subject` only whether the match is archived for the
 * linked account (`archivedAccountOf`), not whether it is analysed, and is shown whether or not the
 * analysis has run. The hero and rank catalogues (`./hero-catalog.service`,
 * `./game-asset.service`) only decorate it: without them the players are shown by the id of their
 * hero and without the badge of their rank, and no state says so. What the tab can be told about a
 * match is `PlayersTabView`, in `./match-breakdown-view`.
 *
 * Nothing is logged on the normal path. Two kinds of lines are written, never with an account id or
 * a value of the payload or of a catalogue: one at `info` level each time a catalogue cannot be read
 * (it is the state of the network, not a fault; once per call, however many catalogues failed), and
 * one warning per match and per problem whose items or scoreboard cannot be read, with the field
 * path and the issue code of the payload only.
 *
 * @packageDocumentation
 */
import { buildDamageBreakdown } from '../core/analysis/damage-breakdown';
import { PREVIOUS_LOOKUP } from '../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import type { CatalogueRank } from '../core/deadlock-api/assets.schema';
import { PAIGE_HERO_ID, type HeroLoadout } from '../core/domain/hero';
import type { MatchId } from '../core/domain/match';
import { errorLogContext, isAppError, issueOf, toAppError } from '../core/errors/app-error';
import { placesOf, readScoreboard } from '../core/match-detail/scoreboard';
import { finalBuildOf, readTrackedItems } from '../core/match-detail/tracked-items';
import type { AccountSource } from '../ports/account-source.port';
import type { Logger } from '../ports/logger.port';
import {
  analysisSubjectOf,
  archivedAccountOf,
  type AnalysisSubjectDependencies,
} from './analysis-subject';
import type { ArchiveReaderService } from './archive-reader.service';
import type { GameAssetService, ItemCatalogue } from './game-asset.service';
import type { HeroCatalogService } from './hero-catalog.service';
import {
  describeBuild,
  describeTeams,
  type DamageTabView,
  type PlayerCatalogues,
  type PlayersTabView,
} from './match-breakdown-view';
import type { MatchDetailRepository } from './match-detail.repository';
import type { MetricsRepository } from './metrics.repository';
import { ReportOnce } from './report-once';

/** What {@link MatchBreakdownService} needs. */
export interface MatchBreakdownServiceDependencies {
  /** The linked account. The service works for it only, which it resolves itself. */
  readonly accountSource: AccountSource;
  /** Where the detail state of the matches is kept: only an archived match can be shown. */
  readonly details: MatchDetailRepository;
  /** Where the projections of the matches are kept: their values, and the habits of the player. */
  readonly metrics: MetricsRepository;
  /** Reads the archive of a match, for its build and its scoreboard. */
  readonly reader: ArchiveReaderService;
  /** The hero catalogue: the loadout of Paige, and the names and portraits of the players' heroes. */
  readonly heroes: HeroCatalogService;
  /**
   * The game's catalogues: the items (the names, slots, tiers and images of the damage sources and
   * the build) and the rank tiers (the badges of the players' ranks).
   */
  readonly assets: GameAssetService;
  /** Structured logger. */
  readonly logger: Logger;
}

/** The scope of the log lines of this service. */
const LOG_SCOPE = 'breakdown';

/**
 * What the damage view needs from the catalogues: the loadout that tells the sources of Paige, and
 * the item catalogue that names them.
 */
interface DamageCatalogues {
  /** The weapon, the melee attack and the four signature abilities of Paige. */
  readonly loadout: HeroLoadout;
  /** The items, abilities and weapons of the game. */
  readonly items: ItemCatalogue;
}

/** Tells what the match page shows besides the analysis of a match, from its projection and archive. */
export class MatchBreakdownService {
  /**
   * What the gates the analysis shares read to find where a match stands: {@link analysisSubjectOf}
   * for the damage tab, {@link archivedAccountOf} for the players tab.
   */
  readonly #subjectDeps: AnalysisSubjectDependencies;
  readonly #metrics: MetricsRepository;
  readonly #reader: ArchiveReaderService;
  readonly #heroes: HeroCatalogService;
  readonly #assets: GameAssetService;
  readonly #logger: Logger;

  /**
   * Reports a match whose items or scoreboard cannot be read. Such a match stays so until its
   * archive is written again, and the page reads the views every time it is shown: a problem is
   * reported once, not at every read. The two problems of one match are two reports: finding one
   * must not hide the other.
   */
  readonly #reports: ReportOnce;

  /**
   * @param dependencies - See {@link MatchBreakdownServiceDependencies}.
   */
  constructor(dependencies: MatchBreakdownServiceDependencies) {
    this.#subjectDeps = {
      accountSource: dependencies.accountSource,
      details: dependencies.details,
      metrics: dependencies.metrics,
    };
    this.#metrics = dependencies.metrics;
    this.#reader = dependencies.reader;
    this.#heroes = dependencies.heroes;
    this.#assets = dependencies.assets;
    this.#logger = dependencies.logger;
    this.#reports = new ReportOnce(dependencies.logger, LOG_SCOPE);
  }

  /**
   * Read the damage and build tab of a match of the linked account, as it is stored: the damage the
   * player dealt with each source, compared with their habits, and the items they ended the match
   * with. Nothing is projected and nothing is changed; the only request this can send is the
   * download of a catalogue that is older than a week (or that was never downloaded), and only for a
   * match that can be shown: the archive is read before the catalogues, so a match whose archive or
   * items cannot be read downloads nothing.
   *
   * @param matchId - The match.
   * @returns What the tab shows, see {@link DamageTabView}. A match that is not archived is
   *   `not_analysed`; one without a projection of the current version is `pending`; one the
   *   projection could not read is `failed`; one whose archive is gone or damaged, or whose items
   *   cannot be read, is `unreadable`; one for which the hero or item catalogue cannot be read is
   *   `catalogue_unavailable`. The states are checked in this order: an unreadable archive is
   *   `unreadable` whatever the catalogues.
   * @throws AppError of kind `storage` when the database fails (the projections, the habits, the
   *   detail state), or when the file of the archive cannot be read or the compressor is broken
   *   (neither says anything about the match). A failure of the catalogues never comes out, of
   *   whatever kind and database failures of their cache included: it is the state
   *   `catalogue_unavailable`. Any other error of the rest of the reading is a bug and is not hidden
   *   behind a state.
   */
  async getDamageTab(matchId: MatchId): Promise<DamageTabView> {
    const subject = await analysisSubjectOf(this.#subjectDeps, matchId, 'match');
    if (subject.kind !== 'projected') {
      return { kind: subject.kind };
    }
    const { accountId } = subject;

    // The archive comes before the catalogues: a match that cannot be shown downloads nothing.
    const archive = await this.#reader.readArchive(accountId, matchId);
    if (archive.kind === 'unreadable') {
      // The reader told why; the detail view of the match explains the archive.
      return { kind: 'unreadable' };
    }
    const build = this.#readOrReport(matchId, 'The items of a match could not be read', () =>
      finalBuildOf(readTrackedItems(archive.envelope)),
    );
    if (build === null) {
      return { kind: 'unreadable' };
    }

    const catalogues = await this.#readDamageCatalogues(matchId);
    if (catalogues === null) {
      return { kind: 'catalogue_unavailable' };
    }

    const [values, previous] = await Promise.all([
      this.#metrics.getValues(accountId, matchId),
      // The habits of a source are its shares in the earlier matches of the same hero: the weapon
      // and the melee appear in every one of them, which only holds for the same loadout.
      // `listPrevious` does not filter by hero. It is right today because only Paige matches are
      // archived (`findTrackedPlayer` refuses the others) and so only Paige matches are projected.
      this.#metrics.listPrevious(accountId, matchId, PROJECTION_VERSION, PREVIOUS_LOOKUP),
    ]);
    const breakdown = buildDamageBreakdown({
      current: values,
      previous: previous.map((match) => match.values),
      loadout: catalogues.loadout,
      itemsByClassName: catalogues.items.byClassName,
    });
    return { kind: 'ready', breakdown, build: describeBuild(build, catalogues.items) };
  }

  /**
   * Read the players tab of a match of the linked account, as its archive keeps it: the twelve
   * players by team, their heroes and ranks, Valve's top three, and the places the tracked player
   * takes among them. Nothing is projected and nothing is changed; the only requests this can send
   * are the downloads of the hero and rank catalogues when they are older than a week (or were never
   * downloaded), and only for a match that can be shown.
   *
   * @param matchId - The match.
   * @returns What the tab shows, see {@link PlayersTabView}. A match that is not archived is
   *   `not_archived`; one whose archive is gone or damaged, or whose scoreboard cannot be read, is
   *   `unreadable`. Otherwise the scoreboard, whose hero names and images are `null` where the hero
   *   catalogue does not give them, and whose rank images are `null` where the rank catalogue does
   *   not (see {@link PlayerRowView}).
   * @throws AppError of kind `storage` when the database fails (the account, the detail state), or
   *   when the file of the archive cannot be read or the compressor is broken (neither says anything
   *   about the match). A failure of the catalogues never comes out, of whatever kind and database
   *   failures of their cache included: the names and images are `null`. Any other error of the
   *   reading of the scoreboard is a bug and is not hidden behind a state.
   */
  async getPlayersTab(matchId: MatchId): Promise<PlayersTabView> {
    // Only the archive is needed: no projection, so the tab is there before the analysis has run.
    const accountId = await archivedAccountOf(this.#subjectDeps, matchId);
    if (accountId === null) {
      return { kind: 'not_archived' };
    }

    const archive = await this.#reader.readArchive(accountId, matchId);
    if (archive.kind === 'unreadable') {
      // The reader told why; the detail view of the match explains the archive.
      return { kind: 'unreadable' };
    }
    const scoreboard = this.#readOrReport(
      matchId,
      'The scoreboard of a match could not be read',
      () => readScoreboard(archive.envelope),
    );
    if (scoreboard === null) {
      return { kind: 'unreadable' };
    }

    // The catalogues are read last: a match that cannot be shown downloads nothing for them.
    const catalogues = await this.#readPlayerCatalogues(matchId);
    return {
      kind: 'ready',
      teams: describeTeams(scoreboard, catalogues),
      places: placesOf(scoreboard),
      hasTopThree: scoreboard.players.some((player) => player.mvpRank !== null),
      ranked: scoreboard.ranked,
    };
  }

  /**
   * Read the two catalogues the damage tab names the sources with: the loadout of Paige in the hero
   * catalogue, and the item catalogue. Both come from the cache when it is fresh (and even when it
   * is not, should the download fail); a catalogue is downloaded only when it was never or is no
   * longer cached.
   *
   * @param matchId - The match the tab is read for, for the log line.
   * @returns The loadout and the item catalogue, or `null` when either cannot be read, or when the
   *   hero catalogue gives Paige no loadout (a partial loadout would classify the sources wrongly,
   *   so there is none). One line is logged at `info` level in that case, whatever the number of
   *   catalogues that failed.
   */
  async #readDamageCatalogues(matchId: MatchId): Promise<DamageCatalogues | null> {
    try {
      // Both are asked at once: they share the asset budget, and each shares its run among the
      // calls that overlap, so the page asking twice downloads each catalogue once.
      const [heroes, items] = await Promise.all([
        this.#heroes.getHeroAssets(),
        this.#assets.getItemCatalogue(),
      ]);
      const loadout = heroes.find((hero) => hero.id === PAIGE_HERO_ID)?.loadout ?? null;
      if (loadout !== null) {
        return { loadout, items };
      }
      this.#logger.log('info', LOG_SCOPE, 'The hero catalogue holds no loadout for Paige', {
        matchId,
      });
    } catch (error) {
      // Any failure is a catalogue that cannot be had: offline with nothing cached, a refused
      // request, a spent budget or a pause. The catalogue services logged what a refresh that fell
      // back on the cache could not do; this is the one that has no cache to fall back on.
      this.#logger.log('info', LOG_SCOPE, 'A catalogue of the game could not be read', {
        ...errorLogContext(toAppError(error)),
        matchId,
      });
    }
    return null;
  }

  /**
   * Read the two catalogues the players tab decorates the scoreboard with: the heroes (names and
   * portraits) and the rank tiers (badges). Both come from the cache when it is fresh (and even
   * when it is not, should the download fail); a catalogue is downloaded only when it was never or
   * is no longer cached.
   *
   * Neither is needed to show the scoreboard, so a catalogue that cannot be read is an empty lookup
   * and never an error, whatever the failure was (offline with nothing cached, a refused request, a
   * spent budget, a pause, the cache itself): the other catalogue is still used.
   *
   * @param matchId - The match the tab is read for, for the log line.
   * @returns The lookups, each empty when its catalogue could not be read. One line is logged at
   *   `info` level in that case, whatever the number of catalogues that failed.
   */
  async #readPlayerCatalogues(matchId: MatchId): Promise<PlayerCatalogues> {
    const failures: unknown[] = [];
    const keepFailure = (error: unknown): null => {
      failures.push(error);
      return null;
    };
    // Both are asked at once: they share the asset budget, and each shares its run among the calls
    // that overlap, so the page asking twice downloads each catalogue once.
    const [heroes, ranks] = await Promise.all([
      this.#heroes.getHeroAssets().catch(keepFailure),
      this.#assets.getRankCatalogue().catch(keepFailure),
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
      heroes: new Map((heroes ?? []).map((hero) => [hero.id, hero])),
      ranks: ranks ?? new Map<number, CatalogueRank>(),
    };
  }

  /**
   * Read something out of an archive whose payload may not be what is expected: the build or the
   * scoreboard.
   *
   * @param matchId - The match.
   * @param message - The line to log when the payload is not what is expected: what could not be
   *   read.
   * @param read - Reads it out of the decoded archive of the match.
   * @returns What `read` returns, or `null` when the archive lacks what is read or holds it in a
   *   shape that is not expected: that says something about the archive, not about the match, so it
   *   is reported (once, see `#reports`) and the view is `unreadable`. The match is not changed:
   *   the archive passed the checks of the door when it was written.
   * @throws Error when the reading fails for any other reason: that is a bug, which must be seen as
   *   one.
   */
  #readOrReport<Read>(matchId: MatchId, message: string, read: () => Read): Read | null {
    try {
      return read();
    } catch (error) {
      if (!isAppError(error) || error.kind !== 'invalid_payload') {
        throw error;
      }
      this.#reports.warn(matchId, message, { issue: issueOf(error) });
      return null;
    }
  }
}
