/**
 * Tests of the timeline tab of the match page (`MatchTimelineService.getTimelineTab`), end to end
 * on the development adapters: a synchronisation of the synthetic history archives the Paige
 * matches, the catalogues come from the fixture API, and everything is stored in an in-memory
 * database with the real migrations.
 *
 * What a view must show is checked against the archive as the API wrote it wherever the rule is a
 * plain reading (the souls, the killers, the kills, the purchases), and against the core functions
 * that own a rule otherwise (the players near a death, the mean souls of the lane opponents). A test
 * that needs something the fixtures do not give (a death to troopers, an archive of the first
 * format, a broken death detail) edits the archive the synchronisation wrote: the match stays
 * archived, exactly like data written by another version of the app would be.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_ITEM_CATALOGUE } from '../adapters/dev/fixtures/assets.fixture';
import { FIXTURE_HERO_CATALOGUE } from '../adapters/dev/fixtures/heroes.fixture';
import type { RawItemEntry } from '../adapters/dev/fixtures/match-damage.fixture';
import { judgeDeaths } from '../core/analysis/avoidable-deaths';
import { buildMatchContext, statAt } from '../core/analysis/match-context';
import { phaseSpans } from '../core/analysis/phases';
import { parseItemCatalogue, type CatalogueItem } from '../core/deadlock-api/assets.schema';
import { heroesRequest, itemsRequest } from '../core/deadlock-api/endpoints';
import { parseHeroAssets } from '../core/deadlock-api/heroes.schema';
import type { HeroAsset } from '../core/domain/hero';
import type { MatchId } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import type { ArchiveEnvelope } from '../core/match-detail/archive-envelope';
import { DETAIL_WINDOW_MS } from '../core/match-detail/detail-status';
import { ARCHIVED_IDS, archived, MATCH_COUNT, NOW } from '../test/match-detail-page';
import { createTestServices } from '../test/create-test-services';
import { testMatchId } from '../test/test-data';
import { ArchiveReaderService } from './archive-reader.service';
import { MatchDetailRepository } from './match-detail.repository';
import type { TimelineTabView } from './match-timeline-view';

/** The scope of the log lines of the service. */
const LOG_SCOPE = 'timeline';

/** A day, in milliseconds. */
const DAY_MS = 24 * 60 * 60_000;

/** An item the item catalogue of the fixtures does not know. */
const UNKNOWN_ITEM_ID = 9_999_001;

/** The item catalogue of the fixtures as the app reads it: the oracle for the purchases. */
const CATALOGUE: readonly CatalogueItem[] = parseItemCatalogue(FIXTURE_ITEM_CATALOGUE);

/** The hero catalogue of the fixtures as the app reads it: the oracle for the killers' names. */
const HEROES: readonly HeroAsset[] = parseHeroAssets(FIXTURE_HERO_CATALOGUE);

/** One death detail of a player of an archive, as the API writes it. */
interface RawDeath {
  game_time_s: number;
  killer_player_slot: number;
  time_to_kill_s?: number | null;
}

/** One statistics snapshot of a player of an archive, as the API writes it. */
interface RawSnapshot {
  time_stamp_s: number;
  net_worth?: number;
}

/** A player of an archive as the API writes it: the fields the timeline reads or a test edits. */
interface RawPlayer {
  account_id: number;
  player_slot: number;
  team: number;
  hero_id: number;
  assigned_lane?: number | null;
  stats: RawSnapshot[];
  items: RawItemEntry[];
  /** The death details: a list, or anything when a test breaks it. */
  death_details?: unknown;
}

/** One movement path of an archive: only the slot is read by the tests. */
interface RawPath {
  player_slot: number;
}

/** The `match_info` of an archive as the API writes it. */
interface RawMatchInfo {
  start_time: number;
  duration_s: number;
  players: RawPlayer[];
  match_paths?: { paths: RawPath[] };
}

/** The part of an archive file that the tests read and edit. */
interface RawEnvelope {
  archiveFormat: number;
  payload: { match_info: RawMatchInfo };
}

/**
 * Archive the matches of the synthetic history and build the services like the app does, on the
 * development adapters, with a clock the tests can move.
 *
 * @param handler - Answers the requests to deadlock-api; the fixture API by default.
 * @returns The services, the adapters under them, the clock, a reader of the archives and the
 *   detail repository a test edits the stored data with.
 */
async function setUp(handler?: FixtureHandler) {
  const clock = { now: NOW };
  const test = await archived({
    now: () => clock.now,
    handler: handler ?? createFixtureApi({ now: NOW, matchCount: MATCH_COUNT }),
  });
  return {
    ...test,
    clock,
    timeline: test.services.timeline,
    details: new MatchDetailRepository(test.database),
    reader: new ArchiveReaderService({
      archive: test.archiveStore,
      compressor: test.compressor,
      logger: test.logger,
    }),
  };
}

/** Everything {@link setUp} builds. */
type TestContext = Awaited<ReturnType<typeof setUp>>;

/**
 * The account the services were built for.
 *
 * @param context - What {@link setUp} built.
 * @returns The account.
 */
function accountOf(context: TestContext) {
  return context.accountId ?? expect.unreachable('the services are built for an account');
}

/**
 * Read the decoded archive of a match.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The envelope.
 */
async function envelopeOf(context: TestContext, matchId: MatchId): Promise<ArchiveEnvelope> {
  const read = await context.reader.readArchive(accountOf(context), matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  return read.envelope;
}

/**
 * Read the archive of a match as the API wrote it, to check a view against the raw data and not
 * against the code that reads it.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns A deep copy of the archive, which the caller may change.
 */
async function rawEnvelopeOf(context: TestContext, matchId: MatchId): Promise<RawEnvelope> {
  return JSON.parse(JSON.stringify(await envelopeOf(context, matchId))) as RawEnvelope;
}

/**
 * The tracked player of a raw archive.
 *
 * @param context - What {@link setUp} built.
 * @param info - The raw match info.
 * @returns The player with the tracked account.
 */
function rawTracked(context: TestContext, info: RawMatchInfo): RawPlayer {
  return (
    info.players.find((player) => player.account_id === accountOf(context)) ??
    expect.unreachable('the tracked player is in the match')
  );
}

/**
 * The death details of a raw player.
 *
 * @param player - The player.
 * @returns Their deaths, as a list the test may change.
 */
function deathsOf(player: RawPlayer): RawDeath[] {
  const { death_details: details } = player;
  return Array.isArray(details)
    ? (details as RawDeath[])
    : expect.unreachable('the player has a list of death details');
}

/**
 * Edit the archive the synchronisation wrote for a match, and write the file again. The match stays
 * recorded as archived.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param edit - Edits the archive: the tracked player and the whole envelope.
 */
async function editArchive(
  context: TestContext,
  matchId: MatchId,
  edit: (tracked: RawPlayer, envelope: RawEnvelope) => void,
): Promise<void> {
  const envelope = await rawEnvelopeOf(context, matchId);
  edit(rawTracked(context, envelope.payload.match_info), envelope);
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  await context.archiveStore.write(
    accountOf(context),
    matchId,
    await context.compressor.compress(bytes),
  );
}

/**
 * Turn an archive into one of the first format: the movement path of the tracked player only, as
 * the pruning kept it before the paths of every player were.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 */
async function makeFirstFormat(context: TestContext, matchId: MatchId): Promise<void> {
  await editArchive(context, matchId, (tracked, envelope) => {
    envelope.archiveFormat = 1;
    const paths =
      envelope.payload.match_info.match_paths ?? expect.unreachable('the archive has paths');
    paths.paths = paths.paths.filter((path) => path.player_slot === tracked.player_slot);
  });
}

/**
 * Record the archive of a match with a format, as the database of an older version would.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param format - The format, `null` for an archive written before the format was recorded.
 */
async function recordFormat(
  context: TestContext,
  matchId: MatchId,
  format: 1 | null,
): Promise<void> {
  await context.database.execute(
    'UPDATE matches SET archive_format = $1 WHERE account_id = $2 AND match_id = $3',
    [format, accountOf(context), matchId],
  );
}

/**
 * Unwrap the timeline of a match.
 *
 * @param view - What the service answered.
 * @returns The timeline, or a failure of the test when the tab is in any other state.
 */
function timelineOf(view: TimelineTabView) {
  if (view.kind !== 'timeline') {
    expect.unreachable(`the timeline tab is ${view.kind}, not a timeline`);
  }
  return view;
}

/**
 * The first archived match whose raw archive passes a check.
 *
 * @param context - What {@link setUp} built.
 * @param what - What the match must be, for the failure message.
 * @param check - Tells whether the archive is the one wanted.
 * @returns The match.
 */
async function archivedMatchWhere(
  context: TestContext,
  what: string,
  check: (tracked: RawPlayer, info: RawMatchInfo) => boolean,
): Promise<MatchId> {
  for (const matchId of ARCHIVED_IDS) {
    const info = (await rawEnvelopeOf(context, matchId)).payload.match_info;
    if (check(rawTracked(context, info), info)) {
      return matchId;
    }
  }
  return expect.unreachable(`the history holds an archived match ${what}`);
}

/**
 * The first archived match in which the tracked player died.
 *
 * @param context - What {@link setUp} built.
 * @returns The match.
 */
function matchWithDeaths(context: TestContext): Promise<MatchId> {
  return archivedMatchWhere(
    context,
    'in which the tracked player died',
    (tracked) => deathsOf(tracked).length > 0,
  );
}

/**
 * The log lines of the service.
 *
 * @param context - What {@link setUp} built.
 * @returns The lines, in order.
 */
function timelineLogs(context: TestContext) {
  return context.logger.entries.filter((entry) => entry.scope === LOG_SCOPE);
}

/**
 * A shop item bought by the player, as the archive writes it.
 *
 * @param itemId - The asset id of the item.
 * @param boughtAtS - When it was bought, in seconds since the start of the match.
 * @returns The entry.
 */
function shopEntryOf(itemId: number, boughtAtS: number): RawItemEntry {
  return {
    item_id: itemId,
    game_time_s: boughtAtS,
    // 1 is a shop item (0 is the unlock of an ability, 2 and more its upgrades).
    upgrade_id: 1,
    sold_time_s: 0,
    flags: 0,
    imbued_ability_id: 0,
    // The level mask of an ability: nothing reads it for an item.
    upgrade_info: 0,
  };
}

describe('MatchTimelineService', () => {
  describe('getTimelineTab', () => {
    it('builds the souls of the player and the mean of their lane opponents', async () => {
      const context = await setUp();
      const matchId = ARCHIVED_IDS[0] ?? expect.unreachable('the history holds archived matches');
      const view = timelineOf(await context.timeline.getTimelineTab(matchId));

      // The player's line is their souls at each of their snapshots, as the archive holds them.
      const info = (await rawEnvelopeOf(context, matchId)).payload.match_info;
      const tracked = rawTracked(context, info);
      const snapshots = tracked.stats
        .filter((snapshot) => snapshot.net_worth !== undefined)
        .toSorted((first, second) => first.time_stamp_s - second.time_stamp_s);
      expect(snapshots.length).toBeGreaterThan(1);
      expect(view.souls.you).toEqual([
        { timeS: 0, souls: 0 },
        ...snapshots.map((snapshot) => ({
          timeS: snapshot.time_stamp_s,
          souls: snapshot.net_worth,
        })),
      ]);

      // The opponents are the enemies of the player's lane...
      const opponents = info.players.filter(
        (player) => player.team !== tracked.team && player.assigned_lane === tracked.assigned_lane,
      );
      expect(opponents.length).toBeGreaterThan(0);
      expect(view.souls.opponentCount).toBe(opponents.length);
      // ... and their line is the mean of their souls at the player's times.
      const matchContext = buildMatchContext(await envelopeOf(context, matchId));
      expect(view.souls.opponents).toEqual(
        view.souls.you.map(({ timeS }) => ({
          timeS,
          souls:
            matchContext.laneOpponents.reduce(
              (sum, opponent) => sum + (statAt(opponent, 'net_worth', timeS) ?? Number.NaN),
              0,
            ) / opponents.length,
        })),
      );

      // The match, its phases and its length frame the chart.
      expect(view.durationS).toBe(info.duration_s);
      expect(view.phases).toEqual(
        phaseSpans(info.duration_s).map(({ phase, startS, endS }) => ({ phase, startS, endS })),
      );

      // A player with no lane opponent has no line to compare with.
      await editArchive(context, matchId, (editedTracked) => {
        editedTracked.assigned_lane = 99;
      });
      const alone = timelineOf(await context.timeline.getTimelineTab(matchId));
      expect(alone.souls).toEqual({ you: view.souls.you, opponents: null, opponentCount: 0 });
    });

    it('starts the souls at zero', async () => {
      const context = await setUp();
      for (const matchId of ARCHIVED_IDS) {
        const { souls } = timelineOf(await context.timeline.getTimelineTab(matchId));
        expect(souls.you[0]).toEqual({ timeS: 0, souls: 0 });
        expect(souls.opponents?.[0]).toEqual({ timeS: 0, souls: 0 });
      }
    });

    it('lists the deaths with killer, time to kill, players near and verdict', async () => {
      const context = await setUp();
      const verdicts = new Set<string | null>();
      for (const matchId of ARCHIVED_IDS) {
        const view = timelineOf(await context.timeline.getTimelineTab(matchId));
        expect(view.positions).toBe('known');

        // When, by whom and how fast come from the death details of the archive...
        const info = (await rawEnvelopeOf(context, matchId)).payload.match_info;
        const raw = deathsOf(rawTracked(context, info)).toSorted(
          (first, second) => first.game_time_s - second.game_time_s,
        );
        // ... who was near and the verdict from the rule that owns them.
        const judged = judgeDeaths(await envelopeOf(context, matchId)).deaths ?? [];
        expect(view.deaths).toEqual(
          raw.map((death, index) => {
            const heroId =
              info.players.find((player) => player.player_slot === death.killer_player_slot)
                ?.hero_id ?? expect.unreachable('the killer is a player of the match');
            const nearby = judged[index]?.nearby ?? expect.unreachable('the death is judged');
            return {
              timeS: death.game_time_s,
              killer: {
                kind: 'hero',
                heroId,
                name: HEROES.find((hero) => hero.id === heroId)?.name ?? null,
              },
              timeToKillS: death.time_to_kill_s ?? null,
              enemiesNear: nearby.enemies,
              alliesNear: nearby.allies,
              verdict: judged[index]?.verdict,
            };
          }),
        );
        for (const death of view.deaths ?? []) {
          verdicts.add(death.verdict);
        }
        // The count the page writes in the title of the list is the one of the verdicts.
        expect(view.avoidableCount).toBe(
          judged.filter((death) => death.verdict === 'avoidable').length,
        );
      }
      // The history holds both kinds of deaths, so both were checked.
      expect(verdicts).toEqual(new Set(['avoidable', 'balanced']));
    });

    it('names a death to troopers as the world', async () => {
      const context = await setUp();
      const matchId = await matchWithDeaths(context);
      await editArchive(context, matchId, (tracked) => {
        const [first] = deathsOf(tracked).toSorted(
          (one, other) => one.game_time_s - other.game_time_s,
        );
        (first ?? expect.unreachable('the player died')).killer_player_slot = 0;
      });

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));
      const first = view.deaths?.[0] ?? expect.unreachable('the deaths are listed');
      // No hero killed them: there is no killer to name, and no fight to judge; who was near is
      // still told, the killer no longer counted.
      expect(first.killer).toEqual({ kind: 'world' });
      expect(first.verdict).toBeNull();
      expect(first.enemiesNear).toEqual(expect.any(Number));
      expect(first.alliesNear).toEqual(expect.any(Number));
    });

    it('lists a death by a killer the match does not have as an unknown hero', async () => {
      const context = await setUp();
      const matchId = await matchWithDeaths(context);
      const before = timelineOf(await context.timeline.getTimelineTab(matchId));
      await editArchive(context, matchId, (tracked) => {
        const [first] = deathsOf(tracked).toSorted(
          (one, other) => one.game_time_s - other.game_time_s,
        );
        // No player of a match of twelve has slot 99.
        (first ?? expect.unreachable('the player died')).killer_player_slot = 99;
      });

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));

      // The death is still listed, by a hero nobody can name, with the verdict of the rule...
      const [first, ...others] = view.deaths ?? expect.unreachable('the deaths are listed');
      const judged = judgeDeaths(await envelopeOf(context, matchId)).deaths?.[0];
      expect(first).toMatchObject({
        killer: { kind: 'hero', heroId: null, name: null },
        verdict: judged?.verdict,
        enemiesNear: judged?.nearby?.enemies,
      });
      // ... and the rest of the timeline is as it was.
      expect(others).toEqual(before.deaths?.slice(1));
      expect({ ...view, deaths: null, avoidableCount: null }).toEqual({
        ...before,
        deaths: null,
        avoidableCount: null,
      });
    });

    it('places kills and shop purchases only', async () => {
      const context = await setUp();
      const matchId = await archivedMatchWhere(
        context,
        'in which the tracked player killed a hero',
        (tracked, info) =>
          info.players.some((player) =>
            deathsOf(player).some((death) => death.killer_player_slot === tracked.player_slot),
          ),
      );
      // A shop entry of a weapon (no item of the shop, whatever its entry says) and one of an item
      // the catalogue does not know (a new item of the game) join the purchases of the archive.
      const weapon =
        CATALOGUE.find((item) => item.kind === 'weapon') ??
        expect.unreachable('the fixture catalogue holds a weapon');
      await editArchive(context, matchId, (tracked) => {
        tracked.items.push(shopEntryOf(weapon.id, 30), shopEntryOf(UNKNOWN_ITEM_ID, 40));
      });

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));
      const info = (await rawEnvelopeOf(context, matchId)).payload.match_info;
      const tracked = rawTracked(context, info);

      // The kills are the deaths of the other players that the tracked player made, in time order.
      const kills = info.players
        .flatMap((player) => deathsOf(player))
        .filter((death) => death.killer_player_slot === tracked.player_slot)
        .map((death) => death.game_time_s)
        .toSorted((first, second) => first - second);
      expect(kills.length).toBeGreaterThan(0);
      expect(view.kills).toEqual(kills);

      // The purchases are the shop items, named by the catalogue: no ability unlock or upgrade, and
      // no entry the catalogue knows as something else than an item of the shop.
      const purchases = tracked.items
        .filter((item) => item.upgrade_id === 1)
        .map((item) => ({ item, entry: CATALOGUE.find((entry) => entry.id === item.item_id) }))
        .filter(({ entry }) => entry === undefined || entry.kind === 'upgrade')
        .toSorted(
          (first, second) =>
            first.item.game_time_s - second.item.game_time_s ||
            first.item.item_id - second.item.item_id,
        )
        .map(({ item, entry }) => ({
          timeS: item.game_time_s,
          itemId: item.item_id,
          name: entry?.name ?? null,
          imageUrl: entry?.imageUrl ?? null,
        }));
      expect(tracked.items.some((item) => item.upgrade_id !== 1)).toBe(true);
      expect(purchases.length).toBeGreaterThan(1);
      expect(view.purchases).toEqual(purchases);
      expect(view.purchases.map((purchase) => purchase.itemId)).not.toContain(weapon.id);
      // The item the catalogue does not know is kept, with nothing made up for it.
      expect(view.purchases).toContainEqual({
        timeS: 40,
        itemId: UNKNOWN_ITEM_ID,
        name: null,
        imageUrl: null,
      });
    });

    it('names a purchase the catalogue has no name for by its class name', async () => {
      // A catalogue whose shop items have no name, as about a quarter of the real entries have none.
      const nameless = FIXTURE_ITEM_CATALOGUE.map((item) =>
        item.type === 'upgrade' ? { ...item, name: '' } : item,
      );
      const fixtureApi = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
      const context = await setUp((request) =>
        request.url === itemsRequest().url ? jsonResponse(nameless) : fixtureApi(request),
      );
      const matchId = ARCHIVED_IDS[0] ?? expect.unreachable('the history holds archived matches');

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));

      // `upgrade_express_shot` reads "express shot": the prefix dropped, the underscores spaces.
      expect(view.purchases.length).toBeGreaterThan(0);
      for (const purchase of view.purchases) {
        const entry =
          CATALOGUE.find((item) => item.id === purchase.itemId) ??
          expect.unreachable('the purchases are items of the catalogue');
        expect(entry.className).toMatch(/^upgrade_/);
        expect(purchase.name).toBe(entry.className.slice('upgrade_'.length).replaceAll('_', ' '));
        expect(purchase.imageUrl).toBe(entry.imageUrl);
      }
    });

    it('works without the catalogues', async () => {
      const down = new Set([heroesRequest().url, itemsRequest().url]);
      const fixtureApi = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
      const context = await setUp((request) => {
        if (down.has(request.url)) {
          throw new AppError('network', 'The request failed');
        }
        return fixtureApi(request);
      });
      const matchId = await matchWithDeaths(context);

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));

      // The killers are told by their hero's id only, and the purchases by their item's id, every
      // shop entry of the archive kept since none can be told apart.
      const info = (await rawEnvelopeOf(context, matchId)).payload.match_info;
      const tracked = rawTracked(context, info);
      expect(view.deaths?.length).toBeGreaterThan(0);
      for (const death of view.deaths ?? []) {
        expect(death.killer).toMatchObject({ kind: 'hero', name: null });
      }
      expect(view.purchases.map((purchase) => purchase.itemId)).toEqual(
        tracked.items
          .filter((item) => item.upgrade_id === 1)
          .toSorted(
            (first, second) =>
              first.game_time_s - second.game_time_s || first.item_id - second.item_id,
          )
          .map((item) => item.item_id),
      );
      expect(
        view.purchases.every((purchase) => purchase.name === null && purchase.imageUrl === null),
      ).toBe(true);

      // One line for the call, at `info`, however many catalogues failed: no fault of the app.
      const lines = timelineLogs(context);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'info',
        scope: LOG_SCOPE,
        context: { matchId, kind: 'network' },
      });
      expect(JSON.stringify(lines)).not.toContain(String(accountOf(context)));
    });

    it('says the positions are missing and a refresh is scheduled', async () => {
      const context = await setUp();
      const matchId = await matchWithDeaths(context);
      await makeFirstFormat(context, matchId);
      await recordFormat(context, matchId, null);

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));

      // A recent archive of the first format is downloaded again by the next synchronisation.
      expect(view.positions).toBe('missing_refresh_scheduled');
      // Until then the deaths are listed, with no one near and no verdict.
      expect(view.deaths?.length).toBeGreaterThan(0);
      for (const death of view.deaths ?? []) {
        expect(death).toMatchObject({ enemiesNear: null, alliesNear: null, verdict: null });
      }
      // Any death may have been avoidable: the count is unknown, not zero.
      expect(view.avoidableCount).toBeNull();
    });

    it('says nothing of a refresh past 90 days', async () => {
      const context = await setUp();
      const matchId = await matchWithDeaths(context);
      await makeFirstFormat(context, matchId);
      await recordFormat(context, matchId, null);
      const detail =
        (await context.details.getDetail(accountOf(context), matchId)) ??
        expect.unreachable('the match is stored');

      // Control: the match is in the window.
      expect(timelineOf(await context.timeline.getTimelineTab(matchId)).positions).toBe(
        'missing_refresh_scheduled',
      );
      // A day past the window, the queue no longer downloads the match.
      context.clock.now = detail.match.startTime * 1000 + DETAIL_WINDOW_MS + DAY_MS;
      expect(timelineOf(await context.timeline.getTimelineTab(matchId)).positions).toBe('missing');

      // Nor does it download again an archive whose refresh failed for good, however recent.
      context.clock.now = NOW;
      await recordFormat(context, matchId, 1);
      expect(timelineOf(await context.timeline.getTimelineTab(matchId)).positions).toBe('missing');
    });

    it('says the death detail is incomplete', async () => {
      const context = await setUp();
      const matchId = await matchWithDeaths(context);
      await editArchive(context, matchId, (tracked) => {
        deathsOf(tracked).pop();
      });

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));

      // A missing detail makes the deaths unknown, not fewer; the rest of the timeline stays.
      expect(view.deaths).toBeNull();
      expect(view.avoidableCount).toBeNull();
      expect(view.souls.you.length).toBeGreaterThan(1);
      expect(view.purchases.length).toBeGreaterThan(0);
    });

    it("leaves out the kills when a player's death detail is incomplete", async () => {
      const context = await setUp();
      const matchId = await archivedMatchWhere(
        context,
        'in which the tracked player and an enemy died',
        (tracked, info) =>
          deathsOf(tracked).length > 0 &&
          info.players.some(
            (player) => player.team !== tracked.team && deathsOf(player).length > 0,
          ),
      );
      await editArchive(context, matchId, (tracked, envelope) => {
        const enemy =
          envelope.payload.match_info.players.find(
            (player) => player.team !== tracked.team && deathsOf(player).length > 0,
          ) ?? expect.unreachable('an enemy died');
        deathsOf(enemy).pop();
      });

      const view = timelineOf(await context.timeline.getTimelineTab(matchId));

      // A kill of the player may be the missing detail: the kills are unknown, not fewer...
      expect(view.kills).toBeNull();
      // ... while the player's own deaths are complete.
      expect(view.deaths?.length).toBeGreaterThan(0);
    });

    it('answers unreadable for an archive it cannot read', async () => {
      const context = await setUp();
      const [broken, damaged] = ARCHIVED_IDS;
      if (broken === undefined || damaged === undefined) {
        expect.unreachable('the history holds two archived matches');
      }
      await editArchive(context, broken, (tracked) => {
        tracked.death_details = 'not a list';
      });
      // Bytes that are no archive, as a disk that lost its data would leave.
      await context.archiveStore.write(
        accountOf(context),
        damaged,
        new TextEncoder().encode('this is not an archive'),
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(context.timeline.getTimelineTab(broken)).resolves.toEqual({
          kind: 'unreadable',
        });
        await expect(context.timeline.getTimelineTab(damaged)).resolves.toEqual({
          kind: 'unreadable',
        });
      }

      // One warning for the broken match, with the place and the kind of the problem, never a value.
      const lines = timelineLogs(context);
      expect(lines).toEqual([
        {
          level: 'warn',
          scope: LOG_SCOPE,
          message: 'The timeline of a match could not be read',
          context: {
            matchId: broken,
            issue: expect.stringMatching(/^players\.\d+\.death_details: \w+$/) as unknown,
          },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(String(accountOf(context)));
      expect(JSON.stringify(lines)).not.toContain('not a list');
      // An archive that passed the checks of the door is not reset for a field this view dislikes.
      for (const matchId of [broken, damaged]) {
        await expect(context.details.getDetail(accountOf(context), matchId)).resolves.toMatchObject(
          { status: 'ready' },
        );
      }
    });

    it('answers not archived for a match with no archive', async () => {
      const context = await setUp();
      const matchId = ARCHIVED_IDS[0] ?? expect.unreachable('the history holds archived matches');
      // Control: the match can be shown until its detail is no longer archived.
      timelineOf(await context.timeline.getTimelineTab(matchId));
      await context.details.resetToPending(accountOf(context), matchId);
      const sent = context.http.requests.length;

      await expect(context.timeline.getTimelineTab(matchId)).resolves.toEqual({
        kind: 'not_archived',
      });
      await expect(context.timeline.getTimelineTab(testMatchId(100_000_001))).resolves.toEqual({
        kind: 'not_archived',
      });
      const { services, http } = createTestServices({ accountId: null });
      await expect(services.timeline.getTimelineTab(matchId)).resolves.toEqual({
        kind: 'not_archived',
      });
      // A match that cannot be shown costs nothing, and nobody is contacted without an account.
      expect(context.http.requests).toHaveLength(sent);
      expect(http.requests).toEqual([]);
    });

    it('rejects with the error of the disk when the archive cannot be read', async () => {
      const context = await setUp();
      const matchId = ARCHIVED_IDS[0] ?? expect.unreachable('the history holds archived matches');
      vi.spyOn(context.archiveStore, 'read').mockRejectedValue(new Error('Access is denied'));

      // A disk that fails says nothing about the match: no state is made up for it.
      await expect(context.timeline.getTimelineTab(matchId)).rejects.toMatchObject({
        kind: 'storage',
      });
    });
  });
});
