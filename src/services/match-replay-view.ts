/**
 * The view of the replay of a match: where every player was each second, when they were dead, which
 * objectives had fallen and when the mid boss was killed, ready to be drawn on the minimap picture.
 *
 * `MatchReplayService` (`./match-replay.service`) reads what the replay is made of: the archive of
 * the match and the map and hero catalogues. This module only holds the types of what it answers, so
 * that they are the one contract with the page.
 *
 * Every time is in seconds since the start of the match. Teams are told relative to the tracked
 * player (`ally` / `enemy`), never by the numbers of the API, and every position is on the minimap
 * picture (see `../core/match-map/map-geometry`), so the interface never deals in world units. What a
 * catalogue cannot tell is `null` and never replaced by a made-up value.
 *
 * @packageDocumentation
 */
import type { MapLane } from '../core/deadlock-api/map.schema';
import type { RelativePoint } from '../core/match-map/map-geometry';
import type { ObjectiveIdentity } from '../core/match-map/map-objectives';
import type { ReplayCoverage, ReplayDeath } from '../core/match-map/match-replay';
import type { TeamIdentity } from '../core/match-map/team-identity';

/** The team of a player or of an objective, relative to the tracked player. */
export type Side = 'ally' | 'enemy';

/** One player of the replay. */
export interface ReplayViewPlayer {
  /** The slot of the player, from 1 to 12. */
  readonly slot: number;
  /** Whether the player is on the team of the tracked player. */
  readonly side: Side;
  /** The in-game identity of the team of the player (Hidden King or Archmother), which colours it. */
  readonly team: TeamIdentity;
  /** Whether this is the tracked player. */
  readonly isTracked: boolean;
  /** The hero the player played, an id of the hero list. */
  readonly heroId: number;
  /** The English name of the hero; `null` when the hero catalogue cannot be read or lacks the hero. */
  readonly heroName: string | null;
  /**
   * The icon of the hero on the map: its minimap icon, else its portrait; `null` when neither is
   * known (or the hero catalogue cannot be read).
   */
  readonly iconUrl: string | null;
  /** Whether the player has a readable path; without one, every position is `null`. */
  readonly hasPath: boolean;
  /**
   * The position of the player on the picture at each second: the index is the second, from 0 to
   * `durationS`. `null` while dead or unknown. Empty when the map is unavailable (`map` is `null`),
   * since there is then nothing to place the players on.
   */
  readonly positions: readonly (RelativePoint | null)[];
  /**
   * The health of the player at each second, in percent (0 to 100): the index is the second, from 0
   * to `durationS`. `null` while dead or unknown. Kept when the map is unavailable, since reading
   * the health does not need the map.
   */
  readonly health: readonly (number | null)[];
  /**
   * The deaths of the player, sorted by time, each with the slot of its killer when the archive
   * names one.
   */
  readonly deaths: readonly ReplayDeath[];
}

/** One objective of the map, standing or fallen. */
export interface ReplayViewObjective {
  /** Whether the objective belongs to the team of the tracked player. */
  readonly side: Side;
  /** The in-game identity of the team the objective belongs to. */
  readonly team: TeamIdentity;
  /** What the objective is (core, guardian, walker, titan, shrine or base guardian). */
  readonly identity: ObjectiveIdentity;
  /** Where it stands on the picture; `null` when the map is unavailable. */
  readonly position: RelativePoint | null;
  /** The second it was destroyed at; `null` when it stood until the end of the match. */
  readonly destroyedAtS: number | null;
}

/** What the map is drawn with. */
export interface ReplayMap {
  /** The link of the minimap picture, on the asset bucket. */
  readonly imageUrl: string;
  /** The zip lines, drawn on the picture. */
  readonly lanes: readonly MapLane[];
  /** Where the mid boss pit is on the picture. */
  readonly midBoss: RelativePoint;
}

/** One kill of the mid boss. */
export interface ReplayViewMidBossKill {
  /** The second of the match the mid boss was killed at. */
  readonly timeS: number;
  /** The side that killed it. */
  readonly killedBy: Side;
  /** The side that claimed the reward. */
  readonly claimedBy: Side;
  /** The in-game identity of the team that killed it. */
  readonly killedByTeam: TeamIdentity;
  /** The in-game identity of the team that claimed the reward. */
  readonly claimedByTeam: TeamIdentity;
}

/**
 * What the replay can be told about a match:
 * - `not_archived`: the match has no archive for the linked account, so there is nothing to replay;
 * - `unreadable`: its archive is gone or damaged, or its replay cannot be read;
 * - `replay`: the replay. `coverage` tells how many players the map can place (`all`, only the
 *   tracked one for an archive of the first format, or `none`), and `map` is `null` when the map
 *   asset could not be read (the page then says the map is unavailable).
 */
export type ReplayView =
  | { readonly kind: 'not_archived' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'replay';
      /** How long the match lasted, in seconds. */
      readonly durationS: number;
      /** The in-game identity of the team of the tracked player. */
      readonly trackedTeam: TeamIdentity;
      /** How many players can be placed on the map. */
      readonly coverage: ReplayCoverage;
      /** What the map is drawn with; `null` when the map asset could not be read. */
      readonly map: ReplayMap | null;
      /** The twelve players, sorted by slot. */
      readonly players: readonly ReplayViewPlayer[];
      /**
       * Every objective of the map (26: 13 for each team, team 0 first), the ones that stood
       * until the end with `destroyedAtS` `null`.
       */
      readonly objectives: readonly ReplayViewObjective[];
      /** The kills of the mid boss, sorted by time. */
      readonly midBossKills: readonly ReplayViewMidBossKill[];
      /**
       * The seconds the mid boss came back at after each kill, the ones after the end of the match
       * left out.
       */
      readonly midBossReturnsS: readonly number[];
    };
