/**
 * The view of the timeline tab of the match page: the souls of the tracked player over the match
 * against their lane opponents, the phases, the kills, the purchases and the deaths of the player
 * with who was near them.
 *
 * `MatchTimelineService` (`./match-timeline.service`) reads what the tab is made of: the archive of
 * the match, its detail state and the hero and item catalogues. This module only holds the types of
 * what it answers, so that they are the one contract with the page.
 *
 * Every time is in seconds since the start of the match. What the archive or a catalogue cannot
 * tell is told as `null` and never replaced by a made-up value: an unknown is not a zero.
 *
 * @packageDocumentation
 */
import type { DeathVerdict } from '../core/analysis/avoidable-deaths';
import type { Phase } from '../core/analysis/phases';

/** One point of a souls line: the souls of a player at a time of the match. */
export interface SoulsPoint {
  /** The time, in seconds since the start of the match. */
  readonly timeS: number;
  /** The souls at that time (the cumulative `net_worth`). */
  readonly souls: number;
}

/**
 * Who killed the tracked player: a hero, or the world (troopers, the environment: slot `0` in the
 * archive).
 */
export type TimelineKiller =
  | {
      readonly kind: 'hero';
      /**
       * The hero the killer played, an id of the hero list; `null` when the archive names a killer
       * slot that no player of the match has (the death is still listed, by an unknown hero).
       */
      readonly heroId: number | null;
      /**
       * The English name of the hero, or `null` when the hero catalogue cannot be read or does not
       * know the hero, or when the hero is not known: the page then writes "a hero".
       */
      readonly name: string | null;
    }
  | { readonly kind: 'world' };

/** One kill of a hero by the tracked player. */
export interface TimelineKill {
  /** When the victim died, in seconds since the start of the match. */
  readonly timeS: number;
  /** The hero the tracked player killed. */
  readonly victim: {
    /**
     * The hero the victim played, an id of the hero list; `null` when the archive names a victim
     * slot that no player of the match has.
     */
    readonly heroId: number | null;
    /**
     * The English name of the hero, or `null` when the hero catalogue cannot be read or does not
     * know the hero, or when the hero is not known: the page then writes "a hero".
     */
    readonly name: string | null;
  };
}

/** One death of the tracked player, with who was near and the verdict. */
export interface TimelineDeath {
  /** When the player died, in seconds since the start of the match. */
  readonly timeS: number;
  /** Who killed them. */
  readonly killer: TimelineKiller;
  /** How long the killer took to kill them, in seconds; `null` when the archive does not say. */
  readonly timeToKillS: number | null;
  /**
   * The enemies near them when they died, the killer always counted when an enemy hero killed;
   * `null` when the positions of the other players are not known.
   */
  readonly enemiesNear: number | null;
  /** The teammates near them when they died; `null` when the positions are not known. */
  readonly alliesNear: number | null;
  /**
   * `'avoidable'` when they died alone against several enemies, `'balanced'` for any other death
   * by an enemy hero; `null` for any other death (by the world, a teammate, themselves), or when
   * the positions are not known.
   */
  readonly verdict: DeathVerdict | null;
}

/** One purchase of a shop item by the tracked player. */
export interface TimelinePurchase {
  /** When the item was bought, in seconds since the start of the match. */
  readonly timeS: number;
  /** The asset id of the item. */
  readonly itemId: number;
  /**
   * The English name of the item: the catalogue's, or its class name made readable when the
   * catalogue has the item but no name for it; `null` when the item catalogue cannot be read or
   * does not know the item (the archive holds the id of an item only, never its class name).
   */
  readonly name: string | null;
  /** The image of the item on the asset bucket, or `null` when it has none or is unknown. */
  readonly imageUrl: string | null;
}

/**
 * Whether the positions of the other players are in the archive, which the players near each death
 * are read from:
 * - `known`: every player of the match has a readable path;
 * - `missing_refresh_scheduled`: they are not, the archive is one written before the paths of every
 *   player were kept, and the match is recent enough for the next synchronisation to download it
 *   again;
 * - `missing`: they are not, and no download will bring them (the match is too old, the archive
 *   was already downloaded again, or the API did not send them).
 */
export type TimelinePositions = 'known' | 'missing' | 'missing_refresh_scheduled';

/** One phase of the match as played: where its shaded band starts and ends. */
export interface TimelinePhase {
  /** The phase. */
  readonly phase: Phase;
  /** When it starts, in seconds since the start of the match. */
  readonly startS: number;
  /** When it ends, in seconds since the start of the match (the end of the match for the last). */
  readonly endS: number;
}

/** The souls lines of the chart. */
export interface TimelineSouls {
  /**
   * The souls of the tracked player at each of their snapshots, from `(0, 0)` at the start of the
   * match.
   */
  readonly you: readonly SoulsPoint[];
  /**
   * The mean souls of their lane opponents at the same times; `null` when they have no lane
   * opponent, or when the souls of one of them are not known at one of those times.
   */
  readonly opponents: readonly SoulsPoint[] | null;
  /** How many lane opponents the mean is made of (`0` when the player has no lane). */
  readonly opponentCount: number;
}

/**
 * What the timeline tab of the match page shows: a state that says there is nothing to show, or
 * the timeline.
 *
 * What the timeline tab can be told about a match:
 * - `not_archived`: there is nothing to show. No account is linked, or the detail of the match is
 *   not archived;
 * - `unreadable`: the archive of the match is gone or damaged, or what the timeline reads in it
 *   cannot be read. Like the other tabs, this view only has nothing to show and does not reset the
 *   match;
 * - `timeline`: the timeline. It needs no projection, so it is there whether or not the analysis
 *   has run.
 */
export type TimelineTabView =
  | { readonly kind: 'not_archived' }
  | { readonly kind: 'unreadable' }
  | {
      readonly kind: 'timeline';
      /** The length of the match, in seconds: the end of the time axis. */
      readonly durationS: number;
      /** The phases the match reached, in the order of the match. */
      readonly phases: readonly TimelinePhase[];
      /** The souls of the player and of their lane opponents. */
      readonly souls: TimelineSouls;
      /**
       * The heroes the tracked player killed, sorted from the earliest; `null` when the kills are
       * unknown (the death detail of some player of the match is incomplete).
       */
      readonly kills: readonly TimelineKill[] | null;
      /** The shop items the player bought, sorted by time (one entry per purchase). */
      readonly purchases: readonly TimelinePurchase[];
      /**
       * The deaths of the player, sorted from the earliest; none for a player who never died;
       * `null` when their death detail is incomplete.
       */
      readonly deaths: readonly TimelineDeath[] | null;
      /**
       * How many of the deaths were avoidable; `null` when the deaths are unknown or the positions
       * are not known, as any death may have been avoidable then.
       */
      readonly avoidableCount: number | null;
      /** Whether the players near each death are known, see {@link TimelinePositions}. */
      readonly positions: TimelinePositions;
    };
