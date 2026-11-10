/**
 * The playback bar of the map replay: the play / step / speed controls, the time slider, and the two
 * rows under the slider that put the match on the same time scale (what happened in this match, and
 * the fixed game schedule). Every marker of the rows seeks the replay to its moment.
 *
 * The rows are built once per replay and never re-render while it plays: only the cursor line that
 * runs across them moves with the clock.
 *
 * @packageDocumentation
 */
import type { TFunction } from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GAME_SCHEDULE,
  scheduleOccurrences,
  TROOPER_WAVES,
} from '../../../../core/match-map/game-schedule';
import type { ScheduleOccurrence } from '../../../../core/match-map/game-schedule';
import type { Side } from '../../../../services/match-replay-view';
import { Button } from '../../../components/Button';
import { formatGameTime } from '../analysis-format';
import { nextEvent, previousEvent } from './replay-model';
import type { ReplayData } from './replay-model';
import type { Playback, PlaybackSpeed } from './use-playback';

/** The speeds the bar offers. */
const SPEEDS: readonly PlaybackSpeed[] = [1, 4, 10];

/** Between the parts of the tooltip of a marker: "Walker · enemy · 12:34". */
const TITLE_SEPARATOR = ' · ';

/**
 * The classes of a side: the same colours as the map (your team in the accent colour, the enemy
 * team in the loss colour). The enemy is also told by its shape, never by the colour alone.
 */
const SIDE_FILL: Record<Side, string> = { ally: 'bg-accent-bright', enemy: 'bg-loss' };

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
 * Where a moment stands along the rows, as a percentage of the match.
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
  /** Which line of its row the marker stands on. */
  readonly line: 'top' | 'bottom';
  /** The classes that draw the marker. */
  readonly className: string;
  /** The shape of the marker, for the tests and the styles. */
  readonly shape: 'round' | 'diamond' | 'square' | 'hollow';
  /** Seek the replay. */
  readonly onSeek: (timeS: number) => void;
}

/**
 * One marker of a row: a small button placed at its moment.
 *
 * @returns The button.
 */
function Marker({ timeS, durationS, title, line, className, shape, onSeek }: MarkerProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-shape={shape}
      style={{ left: percentOf(timeS, durationS) }}
      className={[
        'absolute -translate-x-1/2 p-0 focus-visible:outline-2',
        line === 'top' ? 'top-0' : 'bottom-0',
        shape === 'diamond' ? 'rotate-45' : '',
        shape === 'round' ? 'rounded-full' : '',
        className,
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
  /** Which line of its row the span stands on. */
  readonly line: 'top' | 'bottom';
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
function Span({ fromS, toS, durationS, title, line, className, onSeek }: SpanProps) {
  const endS = Math.min(toS, durationS);
  const widthRatio = durationS > 0 ? Math.max(endS - fromS, 0) / durationS : 0;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      style={{ left: percentOf(fromS, durationS), width: `${String(widthRatio * 100)}%` }}
      className={['absolute h-1.5 p-0', line === 'top' ? 'top-0' : 'bottom-0', className].join(' ')}
      onClick={() => {
        onSeek(fromS);
      }}
    />
  );
}

/** Props of the two rows. */
interface RowProps {
  /** The replay. */
  readonly view: ReplayData;
  /** Seek the replay (stable between renders, so the rows stay memoised). */
  readonly onSeek: (timeS: number) => void;
}

/**
 * The row "In this match": the objectives that fell, the Mid Boss kills and returns, and the deaths
 * of every player. Memoised on the replay, so it does not draw again at every frame.
 */
const MatchRow = memo(function MatchRow({ view, onSeek }: RowProps) {
  const { t } = useTranslation();
  const { durationS } = view;
  return (
    <div className="relative h-6">
      {/* Top line: the events of the objectives and of the Mid Boss. */}
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
            line="top"
            shape={objective.side === 'enemy' ? 'diamond' : 'square'}
            className={`${SIDE_FILL[objective.side]} size-2.5`}
            onSeek={onSeek}
          />
        ),
      )}
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
          line="top"
          shape="round"
          className="size-2.5 bg-stat-weapon"
          onSeek={onSeek}
        />
      ))}
      {/* The return of the Mid Boss: a hollow marker, to tell it from the kill. */}
      {view.midBossReturnsS.map((returnS) => (
        <Marker
          key={`return-${String(returnS)}`}
          timeS={returnS}
          durationS={durationS}
          title={[t('replay.midBoss.returns'), formatGameTime(returnS)].join(TITLE_SEPARATOR)}
          line="top"
          shape="hollow"
          className="size-2.5 rounded-full border-2 border-stat-weapon"
          onSeek={onSeek}
        />
      ))}
      {/* Bottom line: every death of every player, a round tick for an ally, a diamond for an enemy. */}
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
            line="bottom"
            shape={player.side === 'enemy' ? 'diamond' : 'round'}
            className={`${SIDE_FILL[player.side]} size-2`}
            onSeek={onSeek}
          />
        )),
      )}
    </div>
  );
});

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
 * The row "Game schedule": the fixed events of a match as markers, the rift as a span and the
 * trooper waves as one span per stretch. Memoised on the replay, so it does not draw at every frame.
 */
const ScheduleRow = memo(function ScheduleRow({ view, onSeek }: RowProps) {
  const { t } = useTranslation();
  const { durationS } = view;
  return (
    <div className="relative h-6">
      {scheduleOccurrences(durationS).map((occurrence) =>
        occurrence.untilS === null ? (
          <Marker
            key={`${occurrence.kind}-${String(occurrence.timeS)}`}
            timeS={occurrence.timeS}
            durationS={durationS}
            title={scheduleTitle(occurrence, t)}
            line="top"
            shape="square"
            className="size-2 bg-fg-muted"
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
            line="top"
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
            line="bottom"
            // The stretches alternate in shade, so that two neighbours do not merge into one.
            className={index % 2 === 0 ? 'bg-border' : 'bg-fg-muted/40'}
            onSeek={onSeek}
          />
        ),
      )}
    </div>
  );
});

/**
 * The playback bar.
 *
 * @returns The controls, the slider and the two rows with the cursor line across them.
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

      {/* The two rows share the scale of the slider; the cursor line is the only thing that moves. */}
      <div className="relative space-y-1">
        <div>
          <p className="text-xs text-fg-muted">{t('replay.rows.inMatch')}</p>
          <MatchRow view={view} onSeek={seek} />
        </div>
        <div>
          <p className="text-xs text-fg-muted">{t('replay.rows.schedule')}</p>
          <ScheduleRow view={view} onSeek={seek} />
        </div>
        <div
          aria-hidden="true"
          data-testid="playback-cursor"
          style={{ left: percentOf(timeS, view.durationS) }}
          className="pointer-events-none absolute inset-y-0 w-px bg-fg"
        />
      </div>
    </div>
  );
}
