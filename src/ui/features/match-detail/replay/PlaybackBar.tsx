/**
 * The playback bar of the map replay: the play / step / speed controls, the time slider, the three
 * titled tracks under the slider that put the match on the same time scale (objectives, Mid Boss
 * and deaths) and the legend that explains every icon. Every marker of the tracks seeks the replay
 * to its moment.
 *
 * Each kind of event has its own icon, and the colour of the icon is the colour of the team: the
 * shape never depends on the side. The tracks and the legend are built once per replay and never
 * re-render while it plays: only the cursor line that runs across the tracks moves with the clock.
 *
 * @packageDocumentation
 */
import { memo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ObjectiveKind } from '../../../../core/match-map/map-objectives';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import { Button } from '../../../components/Button';
import { formatGameTime } from '../analysis-format';
import { GameIcon } from './GameIcon';
import type { GameIconProps } from './GameIcon';
import { ObjectiveGlyph } from './ObjectiveGlyphs';
import { nextEvent, previousEvent } from './replay-model';
import type { ReplayData } from './replay-model';
import { TEAM_FILL } from './team-style';
import type { Playback, PlaybackSpeed } from './use-playback';

/** The speeds the bar offers. */
const SPEEDS: readonly PlaybackSpeed[] = [1, 4, 10];

/** Between the parts of the tooltip of a marker: "Walker · enemy · 12:34". */
const TITLE_SEPARATOR = ' · ';

/** The two teams, in the order the legend shows them. */
const TEAMS: readonly TeamIdentity[] = ['hidden_king', 'archmother'];

/** The objective kinds of the legend, one entry each (a Base Guardian shares the Guardian's). */
const LEGEND_OBJECTIVES: readonly ObjectiveKind[] = [
  'guardian',
  'walker',
  'titan',
  'core',
  'shrine',
];

/** The side of the icon of a marker and of the legend, in pixels: large enough to be read. */
const ICON_SIZE = 16;

/**
 * The name of the CSS custom property that holds the width of the title column. The slider and the
 * tracks are laid out in the same two-column grid and the cursor overlay starts after the same
 * column, so all three read their width from this one variable.
 */
const TITLE_COLUMN_VAR = '--replay-title-col';

/** The width of the title column (7 rem), set once as {@link TITLE_COLUMN_VAR} on the bar. */
const TITLE_COLUMN_WIDTH = '7rem';

/** The two-column grid (titles, then the time scale) shared by the slider and the tracks. */
const TITLE_GRID_CLASS = 'grid grid-cols-[var(--replay-title-col)_1fr]';

/** The height of a track: a little more than its icons, which are centred in it. */
const TRACK_HEIGHT_CLASS = 'h-7';

/** The thin line under a track (both of its cells), which separates it from the next one. */
const TRACK_SEPARATOR_CLASS = 'border-b border-border';

/** Props of {@link ObjectiveIcon}. */
interface ObjectiveIconProps {
  /** The kind of objective. */
  readonly kind: ObjectiveKind;
  /** The team that owns it, or `'neutral'` for the legend. */
  readonly team: TeamIdentity | 'neutral';
}

/**
 * The icon of one kind of objective: the picture of the game tinted by the team for a Guardian or
 * a Walker, a drawn glyph for a Titan, a Core or a Shrine. It is never drawn as destroyed: on the
 * tracks the marker stands for the moment the objective fell.
 *
 * @returns The icon, decorative (the button or the legend label names it).
 */
function ObjectiveIcon({ kind, team }: ObjectiveIconProps) {
  if (kind === 'titan' || kind === 'core' || kind === 'shrine') {
    // The Titan opens up here (the tracks have no base side), unlike the map, where it opens
    // towards its own base.
    return <ObjectiveGlyph kind={kind} size={ICON_SIZE} team={team} opensDown={false} decorative />;
  }
  return (
    <GameIcon
      // Guardians and base guardians share an icon.
      icon={kind === 'walker' ? 'walker' : 'guardian'}
      label={kind}
      size={ICON_SIZE}
      fallback="square"
      tint={team}
      decorative
    />
  );
}

/**
 * A decorative game icon of the tracks and the legend, at their size and tinted.
 *
 * @param props - The icon, the fallback shape and the tint.
 * @returns The icon.
 */
function TrackIcon(props: Pick<GameIconProps, 'icon' | 'tint'>) {
  return <GameIcon {...props} label="" size={ICON_SIZE} fallback="circle" decorative />;
}

/** Props of {@link PlaybackBar}. */
export interface PlaybackBarProps {
  /** The replay. */
  readonly view: ReplayData;
  /** The playback clock and its controls. */
  readonly playback: Playback;
  /** The moments the previous / next buttons jump between (see `stepEvents`), sorted. */
  readonly stepTimes: readonly number[];
}

/**
 * Where a moment stands along the tracks, as a percentage of the match.
 *
 * @param timeS - The moment.
 * @param durationS - The length of the match.
 * @returns The percentage, kept between 0 and 100.
 */
function percentOf(timeS: number, durationS: number): string {
  const ratio = durationS > 0 ? Math.min(Math.max(timeS / durationS, 0), 1) : 0;
  return `${String(ratio * 100)}%`;
}

/** Props of {@link Marker}. */
interface MarkerProps {
  /** The moment of the marker; a click seeks there. */
  readonly timeS: number;
  /** The length of the match. */
  readonly durationS: number;
  /** The tooltip, which is also the accessible name. */
  readonly title: string;
  /** Extra classes (the fade of the return of the Mid Boss). */
  readonly className?: string;
  /** The icon of the marker. */
  readonly children: ReactNode;
  /** Seek the replay. */
  readonly onSeek: (timeS: number) => void;
}

/**
 * One marker of a track: a small button holding an icon, placed at its moment and centred in the
 * height of its track.
 *
 * @returns The button.
 */
function Marker({ timeS, durationS, title, className = '', children, onSeek }: MarkerProps) {
  return (
    <button
      type="button"
      // Markers are mouse targets: the keyboard uses the event buttons, the slider and the section
      // keys.
      tabIndex={-1}
      title={title}
      aria-label={title}
      style={{ left: percentOf(timeS, durationS) }}
      className={[
        'absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center p-0',
        'focus-visible:outline-2',
        className,
      ].join(' ')}
      onClick={() => {
        onSeek(timeS);
      }}
    >
      {children}
    </button>
  );
}

/** Props of {@link Track}. */
interface TrackProps {
  /** Which track it is, for the tests and the styles. */
  readonly id: 'objectives' | 'midBoss' | 'deaths';
  /** The translated title, written in its own cell of the grid. */
  readonly title: string;
  /** The markers of the track. */
  readonly children: ReactNode;
}

/**
 * One track: its title in the fixed column and, beside it, the area its markers are placed in. Both
 * are cells of the grid of the tracks, so a title can never lie over a marker. Both carry the thin
 * line under the track, so that it runs the full width.
 *
 * @returns The two cells.
 */
function Track({ id, title, children }: TrackProps) {
  return (
    <>
      <p
        data-track-title={id}
        className={`flex items-center truncate pr-2 text-xs text-fg-muted ${TRACK_HEIGHT_CLASS} ${TRACK_SEPARATOR_CLASS}`}
      >
        {title}
      </p>
      <div data-track={id} className={`relative ${TRACK_HEIGHT_CLASS} ${TRACK_SEPARATOR_CLASS}`}>
        {children}
      </div>
    </>
  );
}

/** Props of the tracks. */
interface TracksProps {
  /** The replay. */
  readonly view: ReplayData;
  /** Seek the replay (stable between renders, so the tracks stay memoised). */
  readonly onSeek: (timeS: number) => void;
}

/**
 * The three tracks in a two-column grid (titles, then markers): the objectives that fell, the Mid
 * Boss kills and returns and the deaths of every player. Memoised on the replay, so it does not
 * draw again at every frame.
 */
const Tracks = memo(function Tracks({ view, onSeek }: TracksProps) {
  const { t } = useTranslation();
  const { durationS } = view;
  return (
    <div className={TITLE_GRID_CLASS}>
      <Track id="objectives" title={t('replay.tracks.objectives')}>
        {view.objectives.map((objective, index) =>
          objective.destroyedAtS === null ? null : (
            <Marker
              // The index keeps the key unique when two objectives of a kind fall together.
              key={`objective-${String(index)}`}
              timeS={objective.destroyedAtS}
              durationS={durationS}
              title={[
                t(`replay.objective.${objective.identity.kind}`),
                t(`replay.teams.${objective.team}`),
                formatGameTime(objective.destroyedAtS),
              ].join(TITLE_SEPARATOR)}
              onSeek={onSeek}
            >
              {/* The icon of the kind, in the colour of the team that lost it. */}
              <ObjectiveIcon kind={objective.identity.kind} team={objective.team} />
            </Marker>
          ),
        )}
      </Track>

      <Track id="midBoss" title={t('replay.tracks.midBoss')}>
        {/* A kill: the Mid Boss icon in the colour of the team that killed it. */}
        {view.midBossKills.map((kill) => (
          <Marker
            key={`kill-${String(kill.timeS)}`}
            timeS={kill.timeS}
            durationS={durationS}
            title={[
              t('replay.midBoss.kill', {
                killer: t(`replay.teams.${kill.killedByTeam}`),
                claimer: t(`replay.teams.${kill.claimedByTeam}`),
              }),
              formatGameTime(kill.timeS),
            ].join(TITLE_SEPARATOR)}
            onSeek={onSeek}
          >
            <TrackIcon icon="mid_boss" tint={kill.killedByTeam} />
          </Marker>
        ))}
        {/* The return of the Mid Boss: the same icon, neutral and faded, unlike a kill. */}
        {view.midBossReturnsS.map((returnS) => (
          <Marker
            key={`return-${String(returnS)}`}
            timeS={returnS}
            durationS={durationS}
            title={[t('replay.midBoss.returns'), formatGameTime(returnS)].join(TITLE_SEPARATOR)}
            className="opacity-50"
            onSeek={onSeek}
          >
            <TrackIcon icon="mid_boss" tint="neutral" />
          </Marker>
        ))}
      </Track>

      <Track id="deaths" title={t('replay.tracks.deaths')}>
        {/* Every death of every player: a skull in the colour of the team of the victim. */}
        {view.players.flatMap((player) =>
          player.deaths.map((death) => (
            <Marker
              key={`death-${String(player.slot)}-${String(death.timeS)}`}
              timeS={death.timeS}
              durationS={durationS}
              title={[
                player.heroName ?? t('timeline.deaths.unknownHero'),
                t(`replay.teams.${player.team}`),
                formatGameTime(death.timeS),
              ].join(TITLE_SEPARATOR)}
              onSeek={onSeek}
            >
              <TrackIcon icon="death" tint={player.team} />
            </Marker>
          )),
        )}
      </Track>
    </div>
  );
});

/** Props of {@link LegendEntry}. */
interface LegendEntryProps {
  /** The icon the entry shows, drawn in the neutral colour. */
  readonly children: ReactNode;
  /** What the icon means. */
  readonly label: string;
}

/**
 * One entry of the legend: an icon and its label.
 *
 * @returns The list item.
 */
function LegendEntry({ children, label }: LegendEntryProps) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className="flex items-center">
        {children}
      </span>
      <span>{label}</span>
    </li>
  );
}

/** Props of {@link TeamSwatch}. */
interface TeamSwatchProps {
  /** The team whose colour it shows. */
  readonly team: TeamIdentity;
  /** The name of the team. */
  readonly label: string;
}

/**
 * A colour swatch of the legend: the colour of a team and its name.
 *
 * @returns The swatch and the name.
 */
function TeamSwatch({ team, label }: TeamSwatchProps) {
  return (
    <span className="flex items-center gap-1">
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full ${TEAM_FILL[team]}`}
      />
      <span>{label}</span>
    </span>
  );
}

/**
 * The legend under the tracks: each icon once, in the neutral colour, then the line that says the
 * colour tells the team, with the two team colours. Memoised, it only draws again when the language
 * changes.
 */
const Legend = memo(function Legend() {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('replay.legend.title')}>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        {LEGEND_OBJECTIVES.map((kind) => (
          <LegendEntry key={kind} label={t(`replay.objective.${kind}`)}>
            <ObjectiveIcon kind={kind} team="neutral" />
          </LegendEntry>
        ))}
        <LegendEntry label={t('replay.legend.midBossKill')}>
          <TrackIcon icon="mid_boss" tint="neutral" />
        </LegendEntry>
        <LegendEntry label={t('replay.legend.midBossReturn')}>
          {/* Faded, as on the track. */}
          <span className="opacity-50">
            <TrackIcon icon="mid_boss" tint="neutral" />
          </span>
        </LegendEntry>
        <LegendEntry label={t('replay.legend.death')}>
          <TrackIcon icon="death" tint="neutral" />
        </LegendEntry>
        {/* The colour of an icon is the team's: one line, with both team colours. */}
        <li className="flex items-center gap-2">
          <span>{t('replay.legend.teamColour')}</span>
          {TEAMS.map((team) => (
            <TeamSwatch key={team} team={team} label={t(`replay.teams.${team}`)} />
          ))}
        </li>
      </ul>
    </div>
  );
});

/**
 * The playback bar.
 *
 * @returns The controls, the slider, the three tracks with the cursor line across them and the
 * legend.
 */
export function PlaybackBar({ view, playback, stepTimes }: PlaybackBarProps) {
  const { t } = useTranslation();
  const { timeS, playing, speed, seek, toggle, setSpeed } = playback;
  const second = Math.floor(timeS);
  const previous = previousEvent(stepTimes, timeS);
  const next = nextEvent(stepTimes, timeS);

  return (
    <div className="space-y-2" style={{ [TITLE_COLUMN_VAR]: TITLE_COLUMN_WIDTH } as CSSProperties}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          look="subtle"
          disabled={previous === null}
          aria-label={t('replay.controls.previousEvent')}
          onClick={() => {
            if (previous !== null) seek(previous);
          }}
        >
          ⏮
        </Button>
        <Button
          look="subtle"
          aria-label={t(playing ? 'replay.controls.pause' : 'replay.controls.play')}
          onClick={toggle}
        >
          {playing ? '⏸' : '▶'}
        </Button>
        <Button
          look="subtle"
          disabled={next === null}
          aria-label={t('replay.controls.nextEvent')}
          onClick={() => {
            if (next !== null) seek(next);
          }}
        >
          ⏭
        </Button>
        {SPEEDS.map((value) => (
          <Button
            key={value}
            look="subtle"
            aria-pressed={speed === value}
            aria-label={t('replay.controls.speed', { n: value })}
            onClick={() => {
              setSpeed(value);
            }}
          >
            ×{value}
          </Button>
        ))}
        <span className="ml-auto text-sm tabular-nums text-fg-muted">
          {t('replay.controls.time', {
            current: formatGameTime(second),
            total: formatGameTime(view.durationS),
          })}
        </span>
      </div>

      {/* The slider sits in the track column of the same grid as the tracks, so the thumb, the
          markers and the cursor line share one time scale; the title cell beside it stays
          empty. */}
      <div className={TITLE_GRID_CLASS}>
        <input
          type="range"
          min={0}
          max={view.durationS}
          step={1}
          value={second}
          aria-label={t('replay.controls.slider')}
          className="col-start-2 w-full accent-accent-bright"
          onChange={(event) => {
            seek(Number(event.target.value));
          }}
        />
      </div>

      {/* The tracks share the scale of the slider; only the cursor line moves. */}
      <div className="relative">
        <Tracks view={view} onSeek={seek} />
        {/* An overlay over the track column only (it starts after the title column), so the
            cursor line runs across the three tracks and never over a title. */}
        <div
          aria-hidden="true"
          style={{ left: `var(${TITLE_COLUMN_VAR})` }}
          className="pointer-events-none absolute inset-y-0 right-0"
        >
          <div
            data-testid="playback-cursor"
            style={{ left: percentOf(timeS, view.durationS) }}
            className="absolute inset-y-0 w-px bg-fg"
          />
        </div>
      </div>

      <Legend />
    </div>
  );
}
