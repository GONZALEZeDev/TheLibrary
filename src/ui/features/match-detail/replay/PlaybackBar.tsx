/**
 * The playback bar of the map replay: the play / step / speed controls, the time slider, the four
 * titled tracks under the slider that put the match on the same time scale (objectives, Mid Boss,
 * deaths and the fixed game schedule) and the legend that explains every marker. Every marker of
 * the tracks seeks the replay to its moment.
 *
 * The tracks and the legend are built once per replay and never re-render while it plays: only the
 * cursor line that runs across the tracks moves with the clock.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { memo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GAME_SCHEDULE,
  scheduleOccurrences,
  TROOPER_WAVES,
} from '../../../../core/match-map/game-schedule';
import type { ScheduleOccurrence } from '../../../../core/match-map/game-schedule';
import type { TeamIdentity } from '../../../../core/match-map/team-identity';
import { Button } from '../../../components/Button';
import { formatGameTime } from '../analysis-format';
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

/** The shape of a marker. The side is also told by the shape, never by the colour alone. */
type MarkerShape = 'round' | 'diamond' | 'square' | 'tick' | 'hollow';

/**
 * The classes that draw each shape, on the tracks and in the legend alike. A diamond is a turned
 * square; a tick is a thin bar; a hollow marker is a ring that the colour classes only outline.
 */
const SHAPE_CLASS: Readonly<Record<MarkerShape, string>> = {
  round: 'size-2.5 rounded-full',
  diamond: 'size-2.5 rotate-45',
  square: 'size-2.5',
  tick: 'h-3.5 w-1 rounded-sm',
  hollow: 'size-2.5 rounded-full border-2',
};

/** The colour of the neutral markers (the scheduled events, the return of the Mid Boss). */
const NEUTRAL_FILL = 'bg-fg-muted';

/** The outline of the hollow marker of the Mid Boss return. */
const NEUTRAL_RING = 'border-fg-muted';

/** The width of the title column of the tracks (7 rem); the cursor overlay starts after it. */
const TITLE_COLUMN_CLASS = 'grid-cols-[7rem_1fr]';

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
  /** The shape of the marker. */
  readonly shape: MarkerShape;
  /** The colour classes that draw the marker. */
  readonly colorClass: string;
  /** Seek the replay. */
  readonly onSeek: (timeS: number) => void;
}

/**
 * One marker of a track: a small button placed at its moment and centred in the height of its
 * track.
 *
 * @returns The button.
 */
function Marker({ timeS, durationS, title, shape, colorClass, onSeek }: MarkerProps) {
  return (
    <button
      type="button"
      // Markers are mouse targets: the keyboard uses the event buttons, the slider and the section
      // keys.
      tabIndex={-1}
      title={title}
      aria-label={title}
      data-shape={shape}
      style={{ left: percentOf(timeS, durationS) }}
      className={[
        'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-0 focus-visible:outline-2',
        SHAPE_CLASS[shape],
        colorClass,
      ].join(' ')}
      onClick={() => {
        onSeek(timeS);
      }}
    />
  );
}

/** Props of {@link Span}. */
interface SpanProps {
  /** Where the span starts, in seconds; a click seeks there. */
  readonly fromS: number;
  /** Where the span ends, in seconds; clipped to the match. */
  readonly toS: number;
  /** The length of the match. */
  readonly durationS: number;
  /** The tooltip, which is also the accessible name. */
  readonly title: string;
  /** Which edge of its track the span stands on, so it never covers the markers in the middle. */
  readonly edge: 'top' | 'bottom';
  /** The classes that draw the span. */
  readonly className: string;
  /** Seek the replay. */
  readonly onSeek: (timeS: number) => void;
}

/**
 * A stretch of the match (the rift, a stretch of trooper waves): a thin bar between two moments.
 *
 * @returns The button.
 */
function Span({ fromS, toS, durationS, title, edge, className, onSeek }: SpanProps) {
  const endS = Math.min(toS, durationS);
  const widthRatio = durationS > 0 ? Math.max(endS - fromS, 0) / durationS : 0;
  return (
    <button
      type="button"
      // Markers are mouse targets: the keyboard uses the event buttons, the slider and the section
      // keys.
      tabIndex={-1}
      title={title}
      aria-label={title}
      style={{ left: percentOf(fromS, durationS), width: `${String(widthRatio * 100)}%` }}
      className={['absolute h-1.5 p-0', edge === 'top' ? 'top-0' : 'bottom-0', className].join(' ')}
      onClick={() => {
        onSeek(fromS);
      }}
    />
  );
}

/** Props of {@link Track}. */
interface TrackProps {
  /** Which track it is, for the tests and the styles. */
  readonly id: 'objectives' | 'midBoss' | 'deaths' | 'schedule';
  /** The translated title, written in its own cell of the grid. */
  readonly title: string;
  /** The height class of the track, large enough for its markers. */
  readonly heightClass: string;
  /** The markers of the track. */
  readonly children: ReactNode;
}

/**
 * One track: its title in the fixed column and, beside it, the area its markers are placed in. Both
 * are cells of the grid of the tracks, so a title can never lie over a marker.
 *
 * @returns The two cells.
 */
function Track({ id, title, heightClass, children }: TrackProps) {
  return (
    <>
      <p data-track-title={id} className="self-center truncate pr-2 text-xs text-fg-muted">
        {title}
      </p>
      <div data-track={id} className={`relative ${heightClass}`}>
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
 * The tooltip of a scheduled event: its name, its time and, when it comes back by itself, how long
 * it takes.
 *
 * @param occurrence - The occurrence.
 * @param t - Translation function.
 * @returns The tooltip.
 */
function scheduleTitle(occurrence: ScheduleOccurrence, t: TFunction): string {
  const parts = [t(`replay.schedule.${occurrence.kind}`), formatGameTime(occurrence.timeS)];
  // Only a one-off entry has a respawn; the table holds it, so the tooltip never invents one.
  const entry = GAME_SCHEDULE.find(
    (candidate) => candidate.type === 'once' && candidate.kind === occurrence.kind,
  );
  if (entry?.type === 'once' && entry.respawnS !== null) {
    parts.push(t('replay.schedule.respawn', { time: formatGameTime(entry.respawnS) }));
  }
  return parts.join(TITLE_SEPARATOR);
}

/**
 * The four tracks in a two-column grid (titles, then markers): the objectives that fell, the Mid
 * Boss kills and returns, the deaths of every player and the game schedule. Memoised on the replay,
 * so it does not draw again at every frame.
 */
const Tracks = memo(function Tracks({ view, onSeek }: TracksProps) {
  const { t } = useTranslation();
  const { durationS } = view;
  return (
    <div className={`grid gap-y-1 ${TITLE_COLUMN_CLASS}`}>
      <Track id="objectives" title={t('replay.tracks.objectives')} heightClass="h-6">
        {view.objectives.map((objective, index) =>
          objective.destroyedAtS === null ? null : (
            <Marker
              // The index keeps the key unique when two objectives of a kind fall together.
              key={`objective-${String(index)}`}
              timeS={objective.destroyedAtS}
              durationS={durationS}
              title={[
                t(`replay.objective.${objective.identity.kind}`),
                t(`replay.side.${objective.side}`),
                formatGameTime(objective.destroyedAtS),
              ].join(TITLE_SEPARATOR)}
              // The colour is the team's; the diamond is the non-colour cue of the other side.
              shape={objective.side === 'enemy' ? 'diamond' : 'square'}
              colorClass={TEAM_FILL[objective.team]}
              onSeek={onSeek}
            />
          ),
        )}
      </Track>

      <Track id="midBoss" title={t('replay.tracks.midBoss')} heightClass="h-6">
        {/* A kill is filled with the colour of the team that killed the Mid Boss. */}
        {view.midBossKills.map((kill) => (
          <Marker
            key={`kill-${String(kill.timeS)}`}
            timeS={kill.timeS}
            durationS={durationS}
            title={[
              t('replay.midBoss.kill', {
                killer: t(`replay.team.${kill.killedBy}`),
                claimer: t(`replay.team.${kill.claimedBy}`),
              }),
              formatGameTime(kill.timeS),
            ].join(TITLE_SEPARATOR)}
            shape="round"
            colorClass={TEAM_FILL[kill.killedByTeam]}
            onSeek={onSeek}
          />
        ))}
        {/* The return of the Mid Boss: a hollow neutral ring, to tell it from the kill. */}
        {view.midBossReturnsS.map((returnS) => (
          <Marker
            key={`return-${String(returnS)}`}
            timeS={returnS}
            durationS={durationS}
            title={[t('replay.midBoss.returns'), formatGameTime(returnS)].join(TITLE_SEPARATOR)}
            shape="hollow"
            colorClass={NEUTRAL_RING}
            onSeek={onSeek}
          />
        ))}
      </Track>

      <Track id="deaths" title={t('replay.tracks.deaths')} heightClass="h-6">
        {/* Every death of every player: a thin tick for an ally, a diamond for an enemy. */}
        {view.players.flatMap((player) =>
          player.deaths.map((death) => (
            <Marker
              key={`death-${String(player.slot)}-${String(death.timeS)}`}
              timeS={death.timeS}
              durationS={durationS}
              title={[
                player.heroName ?? t('timeline.deaths.unknownHero'),
                t(`replay.side.${player.side}`),
                formatGameTime(death.timeS),
              ].join(TITLE_SEPARATOR)}
              shape={player.side === 'enemy' ? 'diamond' : 'tick'}
              colorClass={TEAM_FILL[player.team]}
              onSeek={onSeek}
            />
          )),
        )}
      </Track>

      {/* Taller than the others: the rift and the waves are bars on its edges, the events between. */}
      <Track id="schedule" title={t('replay.tracks.schedule')} heightClass="h-9">
        {scheduleOccurrences(durationS).map((occurrence) =>
          occurrence.untilS === null ? (
            <Marker
              key={`${occurrence.kind}-${String(occurrence.timeS)}`}
              timeS={occurrence.timeS}
              durationS={durationS}
              title={scheduleTitle(occurrence, t)}
              shape="square"
              colorClass={NEUTRAL_FILL}
              onSeek={onSeek}
            />
          ) : (
            // A window (the rift) is a span, clipped when the match ends inside it.
            <Span
              key={`${occurrence.kind}-${String(occurrence.timeS)}`}
              fromS={occurrence.timeS}
              toS={occurrence.untilS}
              durationS={durationS}
              title={scheduleTitle(occurrence, t)}
              edge="top"
              className="bg-secondary"
              onSeek={onSeek}
            />
          ),
        )}
        {/* The trooper waves: a stretch lasts until the next one starts, or until the match ends. */}
        {TROOPER_WAVES.map((stretch, index) =>
          stretch.fromS >= durationS ? null : (
            <Span
              key={`troopers-${String(stretch.fromS)}`}
              fromS={stretch.fromS}
              toS={TROOPER_WAVES[index + 1]?.fromS ?? durationS}
              durationS={durationS}
              title={t('replay.schedule.troopers', { s: stretch.everyS })}
              edge="bottom"
              // The stretches alternate in shade, so that two neighbours do not merge into one.
              className={index % 2 === 0 ? 'bg-border' : 'bg-fg-muted/40'}
              onSeek={onSeek}
            />
          ),
        )}
      </Track>
    </div>
  );
});

/** Props of {@link LegendEntry}. */
interface LegendEntryProps {
  /** The swatches that show the marker, drawn with the same shape and colour as on the track. */
  readonly children: ReactNode;
  /** What the marker means. */
  readonly label: string;
}

/**
 * One entry of the legend: the swatches of a marker and its label.
 *
 * @returns The list item.
 */
function LegendEntry({ children, label }: LegendEntryProps) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden="true" className="flex items-center gap-1">
        {children}
      </span>
      <span>{label}</span>
    </li>
  );
}

/** Props of {@link Swatch}. */
interface SwatchProps {
  /** The shape of the marker it stands for. */
  readonly shape: MarkerShape;
  /** The colour classes of the marker. */
  readonly colorClass: string;
}

/**
 * A marker of the legend: the same classes as on the tracks, without position or click.
 *
 * @returns The swatch.
 */
function Swatch({ shape, colorClass }: SwatchProps) {
  return <span className={`inline-block ${SHAPE_CLASS[shape]} ${colorClass}`} />;
}

/**
 * Both shapes in both team colours, for the markers whose colour is the team and whose shape is
 * the side.
 *
 * @param props - The props.
 * @param props.shapes - The two shapes (ally, enemy) the marker takes.
 * @returns The swatches.
 */
function TeamSwatches(props: { readonly shapes: readonly [MarkerShape, MarkerShape] }) {
  return (
    <>
      {props.shapes.map((shape) =>
        TEAMS.map((team) => (
          <Swatch key={`${shape}-${team}`} shape={shape} colorClass={TEAM_FILL[team]} />
        )),
      )}
    </>
  );
}

/**
 * The legend under the tracks: one entry per kind of marker that is drawn. Memoised, it only draws
 * again when the language changes.
 */
const Legend = memo(function Legend() {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('replay.legend.title')}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <LegendEntry label={t('replay.legend.objectiveDestroyed')}>
          <TeamSwatches shapes={['square', 'diamond']} />
        </LegendEntry>
        <LegendEntry label={t('replay.legend.midBossKill')}>
          {TEAMS.map((team) => (
            <Swatch key={team} shape="round" colorClass={TEAM_FILL[team]} />
          ))}
        </LegendEntry>
        <LegendEntry label={t('replay.legend.midBossReturn')}>
          <Swatch shape="hollow" colorClass={NEUTRAL_RING} />
        </LegendEntry>
        <LegendEntry label={t('replay.legend.death')}>
          <TeamSwatches shapes={['tick', 'diamond']} />
        </LegendEntry>
        <LegendEntry label={t('replay.legend.scheduleEvent')}>
          <Swatch shape="square" colorClass={NEUTRAL_FILL} />
        </LegendEntry>
        <LegendEntry label={t('replay.legend.riftWindow')}>
          <span className="inline-block h-1.5 w-5 bg-secondary" />
        </LegendEntry>
        <LegendEntry label={t('replay.legend.trooperWaves')}>
          <span className="inline-block h-1.5 w-5 bg-border" />
          <span className="inline-block h-1.5 w-5 bg-fg-muted/40" />
        </LegendEntry>
      </ul>
    </div>
  );
});

/**
 * The playback bar.
 *
 * @returns The controls, the slider, the four tracks with the cursor line across them and the
 * legend.
 */
export function PlaybackBar({ view, playback, stepTimes }: PlaybackBarProps) {
  const { t } = useTranslation();
  const { timeS, playing, speed, seek, toggle, setSpeed } = playback;
  const second = Math.floor(timeS);
  const previous = previousEvent(stepTimes, timeS);
  const next = nextEvent(stepTimes, timeS);

  return (
    <div className="space-y-2">
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

      <input
        type="range"
        min={0}
        max={view.durationS}
        step={1}
        value={second}
        aria-label={t('replay.controls.slider')}
        className="w-full accent-accent-bright"
        onChange={(event) => {
          seek(Number(event.target.value));
        }}
      />

      {/* The tracks share the scale of the slider; only the cursor line moves. */}
      <div className="relative">
        <Tracks view={view} onSeek={seek} />
        {/* An overlay over the track column only (the title column is 7 rem wide), so the cursor
            line runs across the four tracks and never over a title. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 left-28">
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
