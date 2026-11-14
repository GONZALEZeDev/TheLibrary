/**
 * Tests of the replay of a match (`MatchReplayService.getReplay`), end to end on the development
 * adapters: a synchronisation of the synthetic history archives the Paige matches, the catalogues
 * come from the fixture API (plus a map asset, which the fixtures do not hold), and everything is
 * stored in an in-memory database with the real migrations.
 *
 * What a view must show is checked against the core reader of the replay and the projection of the
 * map, which own the rules; a test that needs something the fixtures do not give (objectives, mid
 * boss kills) edits the archive the synchronisation wrote: the match stays archived, exactly like
 * data written by another version of the app would be.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  createFixtureApi,
  jsonResponse,
  type FixtureHandler,
} from '../adapters/dev/fixture-http-client.adapter';
import { FIXTURE_HERO_CATALOGUE } from '../adapters/dev/fixtures/heroes.fixture';
import { ASSET_IMAGE_ORIGIN } from '../core/deadlock-api/assets.schema';
import { heroesRequest, mapRequest } from '../core/deadlock-api/endpoints';
import { parseHeroAssets } from '../core/deadlock-api/heroes.schema';
import { parseMapLayout } from '../core/deadlock-api/map.schema';
import type { MatchId } from '../core/domain/match';
import { AppError } from '../core/errors/app-error';
import type { ArchiveEnvelope } from '../core/match-detail/archive-envelope';
import { worldToRelative } from '../core/match-map/map-geometry';
import { MAP_OBJECTIVE_IDS, MID_BOSS_POSITION } from '../core/match-map/map-objectives';
import { readMatchReplay } from '../core/match-map/match-replay';
import { teamIdentityOf } from '../core/match-map/team-identity';
import { createTestServices } from '../test/create-test-services';
import { ARCHIVED_IDS, archived, MATCH_COUNT, NOW } from '../test/match-detail-page';
import { testMatchId } from '../test/test-data';
import { ArchiveReaderService } from './archive-reader.service';
import { MatchDetailRepository } from './match-detail.repository';
import type { ReplayView } from './match-replay-view';

/** The scope of the log lines of the service. */
const LOG_SCOPE = 'replay';

/** Half the side of the world square of the map the tests serve, in world units. */
const RADIUS = 10_752;

/** The minimap picture of the map the tests serve, on the asset bucket. */
const MINIMAP_URL = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/maps/minimap_midtown_mid.png`;

/** The map asset as the API writes it: the picture, two objectives and one zip line. */
const RAW_MAP = {
  radius: RADIUS,
  images: { minimap: MINIMAP_URL },
  objective_positions: {
    team0_core: { left_relative: 0.29, top_relative: 0.92 },
    team1_titan: { left_relative: 0.51, top_relative: 0.08 },
  },
  zipline_paths: [
    {
      origin: [1218, 10784, 1524],
      color: '#F1CC30',
      P0_points: [
        [0, 0, 0],
        [0, -1158, 288],
      ],
    },
  ],
};

/** The map layout as the app reads it: the oracle for the projection. */
const LAYOUT = parseMapLayout(RAW_MAP);

/** Minimal shape of the parts of an archive that the tests edit. */
interface RawEnvelope {
  payload: {
    match_info: {
      duration_s: number;
      objectives?: unknown;
      mid_boss?: unknown;
      players: { death_details?: unknown }[];
    };
  };
}

/**
 * Archive the matches of the synthetic history and build the services like the app does, on the
 * development adapters. The map asset is served on top of the fixture API.
 *
 * @param handler - Answers the requests to deadlock-api; the fixture API plus the map by default.
 * @returns The services, the adapters under them, a reader of the archives and the detail
 *   repository.
 */
async function setUp(handler?: FixtureHandler) {
  const fixtureApi = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
  const test = await archived({
    now: () => NOW,
    handler:
      handler ??
      ((request) =>
        request.url === mapRequest().url ? jsonResponse(RAW_MAP) : fixtureApi(request)),
  });
  return {
    ...test,
    replay: test.services.replay,
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
 * A handler of the fixture API plus the map, in which some requests fail like a network that is
 * down.
 *
 * @param down - The URLs that fail.
 * @param heroes - The raw hero catalogue to serve; the fixture one by default.
 * @returns The handler.
 */
function handlerWith(
  down: readonly string[],
  heroes: unknown = FIXTURE_HERO_CATALOGUE,
): FixtureHandler {
  const fixtureApi = createFixtureApi({ now: NOW, matchCount: MATCH_COUNT });
  return (request) => {
    if (down.includes(request.url)) {
      throw new AppError('network', 'The request failed');
    }
    if (request.url === mapRequest().url) {
      return jsonResponse(RAW_MAP);
    }
    return request.url === heroesRequest().url ? jsonResponse(heroes) : fixtureApi(request);
  };
}

/**
 * The first archived match.
 *
 * @returns Its id.
 */
function firstMatch(): MatchId {
  return ARCHIVED_IDS[0] ?? expect.unreachable('the history holds archived matches');
}

/**
 * Read the decoded archive of a match.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @returns The envelope.
 */
async function envelopeOf(context: TestContext, matchId: MatchId): Promise<ArchiveEnvelope> {
  const accountId = context.accountId ?? expect.unreachable('the services have an account');
  const read = await context.reader.readArchive(accountId, matchId);
  if (read.kind !== 'read') {
    expect.unreachable('the archive of the match is readable');
  }
  return read.envelope;
}

/**
 * Edit the archive the synchronisation wrote for a match, and write the file again. The match stays
 * recorded as archived.
 *
 * @param context - What {@link setUp} built.
 * @param matchId - The match.
 * @param edit - Edits the archive.
 */
async function editArchive(
  context: TestContext,
  matchId: MatchId,
  edit: (envelope: RawEnvelope) => void,
): Promise<void> {
  const envelope = JSON.parse(JSON.stringify(await envelopeOf(context, matchId))) as RawEnvelope;
  edit(envelope);
  await context.archiveStore.write(
    context.accountId ?? expect.unreachable('the services have an account'),
    matchId,
    await context.compressor.compress(new TextEncoder().encode(JSON.stringify(envelope))),
  );
}

/**
 * Unwrap the replay of a match.
 *
 * @param view - What the service answered.
 * @returns The replay, or a failure of the test when the match is in any other state.
 */
function replayOf(view: ReplayView) {
  if (view.kind !== 'replay') {
    expect.unreachable(`the replay is ${view.kind}, not a replay`);
  }
  return view;
}

describe('MatchReplayService', () => {
  describe('getReplay', () => {
    it('answers not archived without an account or a detail', async () => {
      const context = await setUp();
      const matchId = firstMatch();
      // Control: the match can be replayed until its detail is no longer archived.
      replayOf(await context.replay.getReplay(matchId));
      await context.details.resetToPending(
        context.accountId ?? expect.unreachable('the services have an account'),
        matchId,
      );
      const sent = context.http.requests.length;

      await expect(context.replay.getReplay(matchId)).resolves.toEqual({ kind: 'not_archived' });
      await expect(context.replay.getReplay(testMatchId(100_000_001))).resolves.toEqual({
        kind: 'not_archived',
      });
      const { services, http } = createTestServices({ accountId: null });
      await expect(services.replay.getReplay(matchId)).resolves.toEqual({ kind: 'not_archived' });
      // A match that cannot be shown costs nothing, and nobody is contacted without an account.
      expect(context.http.requests).toHaveLength(sent);
      expect(http.requests).toEqual([]);
    });

    it('answers unreadable when the archive is damaged', async () => {
      const context = await setUp();
      const [broken, damaged] = ARCHIVED_IDS;
      if (broken === undefined || damaged === undefined) {
        expect.unreachable('the history holds two archived matches');
      }
      const accountId = context.accountId ?? expect.unreachable('the services have an account');
      // A field of the payload that is not what is expected...
      await editArchive(context, broken, (envelope) => {
        const [player] = envelope.payload.match_info.players;
        (player ?? expect.unreachable('the match has players')).death_details = 'not a list';
      });
      // ... and bytes that are no archive, as a disk that lost its data would leave.
      await context.archiveStore.write(
        accountId,
        damaged,
        new TextEncoder().encode('this is not an archive'),
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(context.replay.getReplay(broken)).resolves.toEqual({ kind: 'unreadable' });
        await expect(context.replay.getReplay(damaged)).resolves.toEqual({ kind: 'unreadable' });
      }

      // One warning for the broken match, with the place and the kind of the problem, never a value.
      const lines = context.logger.entries.filter((entry) => entry.scope === LOG_SCOPE);
      expect(lines).toEqual([
        {
          level: 'warn',
          scope: LOG_SCOPE,
          message: 'The replay of a match could not be read',
          context: {
            matchId: broken,
            issue: expect.stringMatching(
              /^match_info\.players\.\d+\.death_details: \w+$/,
            ) as unknown,
          },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(String(accountId));
      expect(JSON.stringify(lines)).not.toContain('not a list');
    });

    it('projects positions to the map with the layout radius', async () => {
      const context = await setUp();
      const matchId = firstMatch();
      const view = replayOf(await context.replay.getReplay(matchId));
      const replay = readMatchReplay(await envelopeOf(context, matchId));

      expect(view.durationS).toBe(replay.durationS);
      expect(view.coverage).toBe(replay.coverage);
      expect(view.map).toEqual({
        imageUrl: MINIMAP_URL,
        lanes: LAYOUT.lanes,
        midBoss: MID_BOSS_POSITION,
      });
      expect(view.players.map((player) => player.slot)).toEqual(
        replay.players.map((player) => player.slot),
      );
      let placed = 0;
      for (const [index, player] of view.players.entries()) {
        const track = replay.players[index] ?? expect.unreachable('the players match');
        // One entry per second, a world point projected with the radius of the map, the same
        // holes (dead or unknown) as the replay.
        expect(player.positions).toHaveLength(replay.durationS + 1);
        expect(player.positions).toEqual(
          track.positions.map((point) => (point === null ? null : worldToRelative(point, RADIUS))),
        );
        expect(player.hasPath).toBe(track.hasPath);
        expect(player.deaths).toEqual(track.deaths);
        placed += player.positions.filter((point) => point !== null).length;
      }
      // The history holds paths, so the check above compared real points.
      expect(placed).toBeGreaterThan(0);
    });

    it('tells the sides relative to the tracked team', async () => {
      const context = await setUp();
      const matchId = firstMatch();
      const duration = (await envelopeOf(context, matchId)).payload.match_info.duration_s;
      const replay = readMatchReplay(await envelopeOf(context, matchId));
      const other = 1 - replay.trackedTeam;
      // A mid boss killed by the enemy team and claimed by the tracked one, then the reverse; the
      // second kill is so late that its return is after the end of the match.
      await editArchive(context, matchId, (envelope) => {
        envelope.payload.match_info.mid_boss = [
          { team_killed: other, team_claimed: replay.trackedTeam, destroyed_time_s: 60 },
          { team_killed: replay.trackedTeam, team_claimed: other, destroyed_time_s: duration - 10 },
        ];
      });

      const view = replayOf(await context.replay.getReplay(matchId));

      for (const player of view.players) {
        const track = replay.players.find((candidate) => candidate.slot === player.slot);
        expect(player.side).toBe(track?.team === replay.trackedTeam ? 'ally' : 'enemy');
      }
      const tracked = view.players.filter((player) => player.isTracked);
      expect(tracked).toHaveLength(1);
      expect(tracked[0]?.side).toBe('ally');
      expect(view.players.filter((player) => player.side === 'ally')).toHaveLength(6);
      // The objectives of team 0 come first, whichever side that is.
      const allySide = replay.trackedTeam === 0 ? 'ally' : 'enemy';
      expect(view.objectives.slice(0, 13).every((objective) => objective.side === allySide)).toBe(
        true,
      );
      expect(view.objectives.slice(13).every((objective) => objective.side !== allySide)).toBe(
        true,
      );
      const trackedIdentity = teamIdentityOf(replay.trackedTeam);
      const otherIdentity = teamIdentityOf(other);
      expect(view.midBossKills).toEqual([
        {
          timeS: 60,
          killedByTeam: otherIdentity,
          claimedByTeam: trackedIdentity,
        },
        {
          timeS: duration - 10,
          killedByTeam: trackedIdentity,
          claimedByTeam: otherIdentity,
        },
      ]);
      // 420 s after the first kill; the return after the second one is past the end of the match.
      expect(duration).toBeGreaterThan(480);
      expect(view.midBossReturnsS).toEqual([480]);
    });

    it('players, objectives and mid boss kills carry their team identity', async () => {
      const context = await setUp();
      const matchId = firstMatch();
      const replay = readMatchReplay(await envelopeOf(context, matchId));
      await editArchive(context, matchId, (envelope) => {
        envelope.payload.match_info.mid_boss = [
          { team_killed: 0, team_claimed: 1, destroyed_time_s: 60 },
        ];
      });

      const view = replayOf(await context.replay.getReplay(matchId));

      // The identity is the one of the API team number, whichever side the owner played on.
      expect(view.trackedTeam).toBe(teamIdentityOf(replay.trackedTeam));
      for (const player of view.players) {
        const track = replay.players.find((candidate) => candidate.slot === player.slot);
        expect(player.team).toBe(teamIdentityOf(track?.team ?? -1));
      }
      expect(new Set(view.players.map((player) => player.team))).toEqual(
        new Set(['hidden_king', 'archmother']),
      );
      // Team 0 comes first among the objectives, then team 1.
      expect(view.objectives.slice(0, 13).every((o) => o.team === 'hidden_king')).toBe(true);
      expect(view.objectives.slice(13).every((o) => o.team === 'archmother')).toBe(true);
      expect(view.midBossKills[0]).toMatchObject({
        killedByTeam: 'hidden_king',
        claimedByTeam: 'archmother',
      });
    });

    it('health is passed through, and kept when the map asset fails', async () => {
      const matchId = firstMatch();
      for (const down of [[], [mapRequest().url]]) {
        const context = await setUp(handlerWith(down));
        const view = replayOf(await context.replay.getReplay(matchId));
        const replay = readMatchReplay(await envelopeOf(context, matchId));
        let known = 0;
        for (const [index, player] of view.players.entries()) {
          const track = replay.players[index] ?? expect.unreachable('the players match');
          expect(player.health).toEqual(track.health);
          known += player.health.filter((value) => value !== null).length;
        }
        // The history holds paths with health, so the check above compared real values.
        expect(known).toBeGreaterThan(0);
      }
    });

    it('deaths carry their killer slot', async () => {
      const context = await setUp();
      const matchId = firstMatch();
      const view = replayOf(await context.replay.getReplay(matchId));
      const replay = readMatchReplay(await envelopeOf(context, matchId));
      const deaths = replay.players.flatMap((track) => track.deaths);
      expect(deaths.length).toBeGreaterThan(0);
      for (const [index, player] of view.players.entries()) {
        const track = replay.players[index] ?? expect.unreachable('the players match');
        expect(player.deaths.map((death) => death.killerSlot)).toEqual(
          track.deaths.map((death) => death.killerSlot),
        );
      }
    });

    it('answers unreadable when a team is neither 0 nor 1', async () => {
      const context = await setUp();
      const matchId = firstMatch();
      // A mid boss killed by a team the API does not number 0 or 1 has no identity to colour it by.
      await editArchive(context, matchId, (envelope) => {
        envelope.payload.match_info.mid_boss = [
          { team_killed: 2, team_claimed: 0, destroyed_time_s: 60 },
        ];
      });

      const sent = context.http.requests.length;
      await expect(context.replay.getReplay(matchId)).resolves.toEqual({ kind: 'unreadable' });
      await expect(context.replay.getReplay(matchId)).resolves.toEqual({ kind: 'unreadable' });
      // The unreadable replay fetched no catalogue.
      expect(context.http.requests).toHaveLength(sent);

      // One warning with the problem, never a value of the payload or the account.
      const lines = context.logger.entries.filter((entry) => entry.scope === LOG_SCOPE);
      expect(lines).toEqual([
        {
          level: 'warn',
          scope: LOG_SCOPE,
          message: 'The replay of a match could not be read',
          context: { matchId, issue: expect.any(String) as unknown },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain(
        String(context.accountId ?? expect.unreachable('the services have an account')),
      );
    });

    it('has no map but the rest of the replay when the map asset fails', async () => {
      const context = await setUp(handlerWith([mapRequest().url]));
      const matchId = firstMatch();

      const view = replayOf(await context.replay.getReplay(matchId));

      const replay = readMatchReplay(await envelopeOf(context, matchId));
      expect(view.map).toBeNull();
      expect(view.durationS).toBe(replay.durationS);
      expect(view.coverage).toBe(replay.coverage);
      // Nothing can be placed on a picture that is not there.
      expect(view.players).toHaveLength(replay.players.length);
      for (const player of view.players) {
        expect(player.positions).toEqual([]);
        expect(player.heroName).toEqual(expect.any(String));
      }
      expect(view.objectives).toHaveLength(26);
      expect(view.objectives.every((objective) => objective.position === null)).toBe(true);
      // One line, whatever the number of catalogues that failed, with no payload value.
      const lines = context.logger.entries.filter((entry) => entry.scope === LOG_SCOPE);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'info',
        message: 'A catalogue of the game could not be read',
        context: { matchId },
      });
      expect(JSON.stringify(lines)).not.toContain(
        String(context.accountId ?? expect.unreachable('the services have an account')),
      );
    });

    it('lists all 26 objectives, standing ones with destroyedAtS null', async () => {
      const context = await setUp();
      const matchId = firstMatch();
      const trackedTeam = readMatchReplay(await envelopeOf(context, matchId)).trackedTeam;
      await editArchive(context, matchId, (envelope) => {
        envelope.payload.match_info.objectives = [
          // The titan of team 0 and the core of team 1 fell; a guardian of team 1 survived (0).
          { team: 0, team_objective_id: 9, destroyed_time_s: 900 },
          { team: 1, team_objective_id: 0, destroyed_time_s: 1500 },
          { team: 1, team_objective_id: 1, destroyed_time_s: 0 },
          // Lane 2 does not exist on the map: its objective is not listed.
          { team: 1, team_objective_id: 2, destroyed_time_s: 300 },
        ];
      });

      const view = replayOf(await context.replay.getReplay(matchId));

      expect(view.objectives).toHaveLength(26);
      // Team 0 then team 1, each in the order of the objective ids of the map.
      expect(MAP_OBJECTIVE_IDS).toHaveLength(13);
      const fallen = view.objectives.filter((objective) => objective.destroyedAtS !== null);
      expect(fallen.map((objective) => [objective.identity.kind, objective.destroyedAtS])).toEqual([
        ['titan', 900],
        ['core', 1500],
      ]);
      expect(fallen.map((objective) => objective.side)).toEqual(
        [0, 1].map((team) => (team === trackedTeam ? 'ally' : 'enemy')),
      );
      // The positions come from the layout (the core of team 0, the titan of team 1), moved from
      // the corner of the API's icon to the building...
      const core = view.objectives[0];
      expect(core).toMatchObject({ identity: { kind: 'core' }, destroyedAtS: null });
      expect(core?.position?.left).toBeCloseTo(0.44, 6);
      expect(core?.position?.top).toBeCloseTo(0.97, 6);
      const titan = view.objectives[13 + MAP_OBJECTIVE_IDS.indexOf(9)];
      expect(titan).toMatchObject({ identity: { kind: 'titan' } });
      expect(titan?.position?.left).toBeCloseTo(0.56, 6);
      expect(titan?.position?.top).toBeCloseTo(0.13, 6);
      // ... and the shrines are hand placed, so they have one even if the layout lacks them.
      const shrine = view.objectives.find((objective) => objective.identity.kind === 'shrine');
      expect(shrine?.position).not.toBeNull();
    });

    it('falls back from the minimap icon to the portrait, then to null', async () => {
      const matchId = firstMatch();
      const portraits = parseHeroAssets(FIXTURE_HERO_CATALOGUE);

      // A hero without a minimap icon shows its portrait: the fixture heroes are stripped of theirs.
      const portraitOnly = FIXTURE_HERO_CATALOGUE.map((hero) => ({
        ...hero,
        images: {
          icon_image_small: hero.images.icon_image_small,
          icon_image_small_webp: hero.images.icon_image_small_webp,
        },
      }));
      const context = await setUp(handlerWith([], portraitOnly));
      const view = replayOf(await context.replay.getReplay(matchId));
      for (const player of view.players) {
        const hero = portraits.find((candidate) => candidate.id === player.heroId);
        expect(player.heroName).toBe(hero?.name);
        expect(player.iconUrl).toBe(hero?.imageUrl);
      }
      expect(view.players.every((player) => player.iconUrl !== null)).toBe(true);

      // A hero with a minimap icon uses it.
      const trackedHeroId =
        view.players.find((player) => player.isTracked)?.heroId ??
        expect.unreachable('the tracked player is in the match');
      const minimapUrl = `${ASSET_IMAGE_ORIGIN}assets-api-res/images/heroes/minimap.png`;
      const withMinimap = portraitOnly.map((hero) =>
        hero.id === trackedHeroId
          ? { ...hero, images: { ...hero.images, minimap_image: minimapUrl } }
          : hero,
      );
      const minimapContext = await setUp(handlerWith([], withMinimap));
      const minimapView = replayOf(await minimapContext.replay.getReplay(matchId));
      for (const player of minimapView.players) {
        expect(player.iconUrl).toBe(
          player.heroId === trackedHeroId
            ? minimapUrl
            : portraits.find((candidate) => candidate.id === player.heroId)?.imageUrl,
        );
      }

      // A hero the catalogue lacks has neither a name nor an icon, and nor does any when it is down.
      const lacking = portraitOnly.filter((hero) => hero.id !== trackedHeroId);
      const lackingContext = await setUp(handlerWith([], lacking));
      const lackingView = replayOf(await lackingContext.replay.getReplay(matchId));
      for (const player of lackingView.players) {
        expect(player.heroName === null).toBe(player.heroId === trackedHeroId);
        expect(player.iconUrl === null).toBe(player.heroId === trackedHeroId);
      }
      const downContext = await setUp(handlerWith([heroesRequest().url]));
      const downView = replayOf(await downContext.replay.getReplay(matchId));
      expect(downView.map).not.toBeNull();
      for (const player of downView.players) {
        expect(player.heroName).toBeNull();
        expect(player.iconUrl).toBeNull();
      }
    });
  });
});
