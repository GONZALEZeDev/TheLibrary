/**
 * Tests of the damage and build view and of the players view of the match page
 * (`MatchBreakdownService.getDamageTab` and `getPlayersTab`), end to end on the development
 * adapters: a synchronisation of the synthetic history archives and projects the Paige matches, the
 * catalogues come from the fixture API, and everything is stored in an in-memory database with the
 * real migrations.
 *
 * The synthetic history holds nine archived Paige matches. A test that needs something the
 * fixtures do not give (an archive without a damage matrix, a build of its own, a broken list of
 * items, a match without a top three) edits the archive the synchronisation wrote, and projects the
 * match again when the projection depends on the edit: the match stays archived, exactly like data
 * written by another version of the app would be.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import {
  FIXTURE_EXPRESS_SHOT_ID,
  FIXTURE_ITEM_CATALOGUE,
  FIXTURE_PAIGE_ABILITY_IDS,
  FIXTURE_RANK_CATALOGUE,
} from '../adapters/dev/fixtures/assets.fixture';
import {
  FIXTURE_HERO_CATALOGUE,
  FIXTURE_PAIGE_ITEMS,
} from '../adapters/dev/fixtures/heroes.fixture';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import type { RawItemEntry } from '../adapters/dev/fixtures/match-damage.fixture';
import type { DamageBreakdown, SourceKind } from '../core/analysis/damage-breakdown';
import { DAMAGE_KEY_PREFIXES, damageSourceKey } from '../core/analysis/damage-sources';
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import { PROJECTION_VERSION } from '../core/analysis/registry';
import {
  parseItemCatalogue,
  parseRankCatalogue,
  type CatalogueItem,
  type CatalogueRank,
} from '../core/deadlock-api/assets.schema';
import { heroesRequest, itemsRequest, ranksRequest } from '../core/deadlock-api/endpoints';
import { parseHeroAssets } from '../core/deadlock-api/heroes.schema';
import { PAIGE_HERO_ID, type HeroAsset } from '../core/domain/hero';
import { matchIdSchema, type MatchId } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import { accountFolderName } from '../core/match-detail/archive-layout';
import { RANKED_MATCH_MODE } from '../core/match-detail/detail-status';
import { SCOREBOARD_PLACE_STATS } from '../core/match-detail/scoreboard';
import { finalBuildOf, readTrackedItems } from '../core/match-detail/tracked-items';
import { createTestServices, projectArchivedMatches } from '../test/create-test-services';
import { testMatchId } from '../test/test-data';
import { ArchiveReaderService } from './archive-reader.service';
import { MatchDetailRepository } from './match-detail.repository';
import type { DamageTabView, PlayersTabView } from './match-breakdown.service';
import { MetricsRepository, type ProjectionRecord } from './metrics.repository';

/** The time of the synchronisation that archives the matches (Unix ms); the history ends before. */
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

/** A second, in milliseconds. */
const SECOND_MS = 1_000;

/** The tracked account: the one of the synthetic history. */
const ACCOUNT = FIXTURE_ACCOUNT_ID;

/** How many matches the synthetic history holds; about 40 % of them are Paige matches. */
const HISTORY_COUNT = 30;

/** The fewest archived matches the tests need: a newest one and enough earlier ones for a habit. */
const MIN_ARCHIVED = 6;

/** The scope of the log lines of the service. */
const LOG_SCOPE = 'breakdown';

/** The start of the url of every request for a catalogue of the game. */
const ASSETS_PATH = '/v1/assets/';

/** The prefix of the keys of the damage a source dealt in the stored values of a match. */
const DAMAGE_SOURCE_PREFIX = damageSourceKey('');

/** An item the catalogue does not know, and an ability it does not know either. */
const UNKNOWN_ITEM_ID = 9_999_001;
const UNKNOWN_ABILITY_ID = 9_999_002;

/** A hero the hero catalogue of the fixtures does not hold, and a badge that is no real rank. */
const UNKNOWN_HERO_ID = 9_999_003;
const NOT_A_RANK_BADGE = 47;

/** The item catalogue of the fixtures as the app reads it: the oracle for what a view must show. */
const CATALOGUE: readonly CatalogueItem[] = parseItemCatalogue(FIXTURE_ITEM_CATALOGUE);

/** The hero catalogue of the fixtures as the app reads it: the oracle for the heroes of a player. */
const HEROES: readonly HeroAsset[] = parseHeroAssets(FIXTURE_HERO_CATALOGUE);

/** The rank catalogue of the fixtures as the app reads it: the oracle for the ranks of a player. */
const RANKS: readonly CatalogueRank[] = parseRankCatalogue(FIXTURE_RANK_CATALOGUE);

/** The part of a player of an archive that the tests edit. */
interface EditablePlayer {
  account_id: number;
  /** The items of the player: a list of entries, or anything when a test breaks it. */
  items?: unknown;
  /** The hero of the player. */
  hero_id?: number;
  /**
   * The kills of the player: a count, or anything when a test breaks it. The archive passes the
   * checks of the door with it, which do not read it; the scoreboard does.
   */
  kills?: unknown;
  /** Their place in Valve's top three, or `null`; absent in an older match. */
  mvp_rank?: number | null;
  /** Their rank when the match started, absent in a match that is not ranked. */
  player_rank_data?: { initial_display_rank: number } | null;
}

/** The part of the `match_info` of an archive that the tests edit. */
interface EditableMatchInfo {
  players: EditablePlayer[];
  damage_matrix?: unknown;
}

/** A player of an archive as the API writes it: the fields the players tab shows. */
interface RawPlayer {
  account_id: number;
  player_slot: number;
  team: number;
  hero_id: number;
  kills: number;
  deaths: number;
  assists: number;
  net_worth: number;
  last_hits: number;
  denies: number;
  mvp_rank: number | null;
  player_rank_data: { initial_display_rank: number } | null;
}

/** The `match_info` of an archive as the API writes it, read back to check what a view shows. */
interface RawMatchInfo {
  match_mode: number;
  winning_team: number;
  players: RawPlayer[];
}

/** The part of an archive file that the tests edit. */
interface EditableEnvelope {
  payload: { match_info: EditableMatchInfo };
}

/**
 * The entry of the catalogue that has a class name.
 *
 * @param className - The class name.
 * @returns The entry, or a failure of the test when the fixtures hold none.
 */
function catalogued(className: string): CatalogueItem {
  return (
    CATALOGUE.find((item) => item.className === className) ??
    expect.unreachable(`the fixture catalogue holds ${className}`)
  );
}

/**
 * The id of the shop item that has an English name.
 *
 * @param name - The name.
 * @returns The id, or a failure of the test when the fixtures hold no such item.
 */
function itemIdNamed(name: string): number {
  return (
    CATALOGUE.find((item) => item.name === name)?.id ??
    expect.unreachable(`the fixture catalogue holds ${name}`)
  );
}

/**
 * The fixture API: the history, the details, the catalogues.
 *
 * @returns The handler.
 */
function createApi(): FixtureHandler {
  return createFixtureApi({ now: START, matchCount: HISTORY_COUNT });
}

/**
 * Archive the matches of the synthetic history and build the services like the app does, on the
 * development adapters. The synchronisation downloads and archives the details and projects every
 * match it archived, so each can be read at once; no catalogue is downloaded yet, since only the
 * match page asks for them.
 *
 * @param handler - Answers the requests to deadlock-api; the fixture API by default.
 * @returns The services, the adapters under them, the repositories a test edits the stored data
 *   with, and the archived matches, most recent first.
 */
async function setUp(handler: FixtureHandler = createApi()) {
  const clock = { now: START };
  const test = createTestServices({ handler, now: () => clock.now });
  await test.services.sync.syncNow('startup');
  // The synchronisation projected the matches already: this only makes sure of it.
  await projectArchivedMatches(test, { now: () => clock.now });
  const rows = await test.database.select(
    `SELECT match_id FROM matches WHERE detail_status = 'ready' ORDER BY start_time DESC, match_id DESC`,
  );
  const archived = rows.map((row) => matchIdSchema.parse(row.match_id));
  expect(archived.length, 'the history holds several archived matches').toBeGreaterThanOrEqual(
    MIN_ARCHIVED,
  );
  return {
    ...test,
    clock,
    breakdown: test.services.breakdown,
    metrics: new MetricsRepository(test.database),
    details: new MatchDetailRepository(test.database),
    reader: new ArchiveReaderService({
      archive: test.archiveStore,
      compressor: test.compressor,
      logger: test.logger,
    }),
    archived,
    newest: archived[0] ?? expect.unreachable('the history holds archived matches'),
  };
}

/** Everything {@link setUp} builds. */
type TestContext = Awaited<ReturnType<typeof setUp>>;

/**
 * Like {@link setUp}, with some requests to deadlock-api failing as an offline app's would.
 *
 * @param down - The urls that fail. The set is read at every request, so that a test brings the
 *   network back by emptying it.
 * @returns What {@link setUp} builds.
 */
function setUpWithUrlsDown(down: ReadonlySet<string>): Promise<TestContext> {
  const fixtureApi = createApi();
  return setUp((request) => {
    if (down.has(request.url)) {
      throw new AppError('network', 'The request failed');
    }
    return fixtureApi(request);
  });
}

/**
 * Unwrap the damage tab of a match.
 *
 * @param view - What the service answered.
 * @returns The ready view, or a failure of the test when the tab is in any other state.
 */
function ready(view: DamageTabView) {
  if (view.kind !== 'ready') {
    expect.unreachable(`the damage tab is ${view.kind}, not ready`);
  }
  return view;
}

/**
 * Unwrap the players tab of a match.
 *
 * @param view - What the service answered.
 * @returns The ready view, or a failure of the test when the tab is in any other state.
 */
function readyPlayers(view: PlayersTabView) {
  if (view.kind !== 'ready') {
    expect.unreachable(`the players tab is ${view.kind}, not ready`);
  }
  return view;
}

/**
 * Read the `match_info` of the archive of a match as the API wrote it, to check a view against the
 * raw data and not against the code that reads it.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The match info.
 */
async function rawMatchInfo(context: TestContext, matchId: MatchId): Promise<RawMatchInfo> {
  const read = await context.reader.readArchive(ACCOUNT, matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  return read.envelope.payload.match_info as unknown as RawMatchInfo;
}

/**
 * The tracked player of a raw match info.
 *
 * @param info - The raw match info.
 * @returns The player with the tracked account, or a failure of the test when there is none.
 */
function rawTracked(info: RawMatchInfo): RawPlayer {
  return (
    info.players.find((player) => player.account_id === ACCOUNT) ??
    expect.unreachable('the tracked player is in the match')
  );
}

/**
 * The first archived match that is ranked, or the first that is not.
 *
 * @param context - What {@link setUp} built.
 * @param ranked - Which kind of match to look for.
 * @returns The match, or a failure of the test when the synthetic history holds none.
 */
async function archivedMatchWhere(context: TestContext, ranked: boolean): Promise<MatchId> {
  for (const matchId of context.archived) {
    const info = await rawMatchInfo(context, matchId);
    if ((info.match_mode === RANKED_MATCH_MODE) === ranked) {
      return matchId;
    }
  }
  return expect.unreachable(
    `the history holds an archived ${ranked ? 'ranked' : 'unranked'} match`,
  );
}

/**
 * What the players tab must tell about a hero, according to the hero catalogue of the fixtures: the
 * name and the portrait, or nothing for a hero the catalogue does not hold.
 *
 * @param heroId - The hero of a player.
 * @returns The two fields of a player row.
 */
function expectedHero(heroId: number) {
  const hero = HEROES.find((candidate) => candidate.id === heroId);
  return { heroName: hero?.name ?? null, heroImageUrl: hero?.imageUrl ?? null };
}

/**
 * What the players tab must tell about a rank, according to the rank catalogue of the fixtures: the
 * name of the tier and the sub-rank, and the badge of the tier.
 *
 * @param badge - The rank badge of a player, `null` for a player who has none.
 * @returns The two fields of a player row.
 */
function expectedRank(badge: number | null) {
  if (badge === null) {
    return { rankName: null, rankImageUrl: null };
  }
  const tier =
    RANKS.find((rank) => rank.tier === Math.floor(badge / 10)) ??
    expect.unreachable('the fixture catalogue holds the tier of the badge');
  return { rankName: `${tier.name} ${String(badge % 10)}`, rankImageUrl: tier.imageUrl };
}

/**
 * The first line of a breakdown that has a kind of source.
 *
 * @param breakdown - The breakdown.
 * @param kind - The kind.
 * @returns The line, or a failure of the test when there is none.
 */
function rowOfKind(breakdown: DamageBreakdown, kind: SourceKind) {
  return (
    breakdown.rows.find((row) => row.kind === kind) ??
    expect.unreachable(`the breakdown has a ${kind} line`)
  );
}

/**
 * The urls of the requests for a catalogue of the game received so far, in order.
 *
 * @param context - What {@link setUp} built.
 * @returns The urls.
 */
function assetRequests(context: TestContext): string[] {
  return context.http.requests
    .map((request) => request.url)
    .filter((url) => url.includes(ASSETS_PATH));
}

/**
 * The log lines of the service.
 *
 * @param context - What {@link setUp} built.
 * @returns The lines, in order.
 */
function breakdownLogs(context: TestContext) {
  return context.logger.entries.filter((entry) => entry.scope === LOG_SCOPE);
}

/**
 * Replace some fields of the projection of a match, keeping its values.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param changes - The new fields.
 */
async function overrideProjection(
  context: TestContext,
  matchId: MatchId,
  changes: Partial<ProjectionRecord>,
): Promise<void> {
  const projection =
    (await context.metrics.getProjection(ACCOUNT, matchId)) ??
    expect.unreachable('the match is projected');
  const values = await context.metrics.getValues(ACCOUNT, matchId);
  await context.metrics.saveProjection(ACCOUNT, matchId, { ...projection, ...changes }, values);
}

/**
 * Edit the archive the synchronisation wrote for a match, and write the file again. The match stays
 * recorded as archived and projected.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param edit - Edits the tracked player of the archive and its match info.
 */
async function editArchive(
  context: TestContext,
  matchId: MatchId,
  edit: (tracked: EditablePlayer, matchInfo: EditableMatchInfo) => void,
): Promise<void> {
  const read = await context.reader.readArchive(ACCOUNT, matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  const envelope = JSON.parse(JSON.stringify(read.envelope)) as EditableEnvelope;
  const matchInfo = envelope.payload.match_info;
  edit(
    matchInfo.players.find((player) => player.account_id === ACCOUNT) ??
      expect.unreachable('the tracked player is in the match'),
    matchInfo,
  );
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await context.archiveStore.write(ACCOUNT, matchId, await context.compressor.compress(bytes));
}

/**
 * The items of a tracked player, as a list the test may change.
 *
 * @param tracked - The tracked player of an archive.
 * @returns Their entries.
 */
function itemsOf(tracked: EditablePlayer): RawItemEntry[] {
  const { items } = tracked;
  return Array.isArray(items)
    ? (items as RawItemEntry[])
    : expect.unreachable('the tracked player has a list of items');
}

/**
 * A shop item the player still owned at the end of the match, as the archive writes it.
 *
 * @param itemId - The asset id of the item.
 * @param boughtAtS - When it was bought, in seconds since the start of the match.
 * @param imbuedAbilityId - The ability it was imbued into; none (0) by default.
 * @returns The entry.
 */
function shopEntry(itemId: number, boughtAtS: number, imbuedAbilityId = 0): RawItemEntry {
  return {
    item_id: itemId,
    game_time_s: boughtAtS,
    // 1 is a shop item (0 is the unlock of an ability, 2 and more its upgrades).
    upgrade_id: 1,
    sold_time_s: 0,
    flags: 0,
    imbued_ability_id: imbuedAbilityId,
    // The level mask of an ability: nothing reads it for an item.
    upgrade_info: 0,
  };
}

describe('MatchBreakdownService', () => {
  describe('getDamageTab', () => {
    it('answers pending for a match projected with an older version', async () => {
      const context = await setUp();
      await overrideProjection(context, context.newest, { version: PROJECTION_VERSION - 1 });

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'pending',
      });
      // A match that cannot be shown yet costs nothing: no catalogue is requested for it.
      expect(assetRequests(context)).toEqual([]);
    });

    it('builds the breakdown and the build of an archived match', async () => {
      const context = await setUp();
      const view = ready(await context.breakdown.getDamageTab(context.newest));

      // The breakdown is made of the damage the projection stored...
      const breakdown = view.breakdown ?? expect.unreachable('the match has a damage breakdown');
      const values = await context.metrics.getValues(ACCOUNT, context.newest);
      const stored = [...values].filter(([key]) => key.startsWith(DAMAGE_SOURCE_PREFIX));
      expect(stored.length).toBeGreaterThan(0);
      expect(breakdown.totalDamage).toBe(
        stored.reduce((sum, [, damage]) => sum + (damage ?? 0), 0),
      );
      // ... every source that dealt some is a line, so the shares make the whole.
      expect(breakdown.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 9);
      // The weapon is told by the loadout of Paige and named by the item catalogue.
      const weaponEntry = catalogued(FIXTURE_PAIGE_ITEMS.weapon_primary);
      expect(rowOfKind(breakdown, 'weapon')).toMatchObject({
        className: FIXTURE_PAIGE_ITEMS.weapon_primary,
        itemId: weaponEntry.id,
        name: weaponEntry.name,
        imageUrl: weaponEntry.imageUrl,
        damage: values.get(damageSourceKey(FIXTURE_PAIGE_ITEMS.weapon_primary)),
      });
      expect(rowOfKind(breakdown, 'melee').className).toBe(FIXTURE_PAIGE_ITEMS.weapon_melee);
      expect(rowOfKind(breakdown, 'ability').className).toMatch(/^ability_bookworm_/);

      // The build is the shop items the player ended the match with, named by the same catalogue.
      const read = await context.reader.readArchive(ACCOUNT, context.newest);
      if (read.kind !== 'read') {
        expect.unreachable('the archive of the match is readable');
      }
      const kept = finalBuildOf(readTrackedItems(read.envelope)).map((entry) => entry.itemId);
      expect(kept.length).toBeGreaterThan(0);
      expect(view.build.map((item) => item.itemId).toSorted((a, b) => a - b)).toEqual(
        kept.toSorted((a, b) => a - b),
      );
      for (const item of view.build) {
        const entry =
          CATALOGUE.find((candidate) => candidate.id === item.itemId) ??
          expect.unreachable('the build holds items of the catalogue');
        expect(item).toMatchObject({
          name: entry.name,
          imageUrl: entry.imageUrl,
          slot: entry.slot,
          tier: entry.tier,
        });
      }
    });

    it('builds a breakdown and a build for every archived match', async () => {
      const context = await setUp();

      for (const matchId of context.archived) {
        const view = ready(await context.breakdown.getDamageTab(matchId));

        const breakdown = view.breakdown ?? expect.unreachable('the match has a damage breakdown');
        expect(breakdown.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 9);
        expect(view.build.length).toBeGreaterThan(0);
        // Nothing the view holds is a number that is not one.
        expect(
          [breakdown.totalDamage, ...breakdown.rows.map((row) => row.damage)].every(
            Number.isFinite,
          ),
        ).toBe(true);
      }
    });

    it('compares each source with the earlier matches only', async () => {
      const context = await setUp();

      const newest = ready(await context.breakdown.getDamageTab(context.newest));
      const oldest = ready(
        await context.breakdown.getDamageTab(
          context.archived.at(-1) ?? expect.unreachable('the history holds archived matches'),
        ),
      );

      // The weapon is in every match, so its habit counts every earlier one (up to the window).
      const earlier = context.archived.length - 1;
      expect(
        rowOfKind(newest.breakdown ?? expect.unreachable('no breakdown'), 'weapon').habit,
      ).toMatchObject({ count: Math.min(earlier, PERSONAL_WINDOW) });
      // The first match has no habit to compare with.
      const firstRows = (oldest.breakdown ?? expect.unreachable('no breakdown')).rows;
      expect(firstRows.every((row) => row.habit === null && row.flag === null)).toBe(true);
    });

    it('answers catalogue_unavailable when the item catalogue cannot be read', async () => {
      const fixtureApi = createApi();
      let offline = true;
      const context = await setUp((request) => {
        if (offline && request.url === itemsRequest().url) {
          throw new AppError('network', 'The request failed');
        }
        return fixtureApi(request);
      });

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'catalogue_unavailable',
      });

      // One line for the call, at `info`: a catalogue that is out of reach is no fault of the app.
      const lines = breakdownLogs(context);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'info',
        scope: LOG_SCOPE,
        context: { matchId: context.newest, kind: 'network' },
      });
      expect(JSON.stringify(lines)).not.toContain(String(ACCOUNT));

      // The state is not kept: once the catalogue can be read again, so is the tab. The budget of
      // the catalogue requests (two a second) was spent by the first call.
      offline = false;
      context.clock.now += SECOND_MS;
      expect((await context.breakdown.getDamageTab(context.newest)).kind).toBe('ready');
    });

    it('answers catalogue_unavailable when the hero catalogue cannot be read', async () => {
      const down = new Set([heroesRequest().url]);
      const context = await setUpWithUrlsDown(down);

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'catalogue_unavailable',
      });

      // Without the loadout of Paige, the sources cannot be told apart: one line for the call, at
      // `info`, like a missing item catalogue.
      const lines = breakdownLogs(context);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'info',
        scope: LOG_SCOPE,
        message: 'A catalogue of the game could not be read',
        context: { matchId: context.newest, kind: 'network' },
      });
      expect(JSON.stringify(lines)).not.toContain(String(ACCOUNT));

      // The state is not kept: once the catalogue can be read again, so is the tab. The budget of
      // the catalogue requests (two a second) was spent by the first call.
      down.clear();
      context.clock.now += SECOND_MS;
      expect((await context.breakdown.getDamageTab(context.newest)).kind).toBe('ready');
    });

    it('answers catalogue_unavailable when the hero catalogue gives Paige no loadout', async () => {
      const fixtureApi = createApi();
      // Paige's ultimate is missing: a partial loadout would classify the sources wrongly.
      const heroes = FIXTURE_HERO_CATALOGUE.map((hero) =>
        hero.id === PAIGE_HERO_ID ? { ...hero, items: { ...hero.items, signature4: null } } : hero,
      );
      const context = await setUp((request) =>
        request.url === heroesRequest().url ? jsonResponse(heroes) : fixtureApi(request),
      );

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'catalogue_unavailable',
      });

      expect(breakdownLogs(context)).toEqual([
        {
          level: 'info',
          scope: LOG_SCOPE,
          message: 'The hero catalogue holds no loadout for Paige',
          context: { matchId: context.newest },
        },
      ]);
    });

    it('answers ready with no breakdown for an archive without a damage matrix', async () => {
      const context = await setUp();
      // The detail of some matches comes without a damage matrix: the projection then stores no
      // damage at all, and the match is projected again to say so.
      await editArchive(context, context.newest, (_, matchInfo) => {
        delete matchInfo.damage_matrix;
      });
      await context.database.execute(
        'DELETE FROM match_projections WHERE account_id = $1 AND match_id = $2',
        [ACCOUNT, context.newest],
      );
      await projectArchivedMatches(context, { now: () => context.clock.now });
      const values = await context.metrics.getValues(ACCOUNT, context.newest);
      expect(
        [...values.keys()].filter((key) =>
          DAMAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
        ),
      ).toEqual([]);

      const view = ready(await context.breakdown.getDamageTab(context.newest));

      // No breakdown, but the items are in the archive all the same: the build is shown.
      expect(view.breakdown).toBeNull();
      expect(view.build.length).toBeGreaterThan(0);
    });

    it('shows an unknown build item by its id', async () => {
      const context = await setUp();
      const before = ready(await context.breakdown.getDamageTab(context.newest));
      await editArchive(context, context.newest, (tracked) => {
        itemsOf(tracked).push(shopEntry(UNKNOWN_ITEM_ID, 1_000));
      });

      const view = ready(await context.breakdown.getDamageTab(context.newest));

      // The catalogue knows nothing of it: the page names it by its id. It comes last, after the
      // items that have a slot.
      expect(view.build).toHaveLength(before.build.length + 1);
      expect(view.build.at(-1)).toEqual({
        itemId: UNKNOWN_ITEM_ID,
        name: null,
        imageUrl: null,
        slot: null,
        tier: null,
        boughtAtS: 1_000,
        imbuedInto: null,
      });
    });

    it('sorts the build by slot, tier and time, and names the ability an item is imbued into', async () => {
      const context = await setUp();
      // A build of its own, written out of order: the order of the view is the view's.
      await editArchive(context, context.newest, (tracked) => {
        tracked.items = [
          shopEntry(UNKNOWN_ITEM_ID, 50),
          // Imbued into an ability the catalogue does not know: nothing to name it with.
          shopEntry(itemIdNamed('Trophy Collector'), 100, UNKNOWN_ABILITY_ID),
          shopEntry(itemIdNamed('Heroic Aura'), 200),
          shopEntry(itemIdNamed('Mystic Expansion'), 250, FIXTURE_PAIGE_ABILITY_IDS[0]),
          shopEntry(itemIdNamed('Extra Charge'), 300),
          shopEntry(itemIdNamed('Opening Rounds'), 400),
          shopEntry(FIXTURE_EXPRESS_SHOT_ID, 500),
        ];
      });

      const view = ready(await context.breakdown.getDamageTab(context.newest));

      expect(
        view.build.map(({ name, slot, tier, boughtAtS, imbuedInto }) => ({
          name,
          slot,
          tier,
          boughtAtS,
          imbuedInto,
        })),
      ).toEqual([
        { name: 'Opening Rounds', slot: 'weapon', tier: 2, boughtAtS: 400, imbuedInto: null },
        { name: 'Heroic Aura', slot: 'weapon', tier: 3, boughtAtS: 200, imbuedInto: null },
        { name: 'Express Shot', slot: 'weapon', tier: 3, boughtAtS: 500, imbuedInto: null },
        { name: 'Trophy Collector', slot: 'vitality', tier: 2, boughtAtS: 100, imbuedInto: null },
        {
          name: 'Mystic Expansion',
          slot: 'spirit',
          tier: 1,
          boughtAtS: 250,
          imbuedInto: 'Bookwyrm',
        },
        { name: 'Extra Charge', slot: 'spirit', tier: 1, boughtAtS: 300, imbuedInto: null },
        { name: null, slot: null, tier: null, boughtAtS: 50, imbuedInto: null },
      ]);
    });

    it('sends no request when the catalogues are fresh', async () => {
      const context = await setUp();

      await context.breakdown.getDamageTab(context.newest);
      // The first call downloaded the two catalogues the view needs, once each: the hero
      // catalogue for the loadout and the item catalogue for the names. Not the rank catalogue.
      expect(assetRequests(context).toSorted()).toEqual(
        [heroesRequest().url, itemsRequest().url].toSorted(),
      );
      const sent = context.http.requests.length;

      // The cache holds them for a week: the other tabs, and the other matches, send nothing.
      await context.breakdown.getDamageTab(context.newest);
      for (const matchId of context.archived.slice(1, 3)) {
        await context.breakdown.getDamageTab(matchId);
      }

      expect(context.http.requests).toHaveLength(sent);
    });

    it('is not analysed without an account, and for a match that is not archived', async () => {
      const context = await setUp();
      // Control: the match can be shown until its detail is no longer archived.
      ready(await context.breakdown.getDamageTab(context.newest));
      await context.details.resetToPending(ACCOUNT, context.newest);

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'not_analysed',
      });
      await expect(context.breakdown.getDamageTab(testMatchId(100_000_001))).resolves.toEqual({
        kind: 'not_analysed',
      });
      const { services, http } = createTestServices({ accountId: null });
      await expect(services.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'not_analysed',
      });
      // Nobody is linked: the app contacts nobody.
      expect(http.requests).toEqual([]);
    });

    it('has failed when the projection could not read the match', async () => {
      const context = await setUp();
      await overrideProjection(context, context.newest, { failed: true });

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'failed',
      });
      expect(assetRequests(context)).toEqual([]);
    });

    it('is unreadable, and the match stays as it is, when the archive is gone', async () => {
      const context = await setUp();
      // Delete the files of the archives, as someone emptying the folder would.
      await context.archiveStore.removeEntry(accountFolderName(ACCOUNT));

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'unreadable',
      });

      // A match that cannot be shown downloads nothing: the archive is read before the catalogues.
      expect(assetRequests(context)).toEqual([]);
      // The detail view explains the archive and offers to download it again; this view does not
      // touch the match.
      await expect(context.details.getDetail(ACCOUNT, context.newest)).resolves.toMatchObject({
        status: 'ready',
      });
      await expect(context.metrics.getProjection(ACCOUNT, context.newest)).resolves.toMatchObject({
        version: PROJECTION_VERSION,
        failed: false,
      });
    });

    it('is unreadable, and says so once, when the items of the archive are broken', async () => {
      const context = await setUp();
      await editArchive(context, context.newest, (tracked) => {
        tracked.items = 'not a list';
      });

      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'unreadable',
      });
      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'unreadable',
      });

      // A match that cannot be shown downloads nothing: its items are read before the catalogues.
      expect(assetRequests(context)).toEqual([]);
      // One warning for the match, with the place and the kind of the problem, never a value.
      const lines = breakdownLogs(context);
      expect(lines).toEqual([
        {
          level: 'warn',
          scope: LOG_SCOPE,
          message: 'The items of a match could not be read',
          context: {
            matchId: context.newest,
            issue: expect.stringMatching(/^players\.\d+\.items: \w+$/) as unknown,
          },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(String(ACCOUNT));
      // The projection and the detail are not touched: the archive is only unreadable here.
      await expect(context.details.getDetail(ACCOUNT, context.newest)).resolves.toMatchObject({
        status: 'ready',
      });
    });

    it('rejects with the error of the disk when the archive cannot be read', async () => {
      const context = await setUp();
      vi.spyOn(context.archiveStore, 'read').mockRejectedValue(new Error('Access is denied'));

      // A disk that fails says nothing about the match: no state is made up for it.
      await expect(context.breakdown.getDamageTab(context.newest)).rejects.toMatchObject({
        kind: 'storage',
      });
    });

    it('is unreadable rather than catalogue_unavailable when neither the archive nor a catalogue can be read', async () => {
      const context = await setUpWithUrlsDown(new Set([heroesRequest().url, itemsRequest().url]));
      await context.archiveStore.removeEntry(accountFolderName(ACCOUNT));

      // The archive is read first: the state is the archive's, and no catalogue is asked for.
      await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
        kind: 'unreadable',
      });
      expect(assetRequests(context)).toEqual([]);
      expect(breakdownLogs(context)).toEqual([]);
    });
  });

  describe('getPlayersTab', () => {
    it("lists the two teams, the tracked player's first, with heroes and ranks", async () => {
      const context = await setUp();
      const trackedTeams = new Set<number>();
      let rankedRows = 0;

      // Every archived match: a different slot for the tracked player, a different team.
      for (const matchId of context.archived) {
        const info = await rawMatchInfo(context, matchId);
        const tracked = rawTracked(info);
        trackedTeams.add(tracked.team);
        const ranked = info.match_mode === RANKED_MATCH_MODE;
        const view = readyPlayers(await context.breakdown.getPlayersTab(matchId));

        // The tracked player's team comes first, then the other.
        const teamIds = [...new Set(info.players.map((player) => player.team))];
        expect(view.teams.map((team) => team.team)).toEqual([
          tracked.team,
          ...teamIds.filter((team) => team !== tracked.team).toSorted((a, b) => a - b),
        ]);
        for (const team of view.teams) {
          // Six players by team, by slot whatever the order of the archive, and the winners flagged.
          const raws = info.players
            .filter((player) => player.team === team.team)
            .toSorted((first, second) => first.player_slot - second.player_slot);
          expect(team.won).toBe(team.team === info.winning_team);
          expect(team.players).toHaveLength(6);
          expect(team.players).toMatchObject(
            raws.map((raw) => {
              const badge = ranked ? (raw.player_rank_data?.initial_display_rank ?? null) : null;
              return {
                slot: raw.player_slot,
                team: raw.team,
                heroId: raw.hero_id,
                kills: raw.kills,
                deaths: raw.deaths,
                assists: raw.assists,
                netWorth: raw.net_worth,
                lastHits: raw.last_hits,
                denies: raw.denies,
                mvpRank: raw.mvp_rank,
                badge,
                isTracked: raw.account_id === ACCOUNT,
                ...expectedHero(raw.hero_id),
                ...expectedRank(badge),
              };
            }),
          );
          rankedRows += team.players.filter((player) => player.rankName !== null).length;
        }

        // The tracked player is on one row only: Paige, named by the hero catalogue.
        const trackedRows = view.teams.flatMap((team) => team.players).filter((p) => p.isTracked);
        expect(trackedRows).toHaveLength(1);
        expect(trackedRows[0]).toMatchObject({ heroId: PAIGE_HERO_ID, heroName: 'Paige' });
        expect(trackedRows[0]?.heroImageUrl).not.toBeNull();
        // The other players of the match are people: nothing on a row says who they are, neither
        // by name nor by value.
        const text = JSON.stringify(view);
        expect(text).not.toMatch(/account/i);
        for (const raw of info.players) {
          expect(text).not.toContain(String(raw.account_id));
        }
      }

      // The order above is the tracked team's, not the lowest number's: both teams were tracked.
      expect(trackedTeams.size).toBe(2);
      // The ranks of the ranked matches are there to be checked.
      expect(rankedRows).toBeGreaterThan(0);
    });

    it('shows no rank in an unranked match', async () => {
      const context = await setUp();
      const unranked = await archivedMatchWhere(context, false);

      const view = readyPlayers(await context.breakdown.getPlayersTab(unranked));

      const players = view.teams.flatMap((team) => team.players);
      expect(view.ranked).toBe(false);
      expect(players).toHaveLength(12);
      expect(
        players.every(
          (player) =>
            player.badge === null && player.rankName === null && player.rankImageUrl === null,
        ),
      ).toBe(true);

      // Control: in a ranked match every player has a rank, with the badge of its tier.
      const rankedView = readyPlayers(
        await context.breakdown.getPlayersTab(await archivedMatchWhere(context, true)),
      );
      expect(rankedView.ranked).toBe(true);
      expect(
        rankedView.teams
          .flatMap((team) => team.players)
          .every((player) => player.rankName !== null && player.rankImageUrl !== null),
      ).toBe(true);
    });

    it('places the tracked player among the players', async () => {
      const context = await setUp();

      for (const matchId of context.archived) {
        const info = await rawMatchInfo(context, matchId);
        const tracked = rawTracked(info);
        const view = readyPlayers(await context.breakdown.getPlayersTab(matchId));

        // Every figure of the scoreboard is placed, in the order the page shows them...
        expect(view.places.map((place) => place.stat)).toEqual([...SCOREBOARD_PLACE_STATS]);
        // ... and the souls and the last hits are placed among the twelve players of the archive.
        for (const [stat, field] of [
          ['netWorth', 'net_worth'],
          ['lastHits', 'last_hits'],
        ] as const) {
          const values = info.players.map((player) => player[field]);
          const own = tracked[field];
          const mean = values.reduce((total, value) => total + value, 0) / values.length;
          const place =
            view.places.find((candidate) => candidate.stat === stat) ??
            expect.unreachable(`the tracked player is placed on ${stat}`);
          expect(place).toMatchObject({
            place: 1 + values.filter((value) => value > own).length,
            of: 12,
          });
          expect(place.gapToMean).toBeCloseTo((own - mean) / mean, 9);
        }
      }
    });

    it('says when the match has no top three', async () => {
      const context = await setUp();
      const [, withNulls, withoutField] = context.archived;
      if (withNulls === undefined || withoutField === undefined) {
        expect.unreachable('the history holds several archived matches');
      }

      // Control: Valve's top three is on the rows of an ordinary match.
      const control = readyPlayers(await context.breakdown.getPlayersTab(context.newest));
      expect(control.hasTopThree).toBe(true);
      expect(
        control.teams
          .flatMap((team) => team.players)
          .flatMap((player) => (player.mvpRank === null ? [] : [player.mvpRank]))
          .toSorted((a, b) => a - b),
      ).toEqual([1, 2, 3]);

      // A match whose players are all out of the top three, and an older one without the field.
      await editArchive(context, withNulls, (_, matchInfo) => {
        for (const player of matchInfo.players) {
          player.mvp_rank = null;
        }
      });
      await editArchive(context, withoutField, (_, matchInfo) => {
        for (const player of matchInfo.players) {
          delete player.mvp_rank;
        }
      });

      for (const matchId of [withNulls, withoutField]) {
        const view = readyPlayers(await context.breakdown.getPlayersTab(matchId));
        expect(view.hasTopThree).toBe(false);
        expect(
          view.teams.flatMap((team) => team.players).every((player) => player.mvpRank === null),
        ).toBe(true);
      }
    });

    it('works without the catalogues', async () => {
      const down = new Set([heroesRequest().url, ranksRequest().url]);
      const context = await setUpWithUrlsDown(down);
      const ranked = await archivedMatchWhere(context, true);

      const view = readyPlayers(await context.breakdown.getPlayersTab(ranked));

      // No hero is named nor shown and no badge is drawn: the page falls back on the hero's id...
      const players = view.teams.flatMap((team) => team.players);
      expect(players).toHaveLength(12);
      expect(
        players.every(
          (player) =>
            player.heroName === null &&
            player.heroImageUrl === null &&
            player.rankImageUrl === null,
        ),
      ).toBe(true);
      // ... but the scoreboard is the archive's, and so are the names of the ranks.
      const info = await rawMatchInfo(context, ranked);
      expect(players.map((player) => player.heroId).toSorted((a, b) => a - b)).toEqual(
        info.players.map((player) => player.hero_id).toSorted((a, b) => a - b),
      );
      expect(players.every((player) => player.rankName !== null)).toBe(true);
      expect(view.places.length).toBeGreaterThan(0);

      // One line for the call, at `info`, however many catalogues failed: no fault of the app.
      const lines = breakdownLogs(context);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'info',
        scope: LOG_SCOPE,
        context: { matchId: ranked, kind: 'network' },
      });
      expect(JSON.stringify(lines)).not.toContain(String(ACCOUNT));

      // The state is not kept: once the catalogues can be read again, so are the names and badges.
      // The budget of the catalogue requests (two a second) was spent by the first call.
      down.clear();
      context.clock.now += SECOND_MS;
      const later = readyPlayers(await context.breakdown.getPlayersTab(ranked));
      expect(
        later.teams
          .flatMap((team) => team.players)
          .every((player) => player.heroName !== null && player.rankImageUrl !== null),
      ).toBe(true);
    });

    it('keeps what a catalogue gives when the other one cannot be read', async () => {
      // The heroes are out of reach: the ranks are still drawn.
      const withoutHeroes = await setUpWithUrlsDown(new Set([heroesRequest().url]));
      const ranked = await archivedMatchWhere(withoutHeroes, true);
      const noHeroes = readyPlayers(await withoutHeroes.breakdown.getPlayersTab(ranked));
      const noHeroRows = noHeroes.teams.flatMap((team) => team.players);
      expect(noHeroRows.every((player) => player.heroName === null)).toBe(true);
      expect(noHeroRows.every((player) => player.rankImageUrl !== null)).toBe(true);
      expect(breakdownLogs(withoutHeroes)).toHaveLength(1);

      // The ranks are out of reach: the heroes are still named and shown.
      const withoutRanks = await setUpWithUrlsDown(new Set([ranksRequest().url]));
      const noRanks = readyPlayers(await withoutRanks.breakdown.getPlayersTab(ranked));
      const noRankRows = noRanks.teams.flatMap((team) => team.players);
      expect(noRankRows.every((player) => player.rankImageUrl === null)).toBe(true);
      expect(noRankRows.every((player) => player.rankName !== null)).toBe(true);
      expect(noRankRows.every((player) => player.heroName !== null)).toBe(true);
      expect(breakdownLogs(withoutRanks)).toHaveLength(1);
    });

    it('names no hero the catalogue does not know, and no rank that is not one', async () => {
      const context = await setUp();
      const ranked = await archivedMatchWhere(context, true);
      await editArchive(context, ranked, (_, matchInfo) => {
        const [anUnknownHero, aBrokenRank] = matchInfo.players.filter(
          (player) => player.account_id !== ACCOUNT,
        );
        if (anUnknownHero === undefined || aBrokenRank === undefined) {
          expect.unreachable('the match has other players than the tracked one');
        }
        anUnknownHero.hero_id = UNKNOWN_HERO_ID;
        // A badge whose sub-rank (7) is not one the game gives: it has no name and no image.
        aBrokenRank.player_rank_data = { initial_display_rank: NOT_A_RANK_BADGE };
      });

      const view = readyPlayers(await context.breakdown.getPlayersTab(ranked));

      const players = view.teams.flatMap((team) => team.players);
      expect(players.find((player) => player.heroId === UNKNOWN_HERO_ID)).toMatchObject({
        heroName: null,
        heroImageUrl: null,
      });
      expect(players.find((player) => player.badge === NOT_A_RANK_BADGE)).toMatchObject({
        rankName: null,
        rankImageUrl: null,
      });
      // Everybody else is named as usual.
      expect(players.filter((player) => player.heroName === null)).toHaveLength(1);
      expect(players.filter((player) => player.rankName === null)).toHaveLength(1);
    });

    it('is not archived without an account, and for a match that is not archived', async () => {
      const context = await setUp();
      // Control: the match can be shown until its detail is no longer archived.
      readyPlayers(await context.breakdown.getPlayersTab(context.newest));
      await context.details.resetToPending(ACCOUNT, context.newest);
      const sent = context.http.requests.length;

      await expect(context.breakdown.getPlayersTab(context.newest)).resolves.toEqual({
        kind: 'not_archived',
      });
      await expect(context.breakdown.getPlayersTab(testMatchId(100_000_001))).resolves.toEqual({
        kind: 'not_archived',
      });
      const { services, http } = createTestServices({ accountId: null });
      await expect(services.breakdown.getPlayersTab(context.newest)).resolves.toEqual({
        kind: 'not_archived',
      });
      // A match that cannot be shown costs nothing, and nobody is contacted without an account.
      expect(context.http.requests).toHaveLength(sent);
      expect(http.requests).toEqual([]);
    });

    it('is unreadable, and the match stays as it is, when the archive is damaged', async () => {
      const context = await setUp();
      // Bytes that are no archive, as a disk that lost its data would leave.
      await context.archiveStore.write(
        ACCOUNT,
        context.newest,
        new TextEncoder().encode('this is not an archive'),
      );

      await expect(context.breakdown.getPlayersTab(context.newest)).resolves.toEqual({
        kind: 'unreadable',
      });

      // The detail view explains the archive and offers to download it again; this view does not
      // touch the match, and asks for no catalogue for a page it cannot fill.
      await expect(context.details.getDetail(ACCOUNT, context.newest)).resolves.toMatchObject({
        status: 'ready',
      });
      await expect(context.metrics.getProjection(ACCOUNT, context.newest)).resolves.toMatchObject({
        version: PROJECTION_VERSION,
        failed: false,
      });
      expect(assetRequests(context)).toEqual([]);
    });

    it('is unreadable, and says so once, when the scoreboard of the archive is broken', async () => {
      const context = await setUp();
      await editArchive(context, context.newest, (_, matchInfo) => {
        for (const player of matchInfo.players) {
          player.kills = 'not a count';
        }
      });

      await expect(context.breakdown.getPlayersTab(context.newest)).resolves.toEqual({
        kind: 'unreadable',
      });
      await expect(context.breakdown.getPlayersTab(context.newest)).resolves.toEqual({
        kind: 'unreadable',
      });

      // One warning for the match, with the place and the kind of the problem, never a value.
      const lines = breakdownLogs(context);
      expect(lines).toEqual([
        {
          level: 'warn',
          scope: LOG_SCOPE,
          message: 'The scoreboard of a match could not be read',
          context: {
            matchId: context.newest,
            issue: expect.stringMatching(/^players\.\d+\.kills: \w+$/) as unknown,
          },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(String(ACCOUNT));
      expect(JSON.stringify(lines)).not.toContain('not a count');
      // An archive that passed the checks of the door is not reset for a field this view dislikes.
      await expect(context.details.getDetail(ACCOUNT, context.newest)).resolves.toMatchObject({
        status: 'ready',
      });
      expect(assetRequests(context)).toEqual([]);
    });

    it('reports each problem of a match once, whichever tab finds it', async () => {
      const context = await setUp();
      await editArchive(context, context.newest, (tracked, matchInfo) => {
        tracked.items = 'not a list';
        for (const player of matchInfo.players) {
          player.kills = 'not a count';
        }
      });

      // The damage tab finds the items first; the players tab must still report the scoreboard.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(context.breakdown.getDamageTab(context.newest)).resolves.toEqual({
          kind: 'unreadable',
        });
        await expect(context.breakdown.getPlayersTab(context.newest)).resolves.toEqual({
          kind: 'unreadable',
        });
      }

      expect(breakdownLogs(context).map((line) => line.message)).toEqual([
        'The items of a match could not be read',
        'The scoreboard of a match could not be read',
      ]);
    });

    it('rejects with the error of the disk when the archive cannot be read', async () => {
      const context = await setUp();
      vi.spyOn(context.archiveStore, 'read').mockRejectedValue(new Error('Access is denied'));

      // A disk that fails says nothing about the match: no state is made up for it.
      await expect(context.breakdown.getPlayersTab(context.newest)).rejects.toMatchObject({
        kind: 'storage',
      });
    });
  });
});
