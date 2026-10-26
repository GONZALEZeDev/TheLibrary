/**
 * The judgement of the tracked player's deaths: who was near them when they died, and whether the
 * death was avoidable.
 *
 * A death is avoidable when the player died alone, with no ally near, against at least
 * {@link AVOIDABLE_MIN_ENEMIES} enemies: a fight they should not have taken. Any other death killed
 * by an enemy hero is balanced. "Near" is within {@link NEARBY_DISTANCE} of where they died, alive
 * at the second of the death, read on the movement paths of the other players. An enemy killer
 * always counts among the enemies, wherever they stood: a hero who killed from afar still took part
 * in the fight. A death with no enemy hero killer is not judged at all: troopers or the environment
 * killed the player, or a teammate, or they killed themselves, or the killer is no player of the
 * match.
 *
 * The rule is an estimate: the paths only sample the players at intervals, and a player just
 * outside the distance may still have weighed in the fight.
 *
 * The other players' positions are only known when every player of the match has a readable path.
 * A format-1 archive holds the tracked player's path alone, and a path may be unreadable; then a
 * player who is not on the map may have been near, so no death is judged.
 *
 * @packageDocumentation
 */
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import { positionAt, readPlayerPaths } from '../match-detail/player-paths';
import type { PlayerPaths } from '../match-detail/player-paths';
import { findTrackedPlayer } from '../match-detail/pruning';
import { readTrackedDeaths } from '../match-detail/tracked-deaths';
import type { TrackedDeath } from '../match-detail/tracked-deaths';
import { AVOIDABLE_MIN_ENEMIES, NEARBY_DISTANCE } from './insights/thresholds';

/**
 * The verdict on a death killed by an enemy hero: `'avoidable'` when the player was alone against
 * several enemies, `'balanced'` otherwise.
 */
export type DeathVerdict = 'avoidable' | 'balanced';

/** The players near the tracked player when they died, by side; the tracked player is not counted. */
export interface NearbyCount {
  /** The enemies near, the killer always among them when an enemy hero killed. */
  readonly enemies: number;
  /** The teammates near. */
  readonly allies: number;
}

/** One death of the tracked player, with who was near and the verdict. */
export interface JudgedDeath extends TrackedDeath {
  /** Who was near when they died; `null` when the positions of the other players are not known. */
  readonly nearby: NearbyCount | null;
  /**
   * The verdict; `null` when no enemy hero killed them (troopers, the environment, a teammate,
   * themselves) or when who was near is not known.
   */
  readonly verdict: DeathVerdict | null;
}

/** The judgement of the tracked player's deaths in one match. */
export interface JudgedDeaths {
  /**
   * The deaths, sorted from the earliest; none for a player who never died; `null` when the death
   * details are incomplete (the deaths are unknown then, rather than fewer).
   */
  readonly deaths: readonly JudgedDeath[] | null;
  /**
   * Whether the positions of the other players are known: every player of the match has a readable
   * path. When they are not, each death has no `nearby` and no `verdict`.
   */
  readonly positionsKnown: boolean;
}

/**
 * Tell whether an enemy hero killed the tracked player: the one test of the killer that both the
 * count of who was near and the verdict use.
 *
 * The killer's team is read on their path. Slot 0 is no hero (troopers, the environment); a killer
 * of the tracked player's own team, or the tracked player themselves, is no enemy; and a killer slot
 * with no path is no player of the match whose side is known.
 *
 * @param death - The death.
 * @param paths - The movement paths of the match.
 * @param trackedSlot - The slot of the tracked player.
 * @param trackedTeam - The team of the tracked player.
 * @returns `true` when the killer is a player of the other team.
 */
export function hasEnemyHeroKiller(
  death: TrackedDeath,
  paths: PlayerPaths,
  trackedSlot: number,
  trackedTeam: number,
): boolean {
  if (death.killerSlot === 0 || death.killerSlot === trackedSlot) {
    return false;
  }
  const killer = paths.bySlot.get(death.killerSlot);
  return killer !== undefined && killer.team !== trackedTeam;
}

/**
 * Count the players near the tracked player when they died, by side.
 *
 * A player is near when they are alive at the second of the death and within
 * {@link NEARBY_DISTANCE} of where the tracked player died (a player exactly at the distance is
 * near). The killer, when an enemy hero killed (see {@link hasEnemyHeroKiller}), counts once among
 * the enemies, near or not, alive or not; any other killer is counted like any other player.
 *
 * @param death - The death.
 * @param paths - The movement paths of the match.
 * @param trackedSlot - The slot of the tracked player, who is never counted.
 * @param trackedTeam - The team of the tracked player: a player of it is an ally, any other an enemy.
 * @returns The count of the enemies and of the allies near.
 */
export function nearbyAt(
  death: TrackedDeath,
  paths: PlayerPaths,
  trackedSlot: number,
  trackedTeam: number,
): NearbyCount {
  // Only an enemy hero killer is counted ahead of the others: none for any other death.
  const killerSlot = hasEnemyHeroKiller(death, paths, trackedSlot, trackedTeam)
    ? death.killerSlot
    : null;
  let enemies = killerSlot === null ? 0 : 1;
  let allies = 0;
  for (const path of paths.bySlot.values()) {
    // The tracked player is not near themselves, and the killer is already counted.
    if (path.slot === trackedSlot || path.slot === killerSlot) {
      continue;
    }
    // A dead player, or one whose path does not reach that second, has no position: not near.
    const position = positionAt(path, death.timeS);
    if (position === null) {
      continue;
    }
    const distance = Math.hypot(position.x - death.position.x, position.y - death.position.y);
    if (distance > NEARBY_DISTANCE) {
      continue;
    }
    if (path.team === trackedTeam) {
      allies += 1;
    } else {
      enemies += 1;
    }
  }
  return { enemies, allies };
}

/**
 * Give the verdict on a death from who was near.
 *
 * @param killedByEnemyHero - Whether an enemy hero killed the player (see
 *   {@link hasEnemyHeroKiller}).
 * @param nearby - Who was near, or `null` when it is not known.
 * @returns `'avoidable'` when no ally was near and at least {@link AVOIDABLE_MIN_ENEMIES} enemies
 *   were, `'balanced'` otherwise; `null` when no enemy hero killed the player or when who was near
 *   is not known.
 */
export function verdictOf(
  killedByEnemyHero: boolean,
  nearby: NearbyCount | null,
): DeathVerdict | null {
  if (!killedByEnemyHero || nearby === null) {
    return null;
  }
  return nearby.allies === 0 && nearby.enemies >= AVOIDABLE_MIN_ENEMIES ? 'avoidable' : 'balanced';
}

/**
 * Judge each death of the tracked player in an archived match.
 *
 * The paths are read once for the whole match. The positions of the other players are known when
 * every player of `match_info.players` (twelve in a regular match: the count is read, not assumed)
 * has a readable path; otherwise the deaths are kept, with no `nearby` and no `verdict`.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The judged deaths, and whether the positions are known.
 * @throws AppError of kind `invalid_payload` when a reader refuses the archive: the tracked player
 *   is missing (or ambiguous, or not playing Paige), or a field of their deaths or of the paths is
 *   not what is expected. The error is the reader's, unchanged.
 */
export function judgeDeaths(envelope: ArchiveEnvelope): JudgedDeaths {
  const { playerSlot, team } = findTrackedPlayer(envelope.payload, envelope.prunedForAccountId);
  const deaths = readTrackedDeaths(envelope);
  // Read even when the deaths are unknown: whether the positions are known is told all the same.
  const paths = readPlayerPaths(envelope);
  const knownPaths =
    paths !== null &&
    envelope.payload.match_info.players.every((player) => paths.bySlot.has(player.player_slot))
      ? paths
      : null;
  const judged =
    deaths?.map((death): JudgedDeath => {
      // Without the positions, neither who was near nor the side of the killer is known.
      if (knownPaths === null) {
        return { ...death, nearby: null, verdict: null };
      }
      const nearby = nearbyAt(death, knownPaths, playerSlot, team);
      const killedByEnemyHero = hasEnemyHeroKiller(death, knownPaths, playerSlot, team);
      return { ...death, nearby, verdict: verdictOf(killedByEnemyHero, nearby) };
    }) ?? null;
  return { deaths: judged, positionsKnown: knownPaths !== null };
}

/**
 * Count the avoidable deaths of a match.
 *
 * @param judged - The judged deaths of the match.
 * @returns The count of the deaths whose verdict is `'avoidable'`: `0` for a player who never died
 *   or never died avoidably; `null` when the deaths are unknown or the positions are not known, as
 *   any death may have been avoidable then.
 */
export function avoidableDeathCount(judged: JudgedDeaths): number | null {
  if (judged.deaths === null || !judged.positionsKnown) {
    return null;
  }
  return judged.deaths.filter((death) => death.verdict === 'avoidable').length;
}
