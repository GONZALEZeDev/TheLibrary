/**
 * The strip of the twelve players at the top of the replay: each one's hero portrait in the colour
 * of their team's game identity, with their live health, or the countdown to their respawn.
 *
 * The strip never changes size: each team always has six slots (an empty placeholder fills a
 * missing player), and a slot keeps the same height whether it shows a bar, a countdown or nothing.
 * The statuses are computed once per whole second, and a slot re-renders only when what it shows
 * changes.
 *
 * @packageDocumentation
 */

import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import type { ReplayViewPlayer } from '../../../../services/match-replay-view';
import { GameIcon } from './GameIcon';
import { playerStatusAt, type PlayerStatus, type ReplayData } from './replay-model';
import { TEAM_FILL, TEAM_LOGO, TEAM_TEXT } from './team-style';

/** How many players a team has: the slots of a group, filled or not. */
const SLOTS_PER_TEAM = 6;

/** The side of the Patron logo in a group header, in pixels. */
const LOGO_SIZE = 18;

/** The separator of the parts of a slot's accessible label. */
const LABEL_SEPARATOR = ' · ';

/** The sizes shared by a slot and its placeholder, so that both take the same room. */
const SLOT_BOX = 'w-14';

/** The props of {@link PlayersStrip}. */
export interface PlayersStripProps {
  /** The replay. */
  readonly view: ReplayData;
  /** The moment shown, in seconds; may be fractional. */
  readonly timeS: number;
}

/** The props of one slot: primitives and the (stable) player, so that `memo` can compare them. */
interface SlotProps {
  /** The player of the slot. */
  readonly player: ReplayViewPlayer;
  /** Alive or dead. */
  readonly kind: PlayerStatus['kind'];
  /** The health in whole percent while alive; `null` when dead or without health data. */
  readonly percent: number | null;
  /** The wait left in whole seconds while dead; `null` when alive or unknown. */
  readonly respawnInS: number | null;
}

/**
 * One slot: the portrait inside a team-coloured frame, then the health bar or the countdown. The
 * tracked player has a second ring around the frame, and an enemy frame is dashed, so that neither
 * is told by its colour alone.
 *
 * @returns The slot.
 */
const PlayerSlot = memo(function PlayerSlot({ player, kind, percent, respawnInS }: SlotProps) {
  const { t } = useTranslation();
  const name = player.heroName ?? t('timeline.deaths.unknownHero');
  const dead = kind === 'dead';
  const countdown = respawnInS === null ? null : t('replay.strip.respawnsIn', { s: respawnInS });
  const healthText = percent === null ? null : t('replay.strip.health', { percent });
  // The accessible label: the hero, the team, then what the slot shows (health or countdown).
  const label = [
    name,
    t(`replay.teams.${player.team}`),
    ...(dead ? [t('replay.strip.dead'), countdown] : [healthText]),
  ]
    .filter((part) => part !== null)
    .join(LABEL_SEPARATOR);
  return (
    <li
      aria-label={label}
      data-tracked={player.isTracked ? 'true' : undefined}
      className={`flex flex-col items-center gap-1 ${SLOT_BOX}`}
    >
      <div
        // The frame: the team colour as text colour, so that the border follows it.
        className={`flex size-10 items-center justify-center overflow-hidden rounded-full border-2 ${
          TEAM_TEXT[player.team]
        } border-current ${player.side === 'enemy' ? 'border-dashed' : ''} ${
          player.isTracked ? 'ring-2 ring-fg ring-offset-2 ring-offset-bg' : ''
        } ${dead ? 'grayscale opacity-50' : ''}`}
      >
        {player.iconUrl === null ? (
          // No icon: a plain disc of the team colour with the initial of the hero.
          <span
            aria-hidden="true"
            className={`flex size-full items-center justify-center text-sm font-semibold text-bg ${
              TEAM_FILL[player.team]
            }`}
          >
            {name.charAt(0).toUpperCase()}
          </span>
        ) : (
          <img src={player.iconUrl} alt="" className="size-full object-cover" />
        )}
      </div>
      {/* A fixed-height line: a bar, a countdown or nothing, so the slots stay aligned. */}
      <div className="flex h-4 w-full items-center justify-center text-xs text-fg-muted">
        {!dead && percent !== null && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg/15">
            <div
              role="progressbar"
              aria-label={t('replay.strip.health', { percent })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className={`h-full ${TEAM_FILL[player.team]}`}
              style={{ width: `${String(percent)}%` }}
            />
          </div>
        )}
        {dead && countdown}
      </div>
    </li>
  );
});

/**
 * One group of six: a header (Patron logo, team name, the tag of the tracked team) and its slots.
 *
 * @returns The group.
 */
function TeamGroup({
  team,
  isYours,
  players,
  statuses,
}: {
  readonly team: TeamIdentity;
  readonly isYours: boolean;
  readonly players: readonly ReplayViewPlayer[];
  readonly statuses: ReadonlyMap<number, PlayerStatus>;
}) {
  const { t } = useTranslation();
  const teamName = t(`replay.teams.${team}`);
  // Missing players leave an empty placeholder, so a group always takes six slots.
  const placeholders = Math.max(0, SLOTS_PER_TEAM - players.length);
  return (
    <div className="flex flex-col gap-2">
      <h3 className={`flex items-center gap-2 text-sm font-semibold ${TEAM_TEXT[team]}`}>
        <GameIcon
          icon={TEAM_LOGO[team]}
          label={teamName}
          size={LOGO_SIZE}
          fallback="circle"
          decorative
        />
        <span className={TEAM_TEXT[team]}>{teamName}</span>
        {isYours && (
          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs font-normal text-fg-muted">
            {t('replay.teams.yours')}
          </span>
        )}
      </h3>
      <ul className="flex gap-1">
        {players.slice(0, SLOTS_PER_TEAM).map((player) => {
          const status = statuses.get(player.slot);
          return (
            <PlayerSlot
              key={player.slot}
              player={player}
              kind={status?.kind ?? 'alive'}
              percent={
                status?.kind === 'alive' && status.healthPercent !== null
                  ? Math.round(status.healthPercent)
                  : null
              }
              respawnInS={status?.kind === 'dead' ? status.respawnInS : null}
            />
          );
        })}
        {Array.from({ length: placeholders }, (_, index) => (
          <li key={`empty-${String(index)}`} aria-hidden="true" className={SLOT_BOX} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The strip of the players: two groups of six, the tracked team first.
 *
 * @returns The strip.
 */
export function PlayersStrip({ view, timeS }: PlayersStripProps) {
  const { t } = useTranslation();
  // The statuses change at most once per whole second: the health is read by the second.
  const second = Math.floor(timeS);
  const statuses = useMemo(
    () => new Map(view.players.map((player) => [player.slot, playerStatusAt(player, second)])),
    [view.players, second],
  );
  const otherTeam: TeamIdentity = view.trackedTeam === 'hidden_king' ? 'archmother' : 'hidden_king';
  return (
    <section
      aria-label={t('replay.strip.title')}
      className="flex flex-wrap justify-center gap-x-8 gap-y-4"
    >
      {[view.trackedTeam, otherTeam].map((team) => (
        <TeamGroup
          key={team}
          team={team}
          isYours={team === view.trackedTeam}
          players={view.players.filter((player) => player.team === team).sort(bySlot)}
          statuses={statuses}
        />
      ))}
    </section>
  );
}

/**
 * Order players by slot.
 *
 * @param first - A player.
 * @param second - Another player.
 * @returns A negative number when `first` comes before `second`.
 */
function bySlot(first: ReplayViewPlayer, second: ReplayViewPlayer): number {
  return first.slot - second.slot;
}
