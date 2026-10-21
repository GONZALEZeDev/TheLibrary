/**
 * The breakdown of a match: the views of the match page that read what the analysis of its metrics
 * (`./analysis.service`) leaves aside. Each view has its own method and its own part of this file.
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
 * (the states below) is decided by `./analysis-subject`, the gate the analysis shares: the two
 * views of a match tell the same states the same way. Nothing is projected, nothing is downloaded
 * for a match that is not `projected`, and the view never changes the match.
 *
 * What the damage tab can be told about a match (`DamageTabView`):
 * - `not_analysed`: there is nothing to show. No account is linked, or the detail of the match is
 *   not archived;
 * - `pending`: the match is archived but the projection has not run on it yet, or ran with an older
 *   version of the metrics. The analysis of the match projects it (`AnalysisService.analyseMatch`);
 * - `failed`: the projection could not read the match;
 * - `unreadable`: the archive of the match is gone or damaged, or its items cannot be read. The
 *   detail view of the match explains the archive; this view only has nothing to show, and does not
 *   reset the match;
 * - `catalogue_unavailable`: the loadout of Paige or the item catalogue could not be read, and
 *   there is none cached (offline for good, a request refused). Without them the sources cannot be
 *   told apart nor named, and no half-named table is shown instead;
 * - `ready`: the breakdown, which is `null` when the match has no damage to show (no damage matrix
 *   in the archive, or no damage dealt to heroes), and the build.
 *
 * **The players view** ({@link MatchBreakdownService.getPlayersTab}) is the scoreboard of the match:
 * its twelve players by team, with their hero, their rank and their place in Valve's top three, and
 * the places the tracked player takes among them. It reads the archive of the match
 * (`./archive-reader.service`, `../core/match-detail/scoreboard`) and nothing else of the match: it
 * needs no projection, so it does not go through `./analysis-subject` and is shown whether or not
 * the analysis has run. The hero and rank catalogues (`./hero-catalog.service`,
 * `./game-asset.service`) only decorate it: without them the players are shown by the id of their
 * hero and without the badge of their rank, and no state says so.
 *
 * What the players tab can be told about a match (`PlayersTabView`):
 * - `not_archived`: there is nothing to show. No account is linked, or the detail of the match is
 *   not archived;
 * - `unreadable`: the archive of the match is gone or damaged, or its scoreboard cannot be read.
 *   Like the damage tab, this view only has nothing to show and does not reset the match;
 * - `ready`: the teams (the tracked player's first), the places of the tracked player, and whether
 *   the match has a top three and is ranked.
 *
 * Nothing is logged on the normal path. Two kinds of lines are written, never with an account id or
 * a value of the payload or of a catalogue: one at `info` level each time a catalogue cannot be read
 * (it is the state of the network, not a fault; once per call, however many catalogues failed), and
 * one warning per match and per problem whose items or scoreboard cannot be read, with the field
 * path and the issue code of the payload only.
 *
 * @packageDocumentation
 */
import {
  buildDamageBreakdown,
  readableSourceName,
  type DamageBreakdown,
} from '../core/analysis/damage-breakdown';
import { PREVIOUS_LOOKUP } from '../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import {
  ITEM_SLOTS,
  MAX_ITEM_TIER,
  type CatalogueItem,
  type CatalogueRank,
  type ItemSlot,
} from '../core/deadlock-api/assets.schema';
import { PAIGE_HERO_ID, type HeroAsset, type HeroLoadout } from '../core/domain/hero';
import type { MatchId } from '../core/domain/match';
import { badgeParts, rankName } from '../core/domain/rank';
import { errorLogContext, isAppError, toAppError } from '../core/errors/app-error';
import {
  placesOf,
  readScoreboard,
  type ScoreboardPlayer,
  type ScoreboardRead,
  type StatPlace,
} from '../core/match-detail/scoreboard';
import {
  finalBuildOf,
  readTrackedItems,
  type FinalBuildEntry,
} from '../core/match-detail/tracked-items';
import type { AccountSource } from '../ports/account-source.port';
import type { LogContext, Logger } from '../ports/logger.port';
import { analysisSubjectOf, type AnalysisSubjectDependencies } from './analysis-subject';
import type { ArchiveReaderService } from './archive-reader.service';
import type { GameAssetService, ItemCatalogue } from './game-asset.service';
import type { HeroCatalogService } from './hero-catalog.service';
import type { MatchDetailRepository } from './match-detail.repository';
import type { MetricsRepository } from './metrics.repository';

/**
 * One item of the build a player ended the match with, named and shown by the item catalogue.
 *
 * An item the catalogue does not know (the game added it after the catalogue was cached, say) keeps
 * `null` for everything the catalogue tells, and the page shows it by its id.
 */
export interface BuildItemView {
  /** The asset id of the item. */
  readonly itemId: number;
  /**
   * The English name: the catalogue's, or its class name made readable when the catalogue has the
   * item but no name for it; `null` when the catalogue does not know the item.
   */
  readonly name: string | null;
  /** The image of the item on the asset bucket, or `null` when it has none or is unknown. */
  readonly imageUrl: string | null;
  /** The slot of the item in the shop, or `null` when it is unknown. */
  readonly slot: ItemSlot | null;
  /** The tier of the item, 1 to 5, or `null` when it is unknown. */
  readonly tier: number | null;
  /** When the item was bought, in seconds since the start of the match. */
  readonly boughtAtS: number;
  /**
   * The English name of the ability the item was imbued into, or `null` when it was not imbued or
   * when the catalogue does not know the ability.
   */
  readonly imbuedInto: string | null;
}

/**
 * What the damage and build tab of the match page shows: a state that says there is nothing to show
 * (see the header of this file), or the damage breakdown and the final build.
 */
export type DamageTabView =
  | { readonly kind: 'not_analysed' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'catalogue_unavailable' }
  | {
      readonly kind: 'ready';
      /** The damage by source, or `null` when the match has no damage to show. */
      readonly breakdown: DamageBreakdown | null;
      /** The items the player ended the match with, in the order the page lists them. */
      readonly build: readonly BuildItemView[];
    };

/**
 * One row of the players tab: a player of the scoreboard, with what the catalogues tell about their
 * hero and their rank.
 *
 * The names are the English ones whatever the language of the interface. A hero the hero catalogue
 * does not know (or the whole catalogue, when it cannot be read) leaves `heroName` and
 * `heroImageUrl` `null`: the page shows the hero by its id. The name of the rank comes from the
 * badge alone, so it is there without the rank catalogue; only the image of the tier needs it.
 */
export interface PlayerRowView extends ScoreboardPlayer {
  /** `true` for the player the account is about: the page marks their row. */
  readonly isTracked: boolean;
  /** The English name of their hero, or `null` when the hero catalogue does not give it. */
  readonly heroName: string | null;
  /** The portrait of their hero on the asset bucket, or `null` when the catalogue has none. */
  readonly heroImageUrl: string | null;
  /**
   * Their rank as the game writes it (`Sentinel 4`), or `null` when they have none to show: the
   * match is not ranked, they have no rank yet, or their badge is no real rank.
   */
  readonly rankName: string | null;
  /**
   * The badge of the tier of their rank on the asset bucket, or `null` when they have no rank to
   * show or the rank catalogue does not give the badge.
   */
  readonly rankImageUrl: string | null;
}

/** One team of the players tab. */
export interface TeamView {
  /** The team, as numbered by the API. */
  readonly team: number;
  /** `true` for the team that won the match. */
  readonly won: boolean;
  /** Its players, by slot. */
  readonly players: readonly PlayerRowView[];
}

/**
 * What the players tab of the match page shows: a state that says there is nothing to show (see the
 * header of this file), or the scoreboard.
 */
export type PlayersTabView =
  | { readonly kind: 'not_archived' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'ready';
      /** The teams of the match, the tracked player's first. */
      readonly teams: readonly TeamView[];
      /** The places of the tracked player among the players, see `placesOf`. */
      readonly places: readonly StatPlace[];
      /** `true` when some player is in Valve's top three; an older match has none. */
      readonly hasTopThree: boolean;
      /** `true` for a ranked match: the only one whose players have a rank to show. */
      readonly ranked: boolean;
    };

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

/**
 * The name to show for an entry of the item catalogue: its English name, or, for the few entries
 * the catalogue has no name for, its class name made readable (as the damage lines do).
 *
 * @param item - The entry.
 * @returns The name.
 */
function nameOf(item: CatalogueItem): string {
  return item.name ?? readableSourceName(item.className);
}

/**
 * The place of a slot in the list of the build: weapon, vitality, spirit, then no slot.
 *
 * @param slot - The slot of an item, `null` when it has none.
 * @returns The rank, from 0.
 */
function slotRank(slot: ItemSlot | null): number {
  return slot === null ? ITEM_SLOTS.length : ITEM_SLOTS.indexOf(slot);
}

/**
 * Order two items of the build: by slot, then by tier (the lowest first, an item without a tier
 * last), then by the time they were bought, then by id so that the order never depends on the
 * input's.
 *
 * @param first - An item.
 * @param second - Another item.
 * @returns A negative number when `first` comes first, a positive one when `second` does.
 */
function byBuildOrder(first: BuildItemView, second: BuildItemView): number {
  // A number past the highest tier, rather than infinity: `Infinity - Infinity` is `NaN`, which
  // would end the comparison instead of passing on to the next criterion.
  const noTier = MAX_ITEM_TIER + 1;
  return (
    slotRank(first.slot) - slotRank(second.slot) ||
    (first.tier ?? noTier) - (second.tier ?? noTier) ||
    first.boughtAtS - second.boughtAtS ||
    first.itemId - second.itemId
  );
}

/**
 * Describe the items of a final build with the item catalogue.
 *
 * @param entries - The items the player ended the match with.
 * @param catalogue - The item catalogue, to look the items and the abilities they were imbued into
 *   up by id.
 * @returns The items in the order the page lists them (see {@link byBuildOrder}).
 */
function describeBuild(
  entries: readonly FinalBuildEntry[],
  catalogue: ItemCatalogue,
): readonly BuildItemView[] {
  return entries
    .map((entry): BuildItemView => {
      const item = catalogue.byId.get(entry.itemId);
      const ability =
        entry.imbuedAbilityId === null ? undefined : catalogue.byId.get(entry.imbuedAbilityId);
      return {
        itemId: entry.itemId,
        name: item === undefined ? null : nameOf(item),
        imageUrl: item?.imageUrl ?? null,
        slot: item?.slot ?? null,
        tier: item?.tier ?? null,
        boughtAtS: entry.boughtAtS,
        imbuedInto: ability === undefined ? null : nameOf(ability),
      };
    })
    .toSorted(byBuildOrder);
}

/**
 * What the players view takes from the catalogues. Both only decorate the scoreboard, so each is a
 * lookup that may be empty: a catalogue that could not be read has no entry for anybody.
 */
interface PlayerCatalogues {
  /** The playable heroes by id: their names and portraits. */
  readonly heroes: ReadonlyMap<number, HeroAsset>;
  /** The rank tiers by tier number: the badge of each. */
  readonly ranks: ReadonlyMap<number, CatalogueRank>;
}

/**
 * Describe a player of the scoreboard with the catalogues.
 *
 * @param player - The player.
 * @param trackedSlot - The slot of the tracked player.
 * @param catalogues - The hero and rank catalogues, which may be empty.
 * @returns The row of the player. A badge that is no real rank (a sub-rank the game never gives) has
 *   neither a name nor an image, like a player who has no badge.
 */
function describePlayer(
  player: ScoreboardPlayer,
  trackedSlot: number,
  catalogues: PlayerCatalogues,
): PlayerRowView {
  const hero = catalogues.heroes.get(player.heroId);
  const parts = player.badge === null ? null : badgeParts(player.badge);
  return {
    ...player,
    isTracked: player.slot === trackedSlot,
    heroName: hero?.name ?? null,
    heroImageUrl: hero?.imageUrl ?? null,
    rankName: player.badge === null ? null : rankName(player.badge),
    rankImageUrl: parts === null ? null : (catalogues.ranks.get(parts.tier)?.imageUrl ?? null),
  };
}

/**
 * Split the players of a scoreboard into their teams.
 *
 * @param read - The scoreboard, whose players are sorted by slot.
 * @param catalogues - The hero and rank catalogues, which may be empty.
 * @returns The teams, the tracked player's first and the others by team number; the players of a
 *   team are in the order of their slots.
 */
function describeTeams(read: ScoreboardRead, catalogues: PlayerCatalogues): readonly TeamView[] {
  const rows = read.players.map((player) => describePlayer(player, read.trackedSlot, catalogues));
  const trackedTeam = rows.find((row) => row.isTracked)?.team;
  const teams = [...new Set(rows.map((row) => row.team))].toSorted(
    // The tracked player's team sorts before the others, which sort by their number.
    (first, second) =>
      Number(second === trackedTeam) - Number(first === trackedTeam) || first - second,
  );
  return teams.map((team) => ({
    team,
    won: team === read.winningTeam,
    players: rows.filter((row) => row.team === team),
  }));
}

/** Tells what the match page shows besides the analysis of a match, from its projection and archive. */
export class MatchBreakdownService {
  /** What {@link analysisSubjectOf} reads to find where a match stands (the gate the analysis shares). */
  readonly #subjectDeps: AnalysisSubjectDependencies;
  readonly #accountSource: AccountSource;
  readonly #details: MatchDetailRepository;
  readonly #metrics: MetricsRepository;
  readonly #reader: ArchiveReaderService;
  readonly #heroes: HeroCatalogService;
  readonly #assets: GameAssetService;
  readonly #logger: Logger;

  /**
   * The problems already reported, each by the match and the message of the line. A match whose
   * items or scoreboard cannot be read stays so until its archive is written again, and the page
   * reads the views every time it is shown: a problem is reported once, not at every read. The two
   * problems of one match are two reports: finding one must not hide the other.
   */
  readonly #reported = new Set<string>();

  /**
   * @param dependencies - See {@link MatchBreakdownServiceDependencies}.
   */
  constructor(dependencies: MatchBreakdownServiceDependencies) {
    this.#subjectDeps = {
      accountSource: dependencies.accountSource,
      details: dependencies.details,
      metrics: dependencies.metrics,
    };
    this.#accountSource = dependencies.accountSource;
    this.#details = dependencies.details;
    this.#metrics = dependencies.metrics;
    this.#reader = dependencies.reader;
    this.#heroes = dependencies.heroes;
    this.#assets = dependencies.assets;
    this.#logger = dependencies.logger;
  }

  /**
   * Read the damage and build tab of a match of the linked account, as it is stored: the damage the
   * player dealt with each source, compared with their habits, and the items they ended the match
   * with. Nothing is projected and nothing is changed; the only request this can send is the
   * download of a catalogue that is older than a week (or that was never downloaded), and only for a
   * match that can be shown.
   *
   * @param matchId - The match.
   * @returns What the tab shows, see {@link DamageTabView}. A match that is not archived is
   *   `not_analysed`; one without a projection of the current version is `pending`; one the
   *   projection could not read is `failed`; one whose archive is gone or damaged is `unreadable`;
   *   one for which the hero or item catalogue cannot be read is `catalogue_unavailable`.
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
    const accountId = await this.#accountSource.currentAccountId();
    if (accountId === null) {
      return { kind: 'not_archived' };
    }
    const detail = await this.#details.getDetail(accountId, matchId);
    if (detail?.status !== 'ready') {
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
   *   is reported (once, see `#reportOnce`) and the view is `unreadable`. The match is not changed:
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
      this.#reportOnce(matchId, message, {
        issue: typeof error.context.issue === 'string' ? error.context.issue : 'unknown',
      });
      return null;
    }
  }

  /**
   * Log a warning about a match, unless that problem of that match was already reported. A line
   * holds the match and what the caller adds, which is a field path and an issue code at most: never
   * a value of the payload.
   *
   * @param matchId - The match.
   * @param message - What is wrong with the match. It also tells the problem from another of the
   *   same match.
   * @param details - Context besides the match: the path and the issue code of a payload problem.
   */
  #reportOnce(matchId: MatchId, message: string, details: LogContext): void {
    const problem = `${String(matchId)} ${message}`;
    if (this.#reported.has(problem)) {
      return;
    }
    this.#reported.add(problem);
    this.#logger.log('warn', LOG_SCOPE, message, { matchId, ...details });
  }
}
